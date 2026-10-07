import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { renderPage } from "../auth/mcpOAuthHtml.ts";
import * as McpServerConnections from "./McpServerConnections.ts";

const PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const page = (status: number, title: string, body: string) =>
  HttpServerResponse.text(renderPage(title, body), {
    status,
    contentType: "text/html; charset=utf-8",
    headers: PAGE_HEADERS,
  });

/**
 * Where an MCP server's sign-in sends the browser back. The single-use
 * `state` ties the request to a sign-in this environment started, so the
 * route needs no session of its own.
 */
export const layerCallbackRoute = HttpRouter.add(
  "GET",
  McpServerConnections.MCP_SERVERS_CALLBACK_PATH,
  Effect.gen(function* () {
    const connections = yield* McpServerConnections.McpServerConnections;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const params = Option.isSome(url) ? url.value.searchParams : new URLSearchParams();
    const state = params.get("state");
    const code = params.get("code");
    if (state === null || code === null) {
      return page(
        400,
        "Sign-in was not completed",
        "The MCP server did not finish signing you in. Close this page and choose Sign in again in T3 Code.",
      );
    }
    return yield* connections.completeSignIn({ state, code }).pipe(
      Effect.match({
        onFailure: () =>
          page(
            400,
            "Sign-in failed",
            "This sign-in expired or could not be completed. Close this page and choose Sign in again in T3 Code.",
          ),
        onSuccess: (name) =>
          page(200, `Signed in to ${name}`, "You can close this page and return to T3 Code."),
      }),
    );
  }),
);
