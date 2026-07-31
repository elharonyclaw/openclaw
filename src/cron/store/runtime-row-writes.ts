import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { tryCronScheduleIdentity } from "../schedule-identity.js";
import type { CronJob, CronStoreFile } from "../types.js";
import { resolveCronRuntimeDelta } from "./runtime-merge.js";
import { getCronStoreKysely } from "./schema.js";
import { bindStateColumns, stateFromRow } from "./state-codec.js";

/** Applies state-only writes as per-job deltas when another process advanced the partition. */
export function writeCronRuntimeRowDeltas(params: {
  db: DatabaseSync;
  storeKey: string;
  store: CronStoreFile;
  expectedRuntimeRevision?: number;
  currentRuntimeRevision?: number;
  expectedRuntimeStateByJobId?: ReadonlyMap<string, CronJob["state"] | undefined>;
  expectedRuntimeUpdatedAtMsByJobId?: ReadonlyMap<string, number>;
  conflictError: () => Error;
  incrementRevision: () => number;
}): number {
  const revisionChanged =
    params.expectedRuntimeRevision !== undefined &&
    params.currentRuntimeRevision !== undefined &&
    params.expectedRuntimeRevision !== params.currentRuntimeRevision;
  const currentStates = revisionChanged
    ? new Map(
        executeSqliteQuerySync(
          params.db,
          getCronStoreKysely(params.db)
            .selectFrom("cron_jobs")
            .selectAll()
            .where("store_key", "=", params.storeKey),
        ).rows.map((row) => [
          row.job_id,
          {
            state: stateFromRow(row),
            updatedAtMs: row.runtime_updated_at_ms ?? row.updated_at,
          },
        ]),
      )
    : undefined;
  // Resolve against a detached store: SQLite may roll back after any row update,
  // and the caller publishes the committed snapshot only after the transaction returns.
  const mergedStore = structuredClone(params.store);
  for (const job of mergedStore.jobs) {
    if (revisionChanged) {
      const current = currentStates?.get(job.id);
      const hasExpectedState = params.expectedRuntimeStateByJobId?.has(job.id) === true;
      const hasExpectedUpdatedAtMs = params.expectedRuntimeUpdatedAtMsByJobId?.has(job.id) === true;
      if (!current || !hasExpectedState || !hasExpectedUpdatedAtMs) {
        throw params.conflictError();
      }
      const expected = params.expectedRuntimeStateByJobId?.get(job.id) ?? {};
      const resolution = resolveCronRuntimeDelta({
        current: current.state,
        next: job.state ?? {},
        expected,
        currentUpdatedAtMs: current.updatedAtMs,
        nextUpdatedAtMs: job.updatedAtMs,
        expectedUpdatedAtMs: params.expectedRuntimeUpdatedAtMsByJobId!.get(job.id)!,
      });
      if (resolution === "conflict") {
        throw params.conflictError();
      }
      if (resolution === "preserve") {
        job.state = structuredClone(current.state);
        if (typeof current.updatedAtMs === "number") {
          job.updatedAtMs = current.updatedAtMs;
        }
        continue;
      }
    }
  }
  // Resolve every job before the first row write. Direct callers therefore cannot
  // persist an early delta when a later job proves the snapshot is conflicting.
  for (const job of mergedStore.jobs) {
    executeSqliteQuerySync(
      params.db,
      getCronStoreKysely(params.db)
        .updateTable("cron_jobs")
        .set({
          ...bindStateColumns(job.state ?? {}),
          state_json: JSON.stringify(job.state ?? {}),
          runtime_updated_at_ms: job.updatedAtMs,
          schedule_identity:
            tryCronScheduleIdentity(job as unknown as Record<string, unknown>) ?? null,
        })
        .where("store_key", "=", params.storeKey)
        .where("job_id", "=", job.id),
    );
  }
  return params.incrementRevision();
}
