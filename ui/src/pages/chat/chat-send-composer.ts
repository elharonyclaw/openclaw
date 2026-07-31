import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import {
  excludeComposerAttachments,
  removeVisibleOrScopedQueuedMessageWithoutReleasing,
} from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatComposerMemoryFallback } from "./composer-fallback.ts";
import {
  chatComposerCommandClearResult,
  chatComposerCommandRecoveryScope,
  nextChatComposerMemoryFallbackSequence,
  resolveChatComposerFallbackCommandRun,
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
  type ChatComposerCommandRecovery,
  type StoredChatOutboxScope,
} from "./composer-persistence.ts";

export type ChatCommandComposerRecovery = {
  attachments: ChatAttachment[];
  attachmentsCleared?: boolean;
  clearedAttachments?: ChatAttachment[];
  client: ChatHost["client"];
  clearFallbackSequence?: number;
  connectionEpoch: ChatHost["connectionEpoch"];
  draft: string;
  persistenceRecovery: ChatComposerCommandRecovery | null;
  retryRunId?: string;
  retryRunIdExpiresAtMs?: number;
  retryRunScopeKey?: string;
  scope: StoredChatOutboxScope;
  submittedAtMs: number;
  submittedFallbackSequence?: number;
};

type ChatCommandComposerRecoveryResult = {
  attachmentsRetained: boolean;
  restored: boolean;
};

// Gateway terminal chat dedupe expires after five minutes. Active runs remain
// protected longer, but a terminal retry ID must not be presented as durable.
const CHAT_COMMAND_RETRY_RUN_ID_TTL_MS = 5 * 60_000;

function matchingChatCommandComposerFallback(
  host: ChatHost,
  snapshot: {
    attachments?: ChatAttachment[];
    draft: string;
  },
  scope: StoredChatOutboxScope,
) {
  const { fallback, scopeKey } = resolveChatComposerMemoryFallback(
    host as ChatPageHost,
    scope.sessionKey,
  );
  const attachments = snapshot.attachments ?? [];
  return fallback?.message === snapshot.draft &&
    chatAttachmentIdsMatch(fallback.attachments, attachments)
    ? { fallback, scopeKey }
    : undefined;
}

export function chatCommandComposerRetryState(
  host: ChatHost,
  snapshot: {
    attachments?: ChatAttachment[];
    draft: string;
  },
  scope = resolveStoredChatOutboxScope(host, host.sessionKey),
): { runId?: string } | null {
  const fallbackMatch = matchingChatCommandComposerFallback(host, snapshot, scope);
  if (!fallbackMatch) {
    return null;
  }
  const commandRun = resolveChatComposerFallbackCommandRun(
    fallbackMatch.fallback,
    fallbackMatch.scopeKey,
  );
  return commandRun ? { runId: commandRun.id } : {};
}

export function beginChatCommandComposerRecovery(
  host: ChatHost,
  snapshot: {
    attachments?: ChatAttachment[];
    draft: string;
  },
): ChatCommandComposerRecovery {
  const persistenceRecovery = host.chatComposerRecovery?.beginCommandRecovery() ?? null;
  const scope =
    (persistenceRecovery && chatComposerCommandRecoveryScope(persistenceRecovery)) ??
    resolveStoredChatOutboxScope(host, host.sessionKey);
  const attachments = snapshot.attachments ?? [];
  const fallbackMatch = matchingChatCommandComposerFallback(host, snapshot, scope);
  const retryRun = fallbackMatch
    ? resolveChatComposerFallbackCommandRun(fallbackMatch.fallback, fallbackMatch.scopeKey)
    : undefined;
  return {
    attachments,
    client: host.client,
    connectionEpoch: host.connectionEpoch,
    draft: snapshot.draft,
    persistenceRecovery,
    ...(retryRun
      ? {
          retryRunId: retryRun.id,
          retryRunIdExpiresAtMs: retryRun.expiresAtMs,
          retryRunScopeKey: retryRun.scopeKey,
        }
      : {}),
    scope,
    submittedAtMs: Date.now(),
    ...(fallbackMatch ? { submittedFallbackSequence: fallbackMatch.fallback.sequence } : {}),
  };
}

function chatAttachmentIdsMatch(
  left: readonly ChatAttachment[],
  right: readonly ChatAttachment[],
): boolean {
  return (
    left.length === right.length &&
    left.every((attachment, index) => attachment.id === right[index]?.id)
  );
}

function findChatCommandComposerFallbackBySequence(
  host: ChatHost,
  sequence: number | undefined,
): {
  fallback: NonNullable<ChatPageHost["chatComposerFallbackByScope"][string]>;
  scopeKey: string;
} | null {
  if (sequence === undefined) {
    return null;
  }
  for (const [scopeKey, fallback] of Object.entries(
    (host as ChatPageHost).chatComposerFallbackByScope ?? {},
  )) {
    if (fallback.sequence === sequence) {
      return { fallback, scopeKey };
    }
  }
  return null;
}

function discardChatCommandComposerClearFallback(
  host: ChatHost,
  recovery: ChatCommandComposerRecovery,
): void {
  const owned = findChatCommandComposerFallbackBySequence(host, recovery.clearFallbackSequence);
  recovery.clearFallbackSequence = undefined;
  if (!owned) {
    return;
  }
  const pageHost = host as ChatPageHost;
  const nextFallbacks = { ...pageHost.chatComposerFallbackByScope };
  delete nextFallbacks[owned.scopeKey];
  pageHost.chatComposerFallbackByScope = nextFallbacks;
}

export function checkpointChatCommandComposerClear(
  host: ChatHost,
  recovery: ChatCommandComposerRecovery,
): void {
  recovery.clearedAttachments = host.chatAttachments;
  recovery.attachmentsCleared =
    recovery.attachments.length > 0 &&
    !chatAttachmentIdsMatch(host.chatAttachments, recovery.attachments);
  if (recovery.persistenceRecovery) {
    host.chatComposerRecovery?.checkpointCommandClear(recovery.persistenceRecovery);
  }
  const pageHost = host as ChatPageHost;
  const fallbacks = pageHost.chatComposerFallbackByScope ?? {};
  const submittedFallback = findChatCommandComposerFallbackBySequence(
    host,
    recovery.submittedFallbackSequence,
  );
  const scopeKey = submittedFallback?.scopeKey ?? storedChatOutboxScopeKey(recovery.scope);
  const cleared =
    recovery.persistenceRecovery && chatComposerCommandClearResult(recovery.persistenceRecovery);
  const retainedAttachments = recovery.attachmentsCleared ? [] : recovery.attachments;
  if (!cleared || cleared.status === "conflict") {
    if (!submittedFallback) {
      return;
    }
    const sequence = nextChatComposerMemoryFallbackSequence();
    recovery.clearFallbackSequence = sequence;
    pageHost.chatComposerFallbackByScope = {
      ...fallbacks,
      [scopeKey]: {
        ...submittedFallback.fallback,
        message: "",
        attachments: [...retainedAttachments],
        sequence,
      },
    };
    return;
  }
  const retainFallback = retainedAttachments.length > 0 || cleared.status === "storage-failed";
  const nextFallbacks = { ...fallbacks };
  if (retainFallback) {
    const sequence = nextChatComposerMemoryFallbackSequence();
    recovery.clearFallbackSequence = sequence;
    nextFallbacks[scopeKey] = {
      message: "",
      attachments: [...retainedAttachments],
      storageFailed: cleared.status === "storage-failed",
      sequence,
      ...(cleared.status === "storage-failed"
        ? {
            draftRetry: {
              expectedDraftRevision: cleared.expectedDraftRevision,
              draftRevision: cleared.draftRevision,
            },
          }
        : {}),
    };
  } else if (submittedFallback) {
    delete nextFallbacks[scopeKey];
  }
  pageHost.chatComposerFallbackByScope = nextFallbacks;
}

export function completeChatCommandComposerSend(
  host: ChatHost,
  recovery: ChatCommandComposerRecovery,
): void {
  const visible = visibleSessionMatches(host, recovery.scope.sessionKey, recovery.scope.agentId);
  const visibleAttachmentsMatch = recovery.attachmentsCleared
    ? host.chatAttachments.length === 0
    : chatAttachmentIdsMatch(host.chatAttachments, recovery.attachments);
  if (
    visible &&
    host.chatMessage === "" &&
    visibleAttachmentsMatch &&
    recovery.persistenceRecovery
  ) {
    host.chatComposerRecovery?.completeCommandClear(recovery.persistenceRecovery);
  }
  discardChatCommandComposerClearFallback(host, recovery);
}

export function restoreChatCommandComposer(
  host: ChatHost,
  recovery: ChatCommandComposerRecovery,
  options: { retryRunId?: string } = {},
): ChatCommandComposerRecoveryResult {
  if (host.client !== recovery.client || host.connectionEpoch !== recovery.connectionEpoch) {
    discardChatCommandComposerClearFallback(host, recovery);
    return { attachmentsRetained: false, restored: false };
  }
  const visible = visibleSessionMatches(host, recovery.scope.sessionKey, recovery.scope.agentId);
  const visibleAttachmentsMatch = recovery.attachmentsCleared
    ? host.chatAttachments.length === 0
    : chatAttachmentIdsMatch(host.chatAttachments, recovery.attachments);
  const ownsVisibleClear =
    visible &&
    host.chatMessage === "" &&
    visibleAttachmentsMatch &&
    (recovery.persistenceRecovery !== null || host.chatAttachments === recovery.clearedAttachments);
  if (visible && !ownsVisibleClear) {
    discardChatCommandComposerClearFallback(host, recovery);
    return { attachmentsRetained: false, restored: false };
  }
  const pageHost = host as ChatPageHost;
  const fallbacks = pageHost.chatComposerFallbackByScope ?? {};
  const ownedClearFallback = findChatCommandComposerFallbackBySequence(
    host,
    recovery.clearFallbackSequence,
  );
  const scopeKey = ownedClearFallback?.scopeKey ?? storedChatOutboxScopeKey(recovery.scope);
  const existingFallback = ownedClearFallback?.fallback ?? fallbacks[scopeKey];
  const existingFallbackMatchesClear =
    ownedClearFallback !== null &&
    existingFallback?.message === "" &&
    chatAttachmentIdsMatch(
      existingFallback.attachments,
      recovery.attachmentsCleared ? [] : recovery.attachments,
    );
  if (
    (recovery.clearFallbackSequence !== undefined && !existingFallbackMatchesClear) ||
    (recovery.clearFallbackSequence === undefined && existingFallback)
  ) {
    return { attachmentsRetained: false, restored: false };
  }
  const persisted =
    recovery.persistenceRecovery &&
    host.chatComposerRecovery?.restoreCommandDraft(recovery.persistenceRecovery);
  if (!persisted) {
    // Unit-level hosts without the production persistence owner retain the
    // existing visible-session behavior, but hidden recovery must fail closed.
    if (!ownsVisibleClear) {
      return { attachmentsRetained: false, restored: false };
    }
    host.chatMessage = recovery.draft;
    if (recovery.attachments.length > 0) {
      host.chatAttachments = recovery.attachments;
    }
    return {
      attachmentsRetained:
        recovery.attachments.length === 0 || host.chatAttachments === recovery.attachments,
      restored: true,
    };
  }
  const locallyOwnedConflict =
    persisted.status === "conflict" &&
    persisted.reason === "local" &&
    recovery.submittedFallbackSequence !== undefined &&
    existingFallbackMatchesClear;
  if (persisted.status === "conflict" && persisted.reason === "local" && !locallyOwnedConflict) {
    discardChatCommandComposerClearFallback(host, recovery);
    return { attachmentsRetained: false, restored: false };
  }
  if (ownsVisibleClear) {
    host.chatMessage = recovery.draft;
    if (recovery.attachments.length > 0) {
      host.chatAttachments = recovery.attachments;
    }
    const persistenceRecovery = recovery.persistenceRecovery;
    if (persistenceRecovery && !locallyOwnedConflict) {
      host.chatComposerRecovery?.adoptCommandRecovery(persistenceRecovery);
    }
  }
  const retainFallback =
    persisted.status === "conflict" ||
    recovery.attachments.length > 0 ||
    persisted.status === "storage-failed" ||
    options.retryRunId !== undefined ||
    recovery.retryRunId !== undefined;
  const retryRunId = options.retryRunId ?? recovery.retryRunId;
  const retryRunIdExpiresAtMs = options.retryRunId
    ? recovery.submittedAtMs + CHAT_COMMAND_RETRY_RUN_ID_TTL_MS
    : recovery.retryRunIdExpiresAtMs;
  const retryRunScopeKey = options.retryRunId ? scopeKey : recovery.retryRunScopeKey;
  const storageFailed =
    persisted.status === "storage-failed" ||
    (locallyOwnedConflict ? (existingFallback?.storageFailed ?? false) : false);
  const draftRetry =
    persisted.status === "storage-failed"
      ? {
          expectedDraftRevision: persisted.expectedDraftRevision,
          draftRevision: persisted.draftRevision,
        }
      : locallyOwnedConflict
        ? existingFallback?.draftRetry
        : undefined;
  const nextFallbacks = { ...fallbacks };
  if (retainFallback) {
    nextFallbacks[scopeKey] = {
      message: recovery.draft,
      attachments: [...recovery.attachments],
      ...(retryRunId && retryRunIdExpiresAtMs && retryRunScopeKey
        ? {
            commandRunId: retryRunId,
            commandRunIdExpiresAtMs: retryRunIdExpiresAtMs,
            commandRunScopeKey: retryRunScopeKey,
          }
        : {}),
      storageFailed,
      sequence: nextChatComposerMemoryFallbackSequence(),
      ...(draftRetry ? { draftRetry } : {}),
    };
  } else if (existingFallback) {
    delete nextFallbacks[scopeKey];
  }
  recovery.clearFallbackSequence = undefined;
  pageHost.chatComposerFallbackByScope = nextFallbacks;
  return {
    attachmentsRetained:
      recovery.attachments.length === 0 ||
      ownsVisibleClear ||
      nextFallbacks[scopeKey]?.attachments.length === recovery.attachments.length,
    restored: true,
  };
}

export function restoreComposerAfterFailedSend(
  host: ChatHost,
  opts: {
    previousAttachments?: ChatAttachment[];
    previousDraft?: string;
  },
) {
  if (opts.previousDraft != null && !host.chatMessage.trim()) {
    host.chatMessage = opts.previousDraft;
  }
  if (opts.previousAttachments?.length && host.chatAttachments.length === 0) {
    host.chatAttachments = opts.previousAttachments;
  }
}

type PendingComposerSnapshot = {
  previousAttachments?: ChatAttachment[];
  previousDraft?: string;
};

export function pendingComposerRestorePlan(host: ChatHost, snapshot: PendingComposerSnapshot) {
  const willRestoreDraft = snapshot.previousDraft != null && !host.chatMessage.trim();
  const willRestoreAttachments = Boolean(
    snapshot.previousAttachments?.length &&
    host.chatAttachments.length === 0 &&
    (willRestoreDraft || !host.chatMessage.trim()),
  );
  return {
    complete:
      (!snapshot.previousDraft?.trim() || willRestoreDraft) &&
      (!snapshot.previousAttachments?.length || willRestoreAttachments),
    willRestoreAttachments,
    willRestoreDraft,
  };
}

export function cancelPendingSendBeforeRequest(
  host: ChatHost,
  queued: ChatQueueItem,
  opts: PendingComposerSnapshot & {
    restoreComposer?: boolean;
  },
) {
  const removed = removeVisibleOrScopedQueuedMessageWithoutReleasing(
    host,
    queued.id,
    queued.sessionKey,
  );
  const restoreComposer = opts.restoreComposer !== false && removed != null;
  const restorePlan = pendingComposerRestorePlan(host, opts);
  const willRestoreDraft = restoreComposer && restorePlan.willRestoreDraft;
  const willRestoreAttachments = restoreComposer && restorePlan.willRestoreAttachments;
  if (restoreComposer) {
    if (willRestoreDraft) {
      host.chatMessage = opts.previousDraft ?? "";
    }
    if (willRestoreAttachments) {
      host.chatAttachments = opts.previousAttachments ?? [];
    }
  }
  if (removed && !willRestoreAttachments) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, removed.attachments));
  }
}
