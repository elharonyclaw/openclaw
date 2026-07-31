import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import {
  excludeComposerAttachments,
  removeVisibleOrScopedQueuedMessageWithoutReleasing,
} from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  chatComposerCommandClearResult,
  chatComposerCommandRecoveryScope,
  chatComposerFallbackMatchesCommandClear,
  nextChatComposerMemoryFallbackSequence,
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
  connectionEpoch: ChatHost["connectionEpoch"];
  draft: string;
  persistenceRecovery: ChatComposerCommandRecovery | null;
  scope: StoredChatOutboxScope;
};

export type ChatCommandComposerRecoveryResult = {
  attachmentsRetained: boolean;
  restored: boolean;
};

export function beginChatCommandComposerRecovery(
  host: ChatHost,
  snapshot: {
    attachments?: ChatAttachment[];
    draft: string;
  },
): ChatCommandComposerRecovery {
  const persistenceRecovery = host.chatComposerRecovery?.beginCommandRecovery() ?? null;
  return {
    attachments: snapshot.attachments ?? [],
    client: host.client,
    connectionEpoch: host.connectionEpoch,
    draft: snapshot.draft,
    persistenceRecovery,
    scope:
      (persistenceRecovery && chatComposerCommandRecoveryScope(persistenceRecovery)) ??
      resolveStoredChatOutboxScope(host, host.sessionKey),
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
  const scopeKey = storedChatOutboxScopeKey(recovery.scope);
  const fallbacks = pageHost.chatComposerFallbackByScope ?? {};
  const existingFallback = fallbacks[scopeKey];
  const existingMatchesSubmitted =
    existingFallback?.message === recovery.draft &&
    chatAttachmentIdsMatch(existingFallback.attachments, recovery.attachments);
  if (existingFallback && !existingMatchesSubmitted) {
    return;
  }
  const cleared =
    recovery.persistenceRecovery && chatComposerCommandClearResult(recovery.persistenceRecovery);
  if (!cleared || cleared.status === "conflict") {
    return;
  }
  const retainedAttachments = recovery.attachmentsCleared ? [] : recovery.attachments;
  const retainFallback = retainedAttachments.length > 0 || cleared.status === "storage-failed";
  const nextFallbacks = { ...fallbacks };
  if (retainFallback) {
    nextFallbacks[scopeKey] = {
      message: "",
      attachments: [...retainedAttachments],
      storageFailed: cleared.status === "storage-failed",
      sequence: nextChatComposerMemoryFallbackSequence(),
      ...(cleared.status === "storage-failed"
        ? {
            draftRetry: {
              expectedDraftRevision: cleared.expectedDraftRevision,
              draftRevision: cleared.draftRevision,
            },
          }
        : {}),
    };
  } else if (existingFallback) {
    delete nextFallbacks[scopeKey];
  }
  pageHost.chatComposerFallbackByScope = nextFallbacks;
}

export function restoreChatCommandComposer(
  host: ChatHost,
  recovery: ChatCommandComposerRecovery,
): ChatCommandComposerRecoveryResult {
  if (host.client !== recovery.client || host.connectionEpoch !== recovery.connectionEpoch) {
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
    (recovery.persistenceRecovery !== null ||
      host.chatAttachments === recovery.clearedAttachments);
  if (visible && !ownsVisibleClear) {
    return { attachmentsRetained: false, restored: false };
  }
  const pageHost = host as ChatPageHost;
  const scopeKey = storedChatOutboxScopeKey(recovery.scope);
  const fallbacks = pageHost.chatComposerFallbackByScope ?? {};
  const existingFallback = fallbacks[scopeKey];
  const existingFallbackMatchesClear =
    existingFallback?.message === "" &&
    chatAttachmentIdsMatch(
      existingFallback.attachments,
      recovery.attachmentsCleared ? [] : recovery.attachments,
    ) &&
    (existingFallback.storageFailed
      ? Boolean(
          recovery.persistenceRecovery &&
          chatComposerFallbackMatchesCommandClear(recovery.persistenceRecovery, existingFallback),
        )
      : true);
  if (existingFallback && !existingFallbackMatchesClear) {
    return { attachmentsRetained: false, restored: false };
  }
  const persisted =
    recovery.persistenceRecovery &&
    host.chatComposerRecovery?.restoreCommandDraft(recovery.persistenceRecovery);
  if (!persisted || persisted.status === "conflict") {
    // Unit-level hosts without the production persistence owner retain the
    // existing visible-session behavior, but hidden recovery must fail closed.
    if (!ownsVisibleClear || recovery.persistenceRecovery) {
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
  if (ownsVisibleClear) {
    host.chatMessage = recovery.draft;
    if (recovery.attachments.length > 0) {
      host.chatAttachments = recovery.attachments;
    }
    const persistenceRecovery = recovery.persistenceRecovery;
    if (persistenceRecovery) {
      host.chatComposerRecovery?.adoptCommandRecovery(persistenceRecovery);
    }
  }
  const retainFallback = recovery.attachments.length > 0 || persisted.status === "storage-failed";
  const nextFallbacks = { ...fallbacks };
  if (retainFallback) {
    nextFallbacks[scopeKey] = {
      message: recovery.draft,
      attachments: [...recovery.attachments],
      storageFailed: persisted.status === "storage-failed",
      sequence: nextChatComposerMemoryFallbackSequence(),
      ...(persisted.status === "storage-failed"
        ? {
            draftRetry: {
              expectedDraftRevision: persisted.expectedDraftRevision,
              draftRevision: persisted.draftRevision,
            },
          }
        : {}),
    };
  } else if (existingFallback) {
    delete nextFallbacks[scopeKey];
  }
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
