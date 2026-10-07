import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Remote MCP servers an environment connects to once, on behalf of every
 * agent. T3 holds each server's sign-in and offers its tools to agents
 * through its own `t3-code` MCP server.
 */

export const McpServerId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/),
);
export type McpServerId = typeof McpServerId.Type;

/**
 * An MCP endpoint T3 can reach: https anywhere, plain http only on this
 * machine. Returns the normalized URL, or null.
 */
export function parseMcpServerUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  if (url.username || url.password) return null;
  url.hash = "";
  return url.toString();
}

export const McpServerUrl = TrimmedNonEmptyString.check(Schema.isMaxLength(2_048));

export const McpServerStatus = Schema.Literals(["disabled", "connected", "needs_sign_in", "error"]);
export type McpServerStatus = typeof McpServerStatus.Type;

export const McpServerToolSummary = Schema.Struct({
  name: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});
export type McpServerToolSummary = typeof McpServerToolSummary.Type;

export const McpServerEntry = Schema.Struct({
  id: McpServerId,
  name: Schema.String,
  url: McpServerUrl,
  enabled: Schema.Boolean,
  status: McpServerStatus,
  /** Whether T3 holds a sign-in for this server, even an expired one. */
  signedIn: Schema.Boolean,
  /** Why the last connection failed, when `status` is `error`. */
  error: Schema.optional(Schema.String),
  /** The server's logo as a data URL, from its MCP metadata or its website. */
  icon: Schema.optional(Schema.String),
  tools: Schema.Array(McpServerToolSummary),
});
export type McpServerEntry = typeof McpServerEntry.Type;

export const McpServersState = Schema.Struct({
  servers: Schema.Array(McpServerEntry),
});
export type McpServersState = typeof McpServersState.Type;

export const McpServerAddInput = Schema.Struct({
  url: McpServerUrl,
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
});
export type McpServerAddInput = typeof McpServerAddInput.Type;

export const McpServerIdInput = Schema.Struct({ id: McpServerId });
export type McpServerIdInput = typeof McpServerIdInput.Type;

export const McpServerSetEnabledInput = Schema.Struct({
  id: McpServerId,
  enabled: Schema.Boolean,
});
export type McpServerSetEnabledInput = typeof McpServerSetEnabledInput.Type;

export const McpServerSignInInput = Schema.Struct({
  id: McpServerId,
  /**
   * The environment origin the user's browser reaches, so the provider's
   * redirect comes back to this environment however it is connected.
   */
  redirectBaseUrl: McpServerUrl,
});
export type McpServerSignInInput = typeof McpServerSignInInput.Type;

export const McpServerSignInResult = Schema.Union([
  Schema.Struct({ _tag: Schema.tag("Redirect"), authorizationUrl: Schema.String }),
  /** The server needs no sign-in, or T3 already holds a working one. */
  Schema.Struct({ _tag: Schema.tag("SignedIn"), state: McpServersState }),
]);
export type McpServerSignInResult = typeof McpServerSignInResult.Type;

export class McpServerError extends Schema.TaggedError<McpServerError>()("McpServerError", {
  operation: Schema.Literals([
    "list",
    "add",
    "remove",
    "setEnabled",
    "signIn",
    "signOut",
    "callTool",
  ]),
  reason: Schema.Literals([
    "invalid_url",
    "already_added",
    "not_found",
    "disabled",
    "not_signed_in",
    "unreachable",
    "sign_in_failed",
    "tool_failed",
    "storage_failed",
  ]),
  server: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const server = this.server ?? "The MCP server";
    return {
      invalid_url: "Enter an https MCP server URL, or http only for localhost.",
      already_added: `${server} is already added.`,
      not_found: `${server} is not in this environment's MCP servers.`,
      disabled: `${server} is turned off in Settings → MCP servers.`,
      not_signed_in: `${server} needs you to sign in under Settings → MCP servers.`,
      unreachable: `${server} could not be reached.`,
      sign_in_failed: `Signing in to ${server} failed. Try again.`,
      tool_failed: `${server} could not run that tool.`,
      storage_failed: "MCP server settings could not be read or saved on this environment.",
    }[this.reason];
  }
}

// Agent tools on the `t3-code` MCP server.

export const McpServersListToolInput = Schema.Struct({
  server: Schema.optional(
    Schema.String.annotate({ description: "Only this server id. Defaults to every server." }),
  ),
});
export type McpServersListToolInput = typeof McpServersListToolInput.Type;

export const McpServersListToolResult = Schema.Struct({
  servers: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      status: McpServerStatus,
      note: Schema.optional(Schema.String),
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          description: Schema.optional(Schema.String),
          inputSchema: Schema.Unknown,
          readOnly: Schema.optional(Schema.Boolean),
        }),
      ),
    }),
  ),
});
export type McpServersListToolResult = typeof McpServersListToolResult.Type;

export const McpServersCallToolInput = Schema.Struct({
  server: Schema.String.annotate({ description: "Server id from mcp_servers_list." }),
  tool: Schema.String.annotate({ description: "Tool name from mcp_servers_list." }),
  arguments: Schema.optional(
    Schema.Record(Schema.String, Schema.Unknown).annotate({
      description: "Arguments matching the tool's inputSchema.",
    }),
  ),
});
export type McpServersCallToolInput = typeof McpServersCallToolInput.Type;
