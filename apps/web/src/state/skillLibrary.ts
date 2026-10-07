import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import type { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

/** Skill repositories installed on an environment and the folders they link into. */
export const skillLibraryState = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:skill-library:list",
  tag: WS_METHODS.skillLibraryList,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});

const refreshList = (
  { environmentId }: { readonly environmentId: EnvironmentId },
  registry: AtomRegistry.AtomRegistry,
) => Effect.sync(() => registry.refresh(skillLibraryState({ environmentId, input: {} })));

// One change at a time per environment: each one rewrites the same links.
const serialPerEnvironment = {
  mode: "serial",
  key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
} as const;

export const skillLibraryAdd = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:skill-library:add",
  tag: WS_METHODS.skillLibraryAdd,
  concurrency: serialPerEnvironment,
  onSettled: refreshList,
});

export const skillLibraryUpdate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:skill-library:update",
  tag: WS_METHODS.skillLibraryUpdate,
  concurrency: serialPerEnvironment,
  onSettled: refreshList,
});

export const skillLibraryRemove = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:skill-library:remove",
  tag: WS_METHODS.skillLibraryRemove,
  concurrency: serialPerEnvironment,
  onSettled: refreshList,
});

export const skillLibrarySetEnabled = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:skill-library:set-enabled",
  tag: WS_METHODS.skillLibrarySetEnabled,
  concurrency: serialPerEnvironment,
  onSettled: refreshList,
});
