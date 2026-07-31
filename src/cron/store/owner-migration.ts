import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { materializeLegacyDefaultCronJobOwnersInRecords } from "../legacy-default-agent-owner-records.js";
import type { CronJob } from "../types.js";
import { cronStoreKey } from "./key.js";
import {
  loadedCronStoreFromRows,
  incrementCronStoreEpoch,
  loadCronRowsWithEpoch,
  materializeCronRowAgentOwners,
  readCronStoreEpoch,
  upsertCronJobRow,
} from "./row-codec.js";
import { parseJsonObject } from "./scalar-codec.js";
import { getCronStoreKysely, type CronJobRow } from "./schema.js";

type CronOwnerRowImage = Pick<CronJobRow, "agent_id" | "job_json" | "session_key">;

export type CronOwnerRollbackSnapshot = {
  storeEpoch: number;
  storeKey: string;
  storePath: string;
  importedRecordIds: ReadonlySet<string>;
  ownerlessRecordIds: ReadonlySet<string>;
  rows: ReadonlyMap<string, CronOwnerRowImage>;
};

export type PreparedCronOwnerRollback = CronOwnerRollbackSnapshot & {
  expectedStoreEpoch: number;
  changes: ReadonlyMap<
    string,
    {
      before:
        | { exists: false }
        | ({ exists: true } & Pick<CronOwnerRowImage, "agent_id" | "job_json">);
      after: CronOwnerRowImage;
    }
  >;
};

function rowOwner(row: CronOwnerRowImage): string | undefined {
  const jobJson = parseJsonObject<Record<string, unknown>>(row.job_json, {});
  const rawOwner =
    row.agent_id ??
    (typeof jobJson.agentId === "string" ? jobJson.agentId : undefined) ??
    parseAgentSessionKey(row.session_key ?? undefined)?.agentId;
  return rawOwner ? normalizeAgentId(rawOwner) : undefined;
}

/** Captures exact row before-images while the live service operation lock is held. */
export function snapshotCronOwnerRollbackState(params: {
  storePath: string;
  ownerlessRecordIds: ReadonlySet<string>;
  importedRecordIds?: ReadonlySet<string>;
  env?: NodeJS.ProcessEnv;
}): CronOwnerRollbackSnapshot {
  const storeKey = cronStoreKey(path.resolve(params.storePath));
  const { rows, storeEpoch } = loadCronRowsWithEpoch(
    openOpenClawStateDatabase({ env: params.env }).db,
    storeKey,
  );
  return {
    storeKey,
    storePath: params.storePath,
    importedRecordIds: new Set(params.importedRecordIds ?? []),
    storeEpoch,
    ownerlessRecordIds: new Set([
      ...params.ownerlessRecordIds,
      ...rows.filter((row) => rowOwner(row) === undefined).map((row) => row.job_id),
    ]),
    rows: new Map(rows.map((row) => [row.job_id, row])),
  };
}

/** Records only rows whose owner was actually introduced by this handoff. */
export function finalizeCronOwnerRollbackState(
  snapshot: CronOwnerRollbackSnapshot,
  legacyDefaultAgentId: string,
  env?: NodeJS.ProcessEnv,
  expectedStoreEpoch?: number,
): PreparedCronOwnerRollback {
  const { rows, storeEpoch } = loadCronRowsWithEpoch(
    openOpenClawStateDatabase({ env }).db,
    snapshot.storeKey,
  );
  const normalizedOwner = normalizeAgentId(legacyDefaultAgentId);
  if (expectedStoreEpoch !== undefined && storeEpoch !== expectedStoreEpoch) {
    throw new Error("cron store changed after owner materialization; refusing rollback inference");
  }
  const changes = new Map<
    string,
    {
      before:
        | { exists: false }
        | ({ exists: true } & Pick<CronOwnerRowImage, "agent_id" | "job_json">);
      after: CronOwnerRowImage;
    }
  >();
  for (const after of rows) {
    const before = snapshot.rows.get(after.job_id);
    const importedByHandoff = !before && snapshot.importedRecordIds.has(after.job_id);
    if (
      !importedByHandoff &&
      (!snapshot.ownerlessRecordIds.has(after.job_id) || rowOwner(after) !== normalizedOwner)
    ) {
      continue;
    }
    if (before && rowOwner(before) !== undefined) {
      continue;
    }
    const beforeJobJson = before
      ? before.job_json
      : (() => {
          const imported = parseJsonObject<Record<string, unknown>>(after.job_json, {});
          delete imported.agentId;
          return JSON.stringify(imported);
        })();
    if (before?.agent_id === after.agent_id && beforeJobJson === after.job_json) {
      continue;
    }
    changes.set(after.job_id, {
      before: before
        ? { exists: true, agent_id: before.agent_id, job_json: beforeJobJson }
        : { exists: false },
      after,
    });
  }
  return { ...snapshot, expectedStoreEpoch: storeEpoch, changes };
}

/** Restores exact before-images only while the prepared topology remains current. */
export async function rollbackMaterializedCronJobsStoreOwners(params: {
  rollback: PreparedCronOwnerRollback;
  restoreMetadata?: (db: DatabaseSync) => void;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const { rows, storeEpoch } = loadCronRowsWithEpoch(db, params.rollback.storeKey);
      if (storeEpoch !== params.rollback.expectedStoreEpoch) {
        throw new Error("cron store changed after owner handoff; refusing stale rollback");
      }
      const currentRows = new Map(rows.map((row) => [row.job_id, row]));
      for (const [jobId, change] of params.rollback.changes) {
        const current = currentRows.get(jobId);
        if (
          !current ||
          current.agent_id !== change.after.agent_id ||
          current.job_json !== change.after.job_json
        ) {
          throw new Error(`cron job ${jobId} changed after owner handoff; refusing stale rollback`);
        }
      }
      for (const [jobId, change] of params.rollback.changes) {
        if (!change.before.exists) {
          executeSqliteQuerySync(
            db,
            getCronStoreKysely(db)
              .deleteFrom("cron_jobs")
              .where("store_key", "=", params.rollback.storeKey)
              .where("job_id", "=", jobId),
          );
        } else {
          const { exists: _exists, ...before } = change.before;
          executeSqliteQuerySync(
            db,
            getCronStoreKysely(db)
              .updateTable("cron_jobs")
              .set(before)
              .where("store_key", "=", params.rollback.storeKey)
              .where("job_id", "=", jobId),
          );
        }
      }
      if (params.rollback.changes.size > 0) {
        incrementCronStoreEpoch(db, params.rollback.storeKey);
      }
      params.restoreMetadata?.(db);
      return params.rollback.changes.size;
    },
    { env: params.env },
  );
}

/** Materializes known rows and imports legacy-file jobs without replacing unrelated raw rows. */
export async function materializeCronJobsStoreOwners(params: {
  storePath: string;
  legacyDefaultAgentId: string;
  records: CronJob[];
  legacyImportedJobIds: ReadonlySet<string>;
  expectedStoreEpoch?: number;
  recordCommittedStoreEpoch?: (storeEpoch: number) => void;
  env?: NodeJS.ProcessEnv;
}): Promise<{ matched: boolean; rewritten: number }> {
  const storeKey = cronStoreKey(path.resolve(params.storePath));
  const result = runOpenClawStateWriteTransaction(
    ({ db }) => {
      const { rows, storeEpoch } = loadCronRowsWithEpoch(db, storeKey);
      if (params.expectedStoreEpoch !== undefined && params.expectedStoreEpoch !== storeEpoch) {
        return { matched: false, rewritten: 0 } as const;
      }
      const existingJobIds = new Set(rows.map((row) => row.job_id));
      const decodedCurrentJobIds = new Set(
        loadedCronStoreFromRows(rows).store.jobs.map((job) => job.id),
      );
      // Current decodable rows are authoritative inside the transaction. Include rows
      // inserted after the caller's snapshot, while absent rows stay deleted and raw
      // undecodable rows remain outside the targeted update.
      const persistedJobIds = decodedCurrentJobIds;
      // Both row helpers advance the partition epoch inside this outer transaction,
      // so stale full-store writers cannot overwrite ownership or imported rows.
      let rewritten = materializeCronRowAgentOwners(db, storeKey, params.legacyDefaultAgentId, {
        jobIds: persistedJobIds,
      });
      let sortOrder = rows.reduce((maximum, row) => Math.max(maximum, row.sort_order), -1) + 1;
      for (const record of params.records) {
        if (!params.legacyImportedJobIds.has(record.id)) {
          continue;
        }
        if (existingJobIds.has(record.id)) {
          if (!decodedCurrentJobIds.has(record.id)) {
            throw new Error(
              `Cannot import legacy cron job "${record.id}": an undecodable SQLite row already uses that id`,
            );
          }
          continue;
        }
        const importedRecord = structuredClone(record);
        materializeLegacyDefaultCronJobOwnersInRecords(
          [importedRecord as unknown as Record<string, unknown>],
          params.legacyDefaultAgentId,
        );
        upsertCronJobRow(db, storeKey, importedRecord, sortOrder++);
        existingJobIds.add(record.id);
        rewritten += 1;
      }
      return {
        matched: true,
        rewritten,
        storeEpoch: readCronStoreEpoch(db, storeKey),
      } as const;
    },
    { env: params.env },
  );
  if (result.matched) {
    params.recordCommittedStoreEpoch?.(result.storeEpoch);
  }
  return { matched: result.matched, rewritten: result.rewritten };
}
