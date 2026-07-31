import {
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
  type ChatComposerScope,
} from "../../lib/chat/outbox-store.ts";
import {
  DEFAULT_MAIN_KEY,
  buildAgentMainSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
  resolveUiKnownSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import {
  loadChatComposerCommittedDraftRevision,
  loadChatComposerDraftRevision,
  resolveChatComposerFallbackCommandRun,
  type ChatComposerMemoryFallback,
} from "./composer-persistence.ts";

function withoutChatComposerCommandRun(
  fallback: ChatComposerMemoryFallback,
): ChatComposerMemoryFallback {
  const {
    commandRunId: _commandRunId,
    commandRunIdExpiresAtMs: _commandRunIdExpiresAtMs,
    commandRunScopeKey: _commandRunScopeKey,
    ...rest
  } = fallback;
  return rest;
}

export function resolveChatComposerMemoryFallback(
  state: ChatComposerScope & {
    chatComposerFallbackByScope: Record<string, ChatComposerMemoryFallback>;
  },
  sessionKey: string,
): { fallback?: ChatComposerMemoryFallback; scopeKey: string } {
  const scope = resolveStoredChatOutboxScope(state, sessionKey);
  const scopeKey = storedChatOutboxScopeKey(scope);
  const fallback = state.chatComposerFallbackByScope[scopeKey];
  const selectedGlobalAgentId = resolveUiKnownSelectedGlobalAgentId(state);
  if (scope.sessionKey !== "global" || !scope.agentId) {
    return { fallback, scopeKey };
  }
  const configuredMainKey = resolveUiConfiguredMainKey(state);
  const isSelectedTarget = scope.agentId === selectedGlobalAgentId;
  const isDefaultTarget = scope.agentId === resolveUiDefaultAgentId(state);
  const qualifiedMainScopeKey =
    configuredMainKey === DEFAULT_MAIN_KEY
      ? undefined
      : storedChatOutboxScopeKey({
          sessionKey: buildAgentMainSessionKey({
            agentId: scope.agentId,
            mainKey: configuredMainKey,
          }),
          agentId: scope.agentId,
        });
  if (!isSelectedTarget && !isDefaultTarget && !qualifiedMainScopeKey) {
    return { fallback, scopeKey };
  }
  const fallbackSourceKeys = new Set([scopeKey]);
  if (isSelectedTarget) {
    fallbackSourceKeys.add(storedChatOutboxScopeKey({ sessionKey: "global" }));
  }
  if (isDefaultTarget) {
    fallbackSourceKeys.add(storedChatOutboxScopeKey({ sessionKey: DEFAULT_MAIN_KEY }));
    fallbackSourceKeys.add(storedChatOutboxScopeKey({ sessionKey: configuredMainKey }));
  }
  if (qualifiedMainScopeKey) {
    fallbackSourceKeys.add(qualifiedMainScopeKey);
  }
  const candidates = [...fallbackSourceKeys]
    .map((candidateScopeKey) => ({
      fallback: state.chatComposerFallbackByScope[candidateScopeKey],
      scopeKey: candidateScopeKey,
    }))
    .filter(
      (candidate): candidate is { fallback: ChatComposerMemoryFallback; scopeKey: string } =>
        candidate.fallback !== undefined,
    );
  const newest = candidates.toSorted(
    (left, right) => right.fallback.sequence - left.fallback.sequence,
  )[0];
  if (!newest) {
    return { scopeKey };
  }
  const sourceKey = newest.scopeKey;
  const sourceFallback = newest.fallback;
  const sourceCommandRun = resolveChatComposerFallbackCommandRun(sourceFallback, sourceKey);
  let adoptedFallback =
    sourceCommandRun && sourceKey === scopeKey
      ? sourceFallback
      : withoutChatComposerCommandRun(sourceFallback);
  if (candidates.length === 1 && sourceKey === scopeKey) {
    if (adoptedFallback !== sourceFallback) {
      state.chatComposerFallbackByScope = {
        ...state.chatComposerFallbackByScope,
        [scopeKey]: adoptedFallback,
      };
    }
    return { fallback: adoptedFallback, scopeKey };
  }
  if (sourceKey !== scopeKey && sourceFallback.draftRetry) {
    const committedRevision = loadChatComposerCommittedDraftRevision(
      state,
      sessionKey,
      scope.agentId,
    );
    const latestRevision = loadChatComposerDraftRevision(state, sessionKey, scope.agentId);
    // Rebase only when this unresolved edit is newer than every resolved
    // attempt. Otherwise its original CAS must keep newer pane input intact.
    if (sourceFallback.draftRetry.draftRevision > latestRevision) {
      adoptedFallback = {
        ...sourceFallback,
        draftRetry: {
          ...sourceFallback.draftRetry,
          expectedDraftRevision: committedRevision,
        },
      };
    }
  }
  const nextFallbacks = { ...state.chatComposerFallbackByScope };
  for (const candidate of candidates) {
    delete nextFallbacks[candidate.scopeKey];
  }
  nextFallbacks[scopeKey] = adoptedFallback;
  state.chatComposerFallbackByScope = nextFallbacks;
  return { fallback: adoptedFallback, scopeKey };
}
