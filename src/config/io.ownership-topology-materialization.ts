import { normalizeAgentId } from "../routing/session-key.js";
import { pinSoleAgentWorkspaceForFleetExpansion } from "./agent-workspace-ownership.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { materializeLegacyAgentOwnershipForActiveChannelsResult } from "./validation.js";

/** Reinstates upgrade-owned roles before a topology write stamps explicit ownership. */
export function materializeRetainedOwnerForTopologyWrite(params: {
  sourceConfig: OpenClawConfig;
  targetConfig: OpenClawConfig;
  previousSoleHandoffAgentId?: string;
  retainedLegacyDefaultAgentId?: string;
  writesOwnershipTopology: boolean;
  nextAgentIds: ReadonlySet<string>;
  env?: NodeJS.ProcessEnv;
}): {
  config: OpenClawConfig;
  insertedPaths: string[][];
  ownerAgentId?: string;
  pluginPath?: string;
} {
  const retainedFleetOwner =
    params.retainedLegacyDefaultAgentId &&
    params.writesOwnershipTopology &&
    params.nextAgentIds.has(normalizeAgentId(params.retainedLegacyDefaultAgentId))
      ? params.retainedLegacyDefaultAgentId
      : undefined;
  const ownerAgentId = params.previousSoleHandoffAgentId ?? retainedFleetOwner;
  if (!ownerAgentId) {
    return { config: params.targetConfig, insertedPaths: [] };
  }
  const workspacePin = pinSoleAgentWorkspaceForFleetExpansion({
    sourceConfig: params.sourceConfig,
    targetConfig: params.targetConfig,
    agentId: ownerAgentId,
    env: params.env,
  });
  const materialized = materializeLegacyAgentOwnershipForActiveChannelsResult(
    workspacePin.config,
    ownerAgentId,
    params.env,
    undefined,
    { materializeWorkspace: true },
  );
  return {
    config: materialized.config,
    insertedPaths: [...workspacePin.insertedPaths, ...materialized.insertedPaths],
    ownerAgentId,
    ...(workspacePin.pluginPath ? { pluginPath: workspacePin.pluginPath } : {}),
  };
}
