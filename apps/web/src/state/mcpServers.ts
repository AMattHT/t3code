import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import type { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

/** An environment's MCP servers with their live status and tools. */
export const mcpServersState = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:mcp-servers:list",
  tag: WS_METHODS.mcpServersList,
  staleTimeMs: 15_000,
  idleTtlMs: 5 * 60_000,
});

const refreshList = (
  { environmentId }: { readonly environmentId: EnvironmentId },
  registry: AtomRegistry.AtomRegistry,
) => Effect.sync(() => registry.refresh(mcpServersState({ environmentId, input: {} })));

const serialPerEnvironment = {
  mode: "serial",
  key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
} as const;

export const mcpServersAdd = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:mcp-servers:add",
  tag: WS_METHODS.mcpServersAdd,
  concurrency: serialPerEnvironment,
  onSettled: refreshList,
});

export const mcpServersRemove = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:mcp-servers:remove",
  tag: WS_METHODS.mcpServersRemove,
  concurrency: serialPerEnvironment,
  onSettled: refreshList,
});

export const mcpServersSetEnabled = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:mcp-servers:set-enabled",
  tag: WS_METHODS.mcpServersSetEnabled,
  concurrency: serialPerEnvironment,
  onSettled: refreshList,
});

export const mcpServersSignIn = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:mcp-servers:sign-in",
  tag: WS_METHODS.mcpServersSignIn,
  concurrency: serialPerEnvironment,
  onSettled: refreshList,
});

export const mcpServersSignOut = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:mcp-servers:sign-out",
  tag: WS_METHODS.mcpServersSignOut,
  concurrency: serialPerEnvironment,
  onSettled: refreshList,
});
