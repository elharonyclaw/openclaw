/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-command-recovery-lifecycle.test/"} */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { chatCommandComposerRetryState } from "./chat-send.ts";
import { createPageState } from "./chat-state-page.ts";
import { loadChatComposerSnapshot } from "./composer-persistence.ts";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("chat pane command recovery lifecycle", () => {
  it("restores a late failed command only after returning to its submitted session", async () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const sends = [
      createDeferred<unknown>(),
      createDeferred<unknown>(),
      createDeferred<unknown>(),
      createDeferred<unknown>(),
    ];
    let sendIndex = 0;
    const request = vi.fn((method: string, _params?: unknown) => {
      if (method === "chat.send") {
        return sends[sendIndex++]!.promise;
      }
      if (method === "chat.history") {
        return Promise.resolve({ messages: [] });
      }
      if (method === "sessions.list") {
        return Promise.resolve({ count: 0, sessions: [] });
      }
      if (method === "taskSuggestions.list") {
        return Promise.resolve({ suggestions: [] });
      }
      if (method === "session.suggestions.list") {
        return Promise.resolve({ role: "owner", suggestions: [] });
      }
      return Promise.resolve({});
    });
    const chatSendPayloads = () =>
      request.mock.calls.flatMap(([method, params]) => (method === "chat.send" ? [params] : []));
    const client = { request } as unknown as GatewayBrowserClient;
    const sessions = {
      reconcileRunTerminal: vi.fn(() => false),
    } as unknown as SessionCapability;
    const { pane } = createTestChatPane({ client, sessions });
    const state = createPageState(
      pane.context,
      pane.chatState.createRenderLifecycle(),
      pane,
      new Map(),
    );
    const { pane: peerPane } = createTestChatPane({ client, sessions });
    const peerState = createPageState(
      peerPane.context,
      peerPane.chatState.createRenderLifecycle(),
      peerPane,
      new Map(),
    );
    const submittedAttachment = {
      id: "submitted-attachment",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,AAA",
    };
    const selectedAttachment = {
      id: "selected-attachment",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,BBB",
    };
    const resubmittedAttachment = {
      id: "resubmitted-attachment",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,CCC",
    };
    state.sessionKey = "global";
    state.assistantAgentId = null;
    state.agentsList = null;
    state.client = client;
    state.connected = true;
    state.connectionEpoch = 4;
    state.chatRunId = "active-run";
    state.chatStream = "Waiting for approval";
    state.loadAssistantIdentity = vi.fn(async () => undefined);
    pane.state = state;
    pane.sessionKey = state.sessionKey;
    pane.chatState.attach(state);
    pane.chatState.startComposerPersistence();
    peerState.sessionKey = "global";
    peerState.assistantAgentId = null;
    peerState.agentsList = null;
    peerState.client = client;
    peerState.connected = true;
    peerState.connectionEpoch = 4;
    peerState.loadAssistantIdentity = vi.fn(async () => undefined);
    peerPane.state = peerState;
    peerPane.sessionKey = peerState.sessionKey;
    peerPane.chatState.attach(peerState);
    peerPane.chatState.startComposerPersistence();

    try {
      state.handleChatDraftChange("/approve approval-123 allow-once");
      pane.chatState.updateComposerAttachments([submittedAttachment]);
      const send = state.handleSendChat();
      await vi.waitFor(() =>
        expect(request.mock.calls.some(([method]) => method === "chat.send")).toBe(true),
      );
      const firstRunId = (chatSendPayloads()[0] as { idempotencyKey?: unknown } | undefined)
        ?.idempotencyKey;
      expect(firstRunId).toEqual(expect.any(String));

      pane.switchPaneSession("agent:main:second");
      state.handleChatDraftChange("second-session draft");
      pane.chatState.updateComposerAttachments([selectedAttachment]);
      state.lastError = "second-session error";
      state.chatError = "second-session error";

      peerState.handleChatDraftChange("newer split-pane draft");
      peerPane.switchPaneSession("agent:main:peer");

      sends[0]!.reject(new Error("connection closed before the response"));
      await send;

      expect(state.sessionKey).toBe("agent:main:second");
      expect(state.chatMessage).toBe("second-session draft");
      expect(state.chatAttachments).toEqual([selectedAttachment]);
      expect(state.lastError).toBe("second-session error");
      expect(state.chatError).toBe("second-session error");

      state.assistantAgentId = "main";
      state.agentsList = {
        defaultId: "main",
        mainKey: "main",
        scope: "global",
        agents: [],
      };
      pane.switchPaneSession("global");
      expect(state.chatMessage).toBe("/approve approval-123 allow-once");
      expect(state.chatAttachments).toEqual([submittedAttachment]);
      expect(loadChatComposerSnapshot(state, "global", "main")?.draft).toBe(
        "newer split-pane draft",
      );
      expect(Object.values(state.chatComposerFallbackByScope)).not.toContainEqual(
        expect.objectContaining({ commandRunId: firstRunId }),
      );

      const retry = state.handleSendChat();
      await vi.waitFor(() => expect(chatSendPayloads()).toHaveLength(2));
      const retryRunId = (chatSendPayloads()[1] as { idempotencyKey?: unknown } | undefined)
        ?.idempotencyKey;
      expect(retryRunId).not.toBe(firstRunId);
      sends[1]!.resolve({ runId: retryRunId, status: "started" });
      await retry;
      expect(state.chatMessage).toBe("");
      expect(state.chatAttachments).toEqual([]);
      expect(Object.values(state.chatComposerFallbackByScope)).not.toContainEqual(
        expect.objectContaining({ commandRunId: firstRunId }),
      );
      expect(Object.values(state.chatComposerFallbackByScope)).not.toContainEqual(
        expect.objectContaining({ message: "/approve approval-123 allow-once" }),
      );
      pane.switchPaneSession("agent:main:second");
      expect(loadChatComposerSnapshot(state, "global", "main")?.draft).toBe(
        "newer split-pane draft",
      );
      pane.switchPaneSession("global");

      state.chatRunId = "active-run";
      state.chatStream = "Waiting for approval";
      state.handleChatDraftChange("/approve approval-456 allow-once");
      pane.chatState.updateComposerAttachments([resubmittedAttachment]);
      const resubmit = state.handleSendChat();
      await vi.waitFor(() => expect(chatSendPayloads()).toHaveLength(3));
      const resubmittedRunId = (chatSendPayloads()[2] as { idempotencyKey?: unknown } | undefined)
        ?.idempotencyKey;
      expect(resubmittedRunId).not.toBe(firstRunId);
      sends[2]!.reject(new Error("connection closed before the response"));
      await resubmit;
      expect(state.chatMessage).toBe("/approve approval-456 allow-once");
      expect(state.chatAttachments).toEqual([resubmittedAttachment]);
      const expiredFallback = Object.values(state.chatComposerFallbackByScope).find(
        (fallback) => fallback.commandRunId === resubmittedRunId,
      );
      expect(expiredFallback).toBeDefined();
      expect(
        chatCommandComposerRetryState(state, {
          attachments: [resubmittedAttachment],
          draft: "/approve approval-456 allow-once",
        })?.runId,
      ).toBe(resubmittedRunId);
      expiredFallback!.commandRunIdExpiresAtMs = Date.now() - 1;
      expect(
        chatCommandComposerRetryState(state, {
          attachments: [resubmittedAttachment],
          draft: "/approve approval-456 allow-once",
        })?.runId,
      ).toBeUndefined();

      const staleSend = state.handleSendChat();
      await vi.waitFor(() => expect(chatSendPayloads()).toHaveLength(4));
      const staleRunId = (chatSendPayloads()[3] as { idempotencyKey?: unknown } | undefined)
        ?.idempotencyKey;
      expect(staleRunId).not.toBe(resubmittedRunId);
      const replacementClient = {
        request: vi.fn(() => Promise.resolve({})),
      } as unknown as GatewayBrowserClient;
      pane.connectedClient = replacementClient;
      pane.connectionGeneration += 1;
      state.client = replacementClient;
      state.connectionEpoch = pane.connectionGeneration;
      state.handleChatDraftChange("replacement connection draft");
      pane.chatState.updateComposerAttachments([selectedAttachment]);
      state.lastError = "replacement connection error";
      state.chatError = "replacement connection error";

      sends[3]!.resolve({ runId: staleRunId, status: "error" });
      await staleSend;

      expect(state.chatMessage).toBe("replacement connection draft");
      expect(state.chatAttachments).toEqual([selectedAttachment]);
      expect(state.lastError).toBe("replacement connection error");
      expect(state.chatError).toBe("replacement connection error");
      expect(Object.values(state.chatComposerFallbackByScope)).not.toContainEqual(
        expect.objectContaining({ message: "/approve approval-456 allow-once" }),
      );
    } finally {
      peerPane.chatState.hostDisconnected();
      pane.chatState.hostDisconnected();
    }
  });
});
