// @effect-diagnostics nodeBuiltinImport:off - the fixture runs a real MCP server and OAuth server on node:http, outside the service under test.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpServerConnections from "./McpServerConnections.ts";

const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const REDIRECT_BASE = "http://localhost:5733";

interface Fixture {
  readonly url: string;
  readonly origin: string;
  /** Tokens `/mcp` accepts; empty means it needs no sign-in. */
  readonly validTokens: Set<string>;
  readonly requireAuth: boolean;
  readonly registrations: Array<{ readonly redirect_uris: ReadonlyArray<string> }>;
  readonly close: () => Promise<void>;
}

const readBody = (request: NodeHttp.IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => resolve(body));
  });

const makeUpstream = () => {
  const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "Echo text back.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
      {
        name: "pixel",
        description: "Return a one-pixel image.",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    request.params.name === "echo"
      ? { content: [{ type: "text", text: `echo: ${String(request.params.arguments?.text)}` }] }
      : { content: [{ type: "image", data: PIXEL_PNG, mimeType: "image/png" }] },
  );
  return server;
};

/** An MCP server, optionally behind a minimal OAuth authorization server. */
const jwt = (claims: Record<string, unknown>) =>
  ["{}", JSON.stringify(claims), "signature"]
    .map((part) => Buffer.from(part).toString("base64url"))
    .join(".");

const startFixture = (
  requireAuth: boolean,
  options: { readonly refuseRegistration?: boolean } = {},
): Promise<Fixture> =>
  new Promise((resolve) => {
    const validTokens = new Set<string>();
    const registrations: Array<{ readonly redirect_uris: ReadonlyArray<string> }> = [];
    let origin = "";
    const json = (response: NodeHttp.ServerResponse, status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const http = NodeHttp.createServer(async (request, response) => {
      const path = new URL(request.url ?? "/", origin).pathname;
      if (path.startsWith("/.well-known/oauth-protected-resource")) {
        return json(response, 200, {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["offline_access"],
        });
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return json(response, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (path === "/register") {
        // Servers that allowlist their clients answer like Figma does.
        if (options.refuseRegistration) {
          response.writeHead(403);
          return response.end("Forbidden");
        }
        const registration = JSON.parse(await readBody(request));
        registrations.push(registration);
        return json(response, 201, {
          ...registration,
          client_id: `client-${registrations.length}`,
        });
      }
      if (path === "/token") {
        const form = new URLSearchParams(await readBody(request));
        const accepted =
          (form.get("grant_type") === "authorization_code" &&
            form.get("code") === "good-code" &&
            (form.get("code_verifier") ?? "").length >= 43) ||
          (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === "refresh-1");
        if (!accepted) return json(response, 400, { error: "invalid_grant" });
        const token = `token-${validTokens.size + 1}`;
        validTokens.add(token);
        const refreshing = form.get("grant_type") === "refresh_token";
        return json(response, 200, {
          access_token: token,
          // Like most providers, a refresh does not repeat the id_token.
          ...(refreshing ? {} : { id_token: jwt({ sub: "user-1", email: "maker@example.com" }) }),
          token_type: "Bearer",
          refresh_token: "refresh-1",
          expires_in: 3600,
        });
      }
      if (path === "/mcp") {
        const presented = request.headers.authorization?.replace(/^Bearer /, "");
        if (requireAuth && (presented === undefined || !validTokens.has(presented))) {
          response.writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          });
          return response.end();
        }
        const upstream = makeUpstream();
        // No session id generator makes the transport stateless: one request, one server.
        const transport = new StreamableHTTPServerTransport({});
        await upstream.connect(transport as Transport);
        const body = request.method === "POST" ? JSON.parse(await readBody(request)) : undefined;
        await transport.handleRequest(request, response, body);
        response.on("close", () => void upstream.close());
        return;
      }
      response.writeHead(404).end();
    });
    http.listen(0, "127.0.0.1", () => {
      const address = http.address() as { readonly port: number };
      origin = `http://127.0.0.1:${address.port}`;
      resolve({
        url: `${origin}/mcp`,
        origin,
        validTokens,
        requireAuth,
        registrations,
        close: () =>
          new Promise((done) => {
            http.closeAllConnections();
            http.close(() => done());
          }),
      });
    });
  });

const withConnections = <A, E>(
  fixture: Fixture,
  body: (connections: McpServerConnections.McpServerConnections["Service"]) => Effect.Effect<A, E>,
) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mcp-servers-"));
  return Effect.gen(function* () {
    return yield* body(yield* McpServerConnections.McpServerConnections);
  }).pipe(
    Effect.provide(
      McpServerConnections.layer.pipe(
        Layer.provide(ServerSecretStore.layer),
        Layer.provideMerge(ServerConfig.layerTest(root, root)),
        Layer.provide(FetchHttpClient.layer),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.ensuring(
      Effect.promise(async () => {
        await fixture.close();
        NodeFS.rmSync(root, { recursive: true, force: true });
      }),
    ),
  );
};

describe("McpServerConnections", () => {
  it.effect("connects to an open server and passes tool results through, images included", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => startFixture(false));
      return yield* withConnections(fixture, (connections) =>
        Effect.gen(function* () {
          const state = yield* connections.add({ url: fixture.url, name: "Fixture" });
          expect(state.servers).toMatchObject([
            { id: "fixture", name: "Fixture", status: "connected", signedIn: false },
          ]);
          expect(state.servers[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "pixel"]);

          const listed = yield* connections.listTools({});
          expect(listed.servers[0]?.tools.find((tool) => tool.name === "pixel")?.readOnly).toBe(
            true,
          );
          expect(
            listed.servers[0]?.tools.find((tool) => tool.name === "echo")?.inputSchema,
          ).toMatchObject({
            type: "object",
            properties: { text: { type: "string" } },
          });

          expect(
            yield* connections.callTool({
              server: "fixture",
              tool: "echo",
              arguments: { text: "hi" },
            }),
          ).toMatchObject({ content: [{ type: "text", text: "echo: hi" }] });
          expect(yield* connections.callTool({ server: "fixture", tool: "pixel" })).toMatchObject({
            content: [{ type: "image", data: PIXEL_PNG, mimeType: "image/png" }],
          });
        }),
      );
    }),
  );

  it.effect("signs in through the browser flow and then calls with the token", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => startFixture(true));
      return yield* withConnections(fixture, (connections) =>
        Effect.gen(function* () {
          const added = yield* connections.add({ url: fixture.url, name: "Fixture" });
          expect(added.servers[0]).toMatchObject({ status: "needs_sign_in", signedIn: false });
          const blocked = yield* connections
            .callTool({ server: "fixture", tool: "echo", arguments: { text: "x" } })
            .pipe(Effect.asVoid, Effect.flip);
          expect(blocked.reason).toBe("not_signed_in");

          const started = yield* connections.signIn({
            id: "fixture",
            redirectBaseUrl: REDIRECT_BASE,
          });
          if (started._tag !== "Redirect") throw new Error("Expected a browser redirect.");
          const authorization = new URL(started.authorizationUrl);
          expect(`${authorization.origin}${authorization.pathname}`).toBe(
            `${fixture.origin}/authorize`,
          );
          expect(authorization.searchParams.get("redirect_uri")).toBe(
            `${REDIRECT_BASE}/oauth/mcp-servers/callback`,
          );
          expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
          expect(fixture.registrations).toEqual([
            expect.objectContaining({
              redirect_uris: [`${REDIRECT_BASE}/oauth/mcp-servers/callback`],
            }),
          ]);

          const name = yield* connections.completeSignIn({
            state: authorization.searchParams.get("state") ?? "",
            code: "good-code",
          });
          expect(name).toBe("Fixture");
          const state = yield* connections.list;
          expect(state.servers[0]).toMatchObject({
            status: "connected",
            signedIn: true,
            account: "maker@example.com",
          });
          expect(
            yield* connections.callTool({
              server: "fixture",
              tool: "echo",
              arguments: { text: "signed" },
            }),
          ).toMatchObject({ content: [{ type: "text", text: "echo: signed" }] });

          // A redirect is single use.
          const replay = yield* connections
            .completeSignIn({
              state: authorization.searchParams.get("state") ?? "",
              code: "good-code",
            })
            .pipe(Effect.flip);
          expect(replay.reason).toBe("sign_in_failed");
        }),
      );
    }),
  );

  it.effect("refreshes an expired token with the stored refresh token", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => startFixture(true));
      return yield* withConnections(fixture, (connections) =>
        Effect.gen(function* () {
          yield* connections.add({ url: fixture.url, name: "Fixture" });
          const started = yield* connections.signIn({
            id: "fixture",
            redirectBaseUrl: REDIRECT_BASE,
          });
          if (started._tag !== "Redirect") throw new Error("Expected a browser redirect.");
          yield* connections.completeSignIn({
            state: new URL(started.authorizationUrl).searchParams.get("state") ?? "",
            code: "good-code",
          });

          // The server forgets the token; the stored refresh token gets a new one.
          fixture.validTokens.clear();
          yield* connections.setEnabled({ id: "fixture", enabled: false });
          yield* connections.setEnabled({ id: "fixture", enabled: true });
          expect(
            yield* connections.callTool({
              server: "fixture",
              tool: "echo",
              arguments: { text: "again" },
            }),
          ).toMatchObject({ content: [{ type: "text", text: "echo: again" }] });
          expect((yield* connections.list).servers[0]?.account).toBe("maker@example.com");
        }),
      );
    }),
  );

  it.effect("says plainly when a server refuses to let T3 Code sign in", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => startFixture(true, { refuseRegistration: true }));
      return yield* withConnections(fixture, (connections) =>
        Effect.gen(function* () {
          yield* connections.add({ url: fixture.url, name: "Fixture" });
          const refused = yield* connections
            .signIn({ id: "fixture", redirectBaseUrl: REDIRECT_BASE })
            .pipe(Effect.flip);
          expect(refused.reason).toBe("client_not_allowed");
          expect(refused.message).toContain("only accepts sign-ins from apps it has approved");
        }),
      );
    }),
  );

  it.effect("turning a server off hides its tools and blocks calls until it is back on", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => startFixture(false));
      return yield* withConnections(fixture, (connections) =>
        Effect.gen(function* () {
          yield* connections.add({ url: fixture.url, name: "Fixture" });
          const off = yield* connections.setEnabled({ id: "fixture", enabled: false });
          expect(off.servers[0]).toMatchObject({ status: "disabled", tools: [] });
          expect((yield* connections.listTools({})).servers).toEqual([]);
          const blocked = yield* connections
            .callTool({ server: "fixture", tool: "echo", arguments: { text: "x" } })
            .pipe(Effect.asVoid, Effect.flip);
          expect(blocked.reason).toBe("disabled");

          const on = yield* connections.setEnabled({ id: "fixture", enabled: true });
          expect(on.servers[0]?.status).toBe("connected");
          const removed = yield* connections.remove({ id: "fixture" });
          expect(removed.servers).toEqual([]);
        }),
      );
    }),
  );

  it.effect("rejects URLs it cannot use and servers already added", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => startFixture(false));
      return yield* withConnections(fixture, (connections) =>
        Effect.gen(function* () {
          const insecure = yield* connections
            .add({ url: "http://example.com/mcp" })
            .pipe(Effect.flip);
          expect(insecure.reason).toBe("invalid_url");
          yield* connections.add({ url: fixture.url });
          const again = yield* connections.add({ url: fixture.url }).pipe(Effect.flip);
          expect(again.reason).toBe("already_added");
        }),
      );
    }),
  );
});
