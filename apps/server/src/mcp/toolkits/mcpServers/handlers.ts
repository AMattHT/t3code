import * as Effect from "effect/Effect";

import * as McpServerConnections from "../../../mcpServers/McpServerConnections.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { McpServersCallToolkit, McpServersListToolkit } from "./tools.ts";

export const layerList = McpToolAccess.toLayer(McpServersListToolkit, {
  mcp_servers_list: McpToolAccess.reads((input) =>
    Effect.flatMap(McpServerConnections.McpServerConnections, (connections) =>
      connections.listTools(input),
    ),
  ),
});

/** Upstream tools can change things on the user's accounts, so calls need write access. */
export const layerCall = McpToolAccess.toLayer(McpServersCallToolkit, {
  mcp_servers_call: McpToolAccess.writes((input) =>
    Effect.flatMap(McpServerConnections.McpServerConnections, (connections) =>
      connections.callTool(input),
    ),
  ),
});
