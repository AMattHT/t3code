import {
  McpServerError,
  McpServersCallToolInput,
  McpServersListToolInput,
  McpServersListToolResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as McpServerConnections from "../../../mcpServers/McpServerConnections.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  McpServerConnections.McpServerConnections,
];

/** What an MCP server tool fails with, including the access gate's refusal. */
const McpServersToolFailure = Schema.Union([McpServerError, OrchestratorMcpFailure]);

/**
 * Two fixed tools instead of one per upstream tool: they work with every
 * provider the moment a server is connected or turned off, without relying on
 * tool-list change notifications, and upstream names never collide with
 * provider tool-name limits.
 */
export const McpServersListTool = Tool.make("mcp_servers_list", {
  description:
    "List the MCP servers the user connected in T3 Code (Settings → MCP servers) and each tool's name, description, and inputSchema. Call it when the user asks for something a connected service could do, such as generating images or working with an issue tracker, and before mcp_servers_call.",
  parameters: McpServersListToolInput,
  success: McpServersListToolResult,
  failure: McpServersToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List MCP servers")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const McpServersCallTool = Tool.make("mcp_servers_call", {
  description:
    "Call a tool on one of the user's connected MCP servers. Take the server id, tool name, and argument shape from mcp_servers_list. Returns that tool's own result, including any images.",
  parameters: McpServersCallToolInput,
  success: Schema.Unknown,
  failure: McpServersToolFailure,
  // The write-access gate checks the caller's run.
  dependencies: [...dependencies, ThreadManagementService.ThreadManagementService],
})
  .annotate(Tool.Title, "Call MCP server tool")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const McpServersListToolkit = Toolkit.make(McpServersListTool);

export const McpServersCallToolkit = Toolkit.make(McpServersCallTool);
