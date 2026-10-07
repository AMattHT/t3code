/**
 * McpServerConnections connects once to each remote MCP server the user adds
 * in Settings → MCP servers, holds its sign-in, and serves its tools to agents
 * through `mcp_servers_list` and `mcp_servers_call` on T3's own MCP server.
 * Every provider already talks to that server, so one sign-in reaches all of
 * them, locally and over remote connections alike.
 *
 * Sign-in is the MCP authorization flow (discovery, dynamic client
 * registration, PKCE, refresh) run by the MCP SDK. The browser returns to
 * `/oauth/mcp-servers/callback` on the origin the user reached this
 * environment through, which `completeSignIn` finishes.
 *
 * @module mcpServers/McpServerConnections
 */
import {
  auth,
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  ToolListChangedNotificationSchema,
  type Tool as UpstreamTool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  McpServerError,
  McpServerId,
  McpServerUrl,
  parseMcpServerUrl,
  type McpServerAddInput,
  type McpServerEntry,
  type McpServerIdInput,
  type McpServerSetEnabledInput,
  type McpServerSignInInput,
  type McpServerSignInResult,
  type McpServersListToolResult,
  type McpServersState,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpClient } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { fetchServerIcon } from "./serverIcon.ts";

export const MCP_SERVERS_CALLBACK_PATH = "/oauth/mcp-servers/callback";

const DIRECTORY = "mcp-servers";
const CONNECT_TIMEOUT = Duration.seconds(20);
const CALL_TIMEOUT = Duration.minutes(10);
const SIGN_IN_TTL_MS = 15 * 60_000;
// A failed server is retried on the next look after this, not on every one.
const RETRY_AFTER_MS = 30_000;

const ManifestServer = Schema.Struct({
  id: McpServerId,
  name: Schema.String,
  url: McpServerUrl,
  enabled: Schema.Boolean,
});
type ManifestServer = typeof ManifestServer.Type;

const Manifest = Schema.Struct({ servers: Schema.Array(ManifestServer) });
type Manifest = typeof Manifest.Type;

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));

/** What the secret store holds per server. The SDK owns the inner shapes. */
const StoredSignIn = Schema.Struct({
  redirectUrl: Schema.String,
  clientInformation: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  tokens: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeStoredSignIn = Schema.decodeUnknownOption(Schema.fromJsonString(StoredSignIn));

/** The mutable sign-in state the SDK reads and writes during one flow or connection. */
interface SignInSession {
  redirectUrl: string;
  clientInformation: OAuthClientInformationMixed | undefined;
  tokens: OAuthTokens | undefined;
  codeVerifier?: string;
  state?: string;
  authorizationUrl?: URL;
}

const sessionSnapshot = (session: SignInSession) =>
  JSON.stringify({
    redirectUrl: session.redirectUrl,
    clientInformation: session.clientInformation,
    tokens: session.tokens,
  });

const makeAuthProvider = (session: SignInSession): OAuthClientProvider => ({
  get redirectUrl() {
    return session.redirectUrl;
  },
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "T3 Code",
      client_uri: "https://t3.codes",
      redirect_uris: [session.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  },
  ...(session.state === undefined ? {} : { state: () => session.state ?? "" }),
  clientInformation: () => session.clientInformation,
  saveClientInformation: (information) => {
    session.clientInformation = information;
  },
  tokens: () => session.tokens,
  saveTokens: (tokens) => {
    session.tokens = tokens;
  },
  // T3 hands the URL to the user's browser itself; outside a sign-in, a
  // request for one means the stored sign-in no longer works.
  redirectToAuthorization: (url) => {
    session.authorizationUrl = url;
  },
  saveCodeVerifier: (verifier) => {
    session.codeVerifier = verifier;
  },
  codeVerifier: () => {
    if (session.codeVerifier === undefined) throw new Error("No sign-in is in progress.");
    return session.codeVerifier;
  },
  invalidateCredentials: (scope) => {
    if (scope === "all" || scope === "client") session.clientInformation = undefined;
    if (scope === "all" || scope === "tokens") session.tokens = undefined;
    if (scope === "all" || scope === "verifier") delete session.codeVerifier;
  },
});

interface LiveConnection {
  readonly _tag: "Connected";
  readonly client: Client;
  readonly session: SignInSession | undefined;
  tools: ReadonlyArray<UpstreamTool>;
  /** Set when the transport drops, so the next use reconnects. */
  closed: boolean;
}

interface FailedConnection {
  readonly _tag: "Failed";
  readonly status: "needs_sign_in" | "error";
  readonly error?: string;
  readonly at: number;
}

type Connection = LiveConnection | FailedConnection;

interface PendingSignIn {
  readonly serverId: McpServerId;
  readonly session: SignInSession;
  readonly expiresAt: number;
}

/** A rejection from the MCP SDK, kept whole so its kind can be told apart. */
class McpUpstreamError extends Schema.TaggedError<McpUpstreamError>()("McpUpstreamError", {
  cause: Schema.Defect(),
}) {}

const isMcpUpstreamError = Schema.is(McpUpstreamError);

const upstream = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => new McpUpstreamError({ cause }) });

const isAuthFailure = (error: unknown): boolean => {
  const cause = isMcpUpstreamError(error) ? error.cause : error;
  return (
    cause instanceof UnauthorizedError ||
    (cause instanceof StreamableHTTPError && (cause.code === 401 || cause.code === 403))
  );
};

/** A short, user-facing reason without URLs or response bodies. */
const failureReason = (error: unknown): string => {
  const cause = isMcpUpstreamError(error) ? error.cause : error;
  if (cause instanceof StreamableHTTPError && cause.code !== undefined) {
    return `The server answered HTTP ${cause.code}.`;
  }
  if (Cause.isTimeoutError(cause)) return "The server did not answer in time.";
  return "The server could not be reached.";
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "server";

/** A readable default name: `mcp.higgsfield.ai` becomes `Higgsfield`. */
const nameFromUrl = (url: string) => {
  const labels = new URL(url).hostname.split(".");
  const meaningful =
    labels.length > 2 && ["mcp", "api", "www"].includes(labels[0] ?? "") ? labels[1] : labels[0];
  const name = meaningful ?? "MCP server";
  return name.charAt(0).toUpperCase() + name.slice(1);
};

export class McpServerConnections extends Context.Service<
  McpServerConnections,
  {
    readonly list: Effect.Effect<McpServersState, McpServerError>;
    readonly add: (input: McpServerAddInput) => Effect.Effect<McpServersState, McpServerError>;
    readonly remove: (input: McpServerIdInput) => Effect.Effect<McpServersState, McpServerError>;
    readonly setEnabled: (
      input: McpServerSetEnabledInput,
    ) => Effect.Effect<McpServersState, McpServerError>;
    /** Starts a sign-in and returns where to send the browser. */
    readonly signIn: (
      input: McpServerSignInInput,
    ) => Effect.Effect<McpServerSignInResult, McpServerError>;
    /** Finishes a sign-in from the provider's redirect; returns the server's name. */
    readonly completeSignIn: (input: {
      readonly state: string;
      readonly code: string;
    }) => Effect.Effect<string, McpServerError>;
    readonly signOut: (input: McpServerIdInput) => Effect.Effect<McpServersState, McpServerError>;
    /** Tools of every enabled server, for agents. */
    readonly listTools: (filter: {
      readonly server?: string | undefined;
    }) => Effect.Effect<McpServersListToolResult, McpServerError>;
    /** Calls an upstream tool and returns its raw MCP `CallToolResult`. */
    readonly callTool: (input: {
      readonly server: string;
      readonly tool: string;
      readonly arguments?: Readonly<Record<string, unknown>> | undefined;
    }) => Effect.Effect<unknown, McpServerError>;
  }
>()("t3/mcpServers/McpServerConnections") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const httpClient = yield* HttpClient.HttpClient;
  const connectLock = yield* KeyedLock.make<string>();
  const manifestLock = yield* KeyedLock.make<"manifest">();
  const connections = yield* Ref.make<ReadonlyMap<string, Connection>>(new Map());
  const pendingSignIns = yield* Ref.make<ReadonlyMap<string, PendingSignIn>>(new Map());
  const iconAttempts = new Set<string>();
  // Icon lookups run in the background for the life of the service.
  const scope = yield* Scope.Scope;

  const root = path.join(config.stateDir, DIRECTORY);
  const manifestPath = path.join(root, "servers.json");
  const iconPath = (id: string) => path.join(root, "icons", `${id}.txt`);
  const secretName = (id: string) => `mcp-server-sign-in-${id}`;

  const storageError =
    (operation: McpServerError["operation"], server?: string) => (cause: unknown) =>
      new McpServerError({
        operation,
        reason: "storage_failed",
        ...(server === undefined ? {} : { server }),
        cause,
      });

  const readManifest = (operation: McpServerError["operation"]) =>
    fs.readFileString(manifestPath).pipe(
      Effect.flatMap(decodeManifest),
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed<Manifest>({ servers: [] }),
      ),
      Effect.mapError(storageError(operation)),
    );

  const writeManifest = (operation: McpServerError["operation"], manifest: Manifest) =>
    writeFileStringAtomically({
      filePath: manifestPath,
      contents: `${JSON.stringify(manifest, null, 2)}\n`,
    }).pipe(Effect.mapError(storageError(operation)));

  /** Read-modify-write of the manifest, one writer at a time. */
  const updateManifest = <A>(
    operation: McpServerError["operation"],
    change: (manifest: Manifest) => Effect.Effect<readonly [Manifest, A], McpServerError>,
  ) =>
    manifestLock.withLock(
      "manifest",
      Effect.gen(function* () {
        const [next, result] = yield* change(yield* readManifest(operation));
        yield* writeManifest(operation, next);
        return result;
      }),
    );

  const findServer = (operation: McpServerError["operation"], manifest: Manifest, id: string) =>
    Effect.gen(function* () {
      const server = manifest.servers.find((candidate) => candidate.id === id);
      if (server === undefined) {
        return yield* new McpServerError({ operation, reason: "not_found", server: id });
      }
      return server;
    });

  const readSignIn = (id: string) =>
    secrets.get(secretName(id)).pipe(
      Effect.map((value) =>
        Option.flatMap(value, (bytes) => decodeStoredSignIn(new TextDecoder().decode(bytes))),
      ),
      Effect.orElseSucceed(() => Option.none()),
    );

  const writeSignIn = (id: string, session: SignInSession) =>
    secrets
      .set(secretName(id), new TextEncoder().encode(sessionSnapshot(session)))
      .pipe(Effect.mapError(storageError("signIn", id)));

  /** Saves what the SDK changed during a call, such as refreshed tokens. */
  const persistIfChanged = (id: string, session: SignInSession, before: string) =>
    sessionSnapshot(session) === before
      ? Effect.void
      : writeSignIn(id, session).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not save an MCP server sign-in.", { server: id, error }),
          ),
        );

  const sessionFrom = (stored: typeof StoredSignIn.Type): SignInSession => ({
    redirectUrl: stored.redirectUrl,
    clientInformation: stored.clientInformation as OAuthClientInformationMixed | undefined,
    tokens: stored.tokens as OAuthTokens | undefined,
  });

  const closeClient = (client: Client) =>
    Effect.promise(() => client.close().catch(() => undefined));

  const dropConnection = (id: string) =>
    Effect.gen(function* () {
      const current = (yield* Ref.get(connections)).get(id);
      yield* Ref.update(connections, (map) => {
        const next = new Map(map);
        next.delete(id);
        return next;
      });
      if (current?._tag === "Connected") yield* closeClient(current.client);
    });

  const setConnection = (id: string, connection: Connection) =>
    Ref.update(connections, (map) => new Map(map).set(id, connection));

  const listAllTools = (client: Client) =>
    upstream(async () => {
      const tools: Array<UpstreamTool> = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor === undefined ? {} : { cursor });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor !== undefined && tools.length < 1_000);
      return tools;
    });

  /** Looks for the server's logo in the background; the list shows it once found. */
  const ensureIcon = (server: ManifestServer, client: Client | undefined) =>
    Effect.gen(function* () {
      if (iconAttempts.has(server.id)) return;
      if (yield* fs.exists(iconPath(server.id)).pipe(Effect.orElseSucceed(() => false))) return;
      iconAttempts.add(server.id);
      const icon = yield* fetchServerIcon({
        serverUrl: server.url,
        advertised: client?.getServerVersion()?.icons ?? [],
      });
      if (icon !== undefined) {
        yield* fs.makeDirectory(path.dirname(iconPath(server.id)), { recursive: true });
        yield* fs.writeFileString(iconPath(server.id), icon);
      }
    }).pipe(Effect.ignore, Effect.forkIn(scope), Effect.asVoid);

  const connect = (server: ManifestServer) =>
    Effect.gen(function* () {
      const stored = yield* readSignIn(server.id);
      const session = Option.isSome(stored) ? sessionFrom(stored.value) : undefined;
      const before = session === undefined ? "" : sessionSnapshot(session);
      const transport = new StreamableHTTPClientTransport(
        new URL(server.url),
        session === undefined ? {} : { authProvider: makeAuthProvider(session) },
      );
      const client = new Client({ name: "T3 Code", version: packageJson.version });
      // The SDK's transport class predates `exactOptionalPropertyTypes`; it is the same shape.
      const connected = yield* upstream(() => client.connect(transport as Transport)).pipe(
        Effect.timeout(CONNECT_TIMEOUT),
        Effect.andThen(listAllTools(client)),
        Effect.result,
      );
      if (session !== undefined) yield* persistIfChanged(server.id, session, before);
      if (connected._tag === "Failure") {
        yield* closeClient(client);
        const cause = connected.failure;
        const at = yield* Clock.currentTimeMillis;
        const failed: FailedConnection = isAuthFailure(cause)
          ? { _tag: "Failed", status: "needs_sign_in", at }
          : { _tag: "Failed", status: "error", error: failureReason(cause), at };
        yield* setConnection(server.id, failed);
        yield* ensureIcon(server, undefined);
        return failed;
      }
      const live: LiveConnection = {
        _tag: "Connected",
        client,
        session,
        tools: connected.success,
        closed: false,
      };
      // Servers may change their tools while connected; keep the copy fresh.
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        live.tools = (await client.listTools()).tools;
      });
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the SDK transport has only an onclose property, no event target.
      transport.onclose = () => {
        live.closed = true;
      };
      yield* setConnection(server.id, live);
      yield* ensureIcon(server, client);
      return live;
    });

  /** A server's connection, connecting when it has none or its failure is stale. */
  const ensureConnected = (server: ManifestServer, force = false) =>
    connectLock.withLock(
      server.id,
      Effect.gen(function* () {
        const current = (yield* Ref.get(connections)).get(server.id);
        if (current?._tag === "Connected" && !current.closed) return current;
        if (current?._tag === "Connected") yield* closeClient(current.client);
        const now = yield* Clock.currentTimeMillis;
        if (current?._tag === "Failed" && !force && now - current.at < RETRY_AFTER_MS) {
          return current;
        }
        return yield* connect(server);
      }),
    );

  const readIcon = (id: string) =>
    fs.readFileString(iconPath(id)).pipe(Effect.option, Effect.map(Option.getOrUndefined));

  const entryFor = (server: ManifestServer) =>
    Effect.gen(function* () {
      const connection = server.enabled ? yield* ensureConnected(server) : undefined;
      const signedIn = Option.isSome(yield* readSignIn(server.id));
      const icon = yield* readIcon(server.id);
      return {
        id: server.id,
        name: server.name,
        url: server.url,
        enabled: server.enabled,
        status:
          connection === undefined
            ? "disabled"
            : connection._tag === "Connected"
              ? "connected"
              : connection.status,
        signedIn,
        ...(connection?._tag === "Failed" && connection.error !== undefined
          ? { error: connection.error }
          : {}),
        ...(icon === undefined ? {} : { icon }),
        tools:
          connection?._tag === "Connected"
            ? connection.tools.map((tool) => ({
                name: tool.name,
                ...(tool.title ? { title: tool.title } : {}),
                ...(tool.description ? { description: tool.description } : {}),
              }))
            : [],
      } satisfies McpServerEntry;
    });

  const stateFrom = (manifest: Manifest) =>
    Effect.forEach(manifest.servers, entryFor, { concurrency: "unbounded" }).pipe(
      Effect.map((servers) => ({ servers }) satisfies McpServersState),
    );

  const list = Effect.gen(function* () {
    return yield* stateFrom(yield* readManifest("list"));
  }).pipe(Effect.withSpan("McpServerConnections.list"));

  const add = Effect.fn("McpServerConnections.add")(function* (input: McpServerAddInput) {
    const url = parseMcpServerUrl(input.url);
    if (url === null) {
      return yield* new McpServerError({ operation: "add", reason: "invalid_url" });
    }
    const manifest = yield* updateManifest("add", (current) =>
      Effect.gen(function* () {
        const existing = current.servers.find((server) => server.url === url);
        if (existing !== undefined) {
          return yield* new McpServerError({
            operation: "add",
            reason: "already_added",
            server: existing.name,
          });
        }
        const name = input.name ?? nameFromUrl(url);
        const base = slugify(name);
        let id = base;
        for (let index = 2; current.servers.some((server) => server.id === id); index++) {
          id = `${base}-${index}`;
        }
        const next: Manifest = {
          servers: [...current.servers, { id, name, url, enabled: true }],
        };
        return [next, next] as const;
      }),
    );
    return yield* stateFrom(manifest);
  });

  const remove = Effect.fn("McpServerConnections.remove")(function* (input: McpServerIdInput) {
    const manifest = yield* updateManifest("remove", (current) =>
      findServer("remove", current, input.id).pipe(
        Effect.map(() => {
          const next: Manifest = {
            servers: current.servers.filter((server) => server.id !== input.id),
          };
          return [next, next] as const;
        }),
      ),
    );
    yield* dropConnection(input.id);
    yield* secrets.remove(secretName(input.id)).pipe(Effect.ignore);
    yield* fs.remove(iconPath(input.id), { force: true }).pipe(Effect.ignore);
    iconAttempts.delete(input.id);
    return yield* stateFrom(manifest);
  });

  const setEnabled = Effect.fn("McpServerConnections.setEnabled")(function* (
    input: McpServerSetEnabledInput,
  ) {
    const manifest = yield* updateManifest("setEnabled", (current) =>
      findServer("setEnabled", current, input.id).pipe(
        Effect.map(() => {
          const next: Manifest = {
            servers: current.servers.map((server) =>
              server.id === input.id ? { ...server, enabled: input.enabled } : server,
            ),
          };
          return [next, next] as const;
        }),
      ),
    );
    // Turning a server back on retries it now rather than after the backoff.
    yield* dropConnection(input.id);
    return yield* stateFrom(manifest);
  });

  const signIn = Effect.fn("McpServerConnections.signIn")(function* (input: McpServerSignInInput) {
    const server = yield* findServer("signIn", yield* readManifest("signIn"), input.id);
    if (!server.enabled) {
      return yield* new McpServerError({
        operation: "signIn",
        reason: "disabled",
        server: server.name,
      });
    }
    yield* dropConnection(server.id);
    const connection = yield* ensureConnected(server, true);
    if (connection._tag === "Connected") {
      return { _tag: "SignedIn", state: yield* list } as const;
    }

    const redirectUrl = new URL(MCP_SERVERS_CALLBACK_PATH, input.redirectBaseUrl).toString();
    const stored = yield* readSignIn(server.id);
    const state = Buffer.from(
      yield* crypto.randomBytes(24).pipe(Effect.mapError(storageError("signIn", server.name))),
    ).toString("base64url");
    const session: SignInSession = {
      redirectUrl,
      // A client registered for another origin cannot use this redirect.
      clientInformation:
        Option.isSome(stored) && stored.value.redirectUrl === redirectUrl
          ? (stored.value.clientInformation as OAuthClientInformationMixed | undefined)
          : undefined,
      tokens: undefined,
      state,
    };
    const signInFailed = (cause: unknown) =>
      new McpServerError({
        operation: "signIn",
        reason: "sign_in_failed",
        server: server.name,
        cause,
      });
    const result = yield* upstream(() =>
      auth(makeAuthProvider(session), { serverUrl: server.url }),
    ).pipe(Effect.mapError(signInFailed));
    if (result === "AUTHORIZED" || session.authorizationUrl === undefined) {
      return yield* signInFailed(new Error("The server did not ask for a browser sign-in."));
    }
    // Keep the registration so the next sign-in from this origin reuses it.
    if (session.clientInformation !== undefined) {
      yield* writeSignIn(server.id, {
        ...session,
        tokens: Option.isSome(stored)
          ? (stored.value.tokens as OAuthTokens | undefined)
          : undefined,
      });
    }
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(pendingSignIns, (map) => {
      const next = new Map([...map].filter(([, pending]) => pending.expiresAt > now));
      next.set(state, { serverId: server.id, session, expiresAt: now + SIGN_IN_TTL_MS });
      return next;
    });
    return { _tag: "Redirect", authorizationUrl: session.authorizationUrl.toString() } as const;
  });

  const completeSignIn = Effect.fn("McpServerConnections.completeSignIn")(function* (input: {
    readonly state: string;
    readonly code: string;
  }) {
    const pending = yield* Ref.modify(pendingSignIns, (map) => {
      const found = map.get(input.state);
      const next = new Map(map);
      next.delete(input.state);
      return [found, next] as const;
    });
    if (pending === undefined || pending.expiresAt < (yield* Clock.currentTimeMillis)) {
      return yield* new McpServerError({ operation: "signIn", reason: "sign_in_failed" });
    }
    const server = yield* findServer("signIn", yield* readManifest("signIn"), pending.serverId);
    yield* upstream(() =>
      auth(makeAuthProvider(pending.session), {
        serverUrl: server.url,
        authorizationCode: input.code,
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new McpServerError({
            operation: "signIn",
            reason: "sign_in_failed",
            server: server.name,
            cause,
          }),
      ),
    );
    yield* writeSignIn(server.id, pending.session);
    yield* dropConnection(server.id);
    yield* ensureConnected(server, true);
    return server.name;
  });

  const signOut = Effect.fn("McpServerConnections.signOut")(function* (input: McpServerIdInput) {
    const manifest = yield* readManifest("signOut");
    yield* findServer("signOut", manifest, input.id);
    yield* dropConnection(input.id);
    yield* secrets
      .remove(secretName(input.id))
      .pipe(Effect.mapError(storageError("signOut", input.id)));
    return yield* stateFrom(manifest);
  });

  const listTools = Effect.fn("McpServerConnections.listTools")(function* (filter: {
    readonly server?: string | undefined;
  }) {
    const manifest = yield* readManifest("list");
    const servers = manifest.servers.filter(
      (server) => server.enabled && (filter.server === undefined || server.id === filter.server),
    );
    const entries = yield* Effect.forEach(
      servers,
      (server) =>
        ensureConnected(server).pipe(
          Effect.map((connection) => ({
            id: server.id,
            name: server.name,
            status: connection._tag === "Connected" ? ("connected" as const) : connection.status,
            ...(connection._tag === "Failed"
              ? {
                  note:
                    connection.status === "needs_sign_in"
                      ? "Ask the user to sign in to this server in T3 Code under Settings → MCP servers."
                      : (connection.error ?? "The server could not be reached."),
                }
              : {}),
            tools:
              connection._tag === "Connected"
                ? connection.tools.map((tool) => ({
                    name: tool.name,
                    ...(tool.description ? { description: tool.description } : {}),
                    inputSchema: tool.inputSchema,
                    ...(tool.annotations?.readOnlyHint === undefined
                      ? {}
                      : { readOnly: tool.annotations.readOnlyHint }),
                  }))
                : [],
          })),
        ),
      { concurrency: "unbounded" },
    );
    return { servers: entries };
  });

  const callTool = Effect.fn("McpServerConnections.callTool")(function* (input: {
    readonly server: string;
    readonly tool: string;
    readonly arguments?: Readonly<Record<string, unknown>> | undefined;
  }) {
    const server = yield* findServer("callTool", yield* readManifest("callTool"), input.server);
    if (!server.enabled) {
      return yield* new McpServerError({
        operation: "callTool",
        reason: "disabled",
        server: server.name,
      });
    }
    const connection = yield* ensureConnected(server, true);
    if (connection._tag === "Failed") {
      return yield* new McpServerError({
        operation: "callTool",
        reason: connection.status === "needs_sign_in" ? "not_signed_in" : "unreachable",
        server: server.name,
      });
    }
    const before = connection.session === undefined ? "" : sessionSnapshot(connection.session);
    const result = yield* upstream(() =>
      connection.client.callTool(
        { name: input.tool, arguments: { ...input.arguments } },
        undefined,
        { timeout: Duration.toMillis(CALL_TIMEOUT) },
      ),
    ).pipe(Effect.result);
    if (connection.session !== undefined) {
      yield* persistIfChanged(server.id, connection.session, before);
    }
    if (result._tag === "Failure") {
      const cause = result.failure;
      if (isAuthFailure(cause)) {
        yield* dropConnection(server.id);
        yield* setConnection(server.id, {
          _tag: "Failed",
          status: "needs_sign_in",
          at: yield* Clock.currentTimeMillis,
        });
        return yield* new McpServerError({
          operation: "callTool",
          reason: "not_signed_in",
          server: server.name,
          cause,
        });
      }
      return yield* new McpServerError({
        operation: "callTool",
        reason: "tool_failed",
        server: server.name,
        cause,
      });
    }
    return result.success as unknown;
  });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const connection of (yield* Ref.get(connections)).values()) {
        if (connection._tag === "Connected") yield* closeClient(connection.client);
      }
    }),
  );

  const run = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | HttpClient.HttpClient>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

  return McpServerConnections.of({
    list: run(list),
    add: (input) => run(add(input)),
    remove: (input) => run(remove(input)),
    setEnabled: (input) => run(setEnabled(input)),
    signIn: (input) => run(signIn(input)),
    completeSignIn: (input) => run(completeSignIn(input)),
    signOut: (input) => run(signOut(input)),
    listTools: (filter) => run(listTools(filter)),
    callTool: (input) => run(callTool(input)),
  });
});

export const layer = Layer.effect(McpServerConnections, make);
