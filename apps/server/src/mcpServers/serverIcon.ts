import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

const MAX_ICON_BYTES = 256 * 1024;
// Icon links live in <head>; the start of a large page is enough.
const PAGE_HEAD_BYTES = 256 * 1024;
const FETCH_TIMEOUT = Duration.seconds(8);

interface AdvertisedIcon {
  readonly src: string;
  readonly theme?: string | undefined;
}

/** A small successful response body and its media type, or undefined. */
const fetchCapped = Effect.fn("serverIcon.fetchCapped")(function* (url: string, limit: number) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders({ "user-agent": "T3 Code" })),
  );
  const length = Number(response.headers["content-length"]);
  if (response.status >= 400 || (Number.isFinite(length) && length > limit)) return undefined;
  const bytes = new Uint8Array(yield* response.arrayBuffer);
  if (bytes.byteLength > limit) return undefined;
  const type = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return { bytes, type };
}, Effect.timeout(FETCH_TIMEOUT));

/** The first `limit` bytes of a successful page. */
const fetchPageHead = Effect.fn("serverIcon.fetchPageHead")(function* (url: string, limit: number) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders({ "user-agent": "T3 Code" })),
  );
  if (response.status >= 400) return "";
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  yield* Stream.runForEachWhile(response.stream, (chunk) =>
    Effect.sync(() => {
      chunks.push(chunk);
      size += chunk.byteLength;
      return size < limit;
    }),
  );
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, limit));
}, Effect.timeout(FETCH_TIMEOUT));

/** An image at `url` as a data URL, or undefined when it is not a small image. */
const imageDataUrl = (url: string) =>
  Effect.gen(function* () {
    if (url.startsWith("data:image/")) {
      return url.length <= MAX_ICON_BYTES * 1.4 ? url : undefined;
    }
    if (!url.startsWith("https://")) return undefined;
    const fetched = yield* fetchCapped(url, MAX_ICON_BYTES);
    if (fetched === undefined || !fetched.type.startsWith("image/")) return undefined;
    return `data:${fetched.type};base64,${Buffer.from(fetched.bytes).toString("base64")}`;
  }).pipe(Effect.orElseSucceed(() => undefined));

/** Icons a website's home page links to, largest kinds first. */
const websiteIconUrls = (origin: string) =>
  Effect.gen(function* () {
    const html = yield* fetchPageHead(origin, PAGE_HEAD_BYTES);
    const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => match[0]);
    const hrefsFor = (rel: RegExp) =>
      links
        .filter((tag) => rel.test(/\brel=["']?([^"'>]+)/i.exec(tag)?.[1] ?? ""))
        .map((tag) => /\bhref=["']?([^"'\s>]+)/i.exec(tag)?.[1])
        .filter((href): href is string => href !== undefined)
        .map((href) => new URL(href, origin).toString());
    return [...hrefsFor(/apple-touch-icon/i), ...hrefsFor(/(^|\s)icon(\s|$)/i)];
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

/**
 * A logo for an MCP server as a data URL: the icon it advertises in its MCP
 * metadata, else the one its website links to (trying `mcp.example.com`, then
 * `example.com`). Undefined when neither yields a small image.
 */
export const fetchServerIcon = Effect.fn("serverIcon.fetchServerIcon")(function* (input: {
  readonly serverUrl: string;
  readonly advertised: ReadonlyArray<AdvertisedIcon>;
}) {
  // Light-theme icons first: they suit the settings list in either theme better
  // than a dark-only mark.
  const advertised = [...input.advertised].sort(
    (left, right) => Number(left.theme === "dark") - Number(right.theme === "dark"),
  );
  for (const icon of advertised) {
    const dataUrl = yield* imageDataUrl(icon.src);
    if (dataUrl !== undefined) return dataUrl;
  }
  const host = new URL(input.serverUrl).hostname;
  // A local or IP-addressed server has no website to borrow an icon from.
  if (host === "localhost" || /^[\d.]+$|^\[/.test(host)) return undefined;
  const labels = host.split(".");
  const hosts = labels.length > 2 ? [host, labels.slice(1).join(".")] : [host];
  // Linked icons on either site beat a bare favicon.ico, which is often tiny.
  const linked = yield* Effect.forEach(hosts, (candidate) =>
    websiteIconUrls(`https://${candidate}`),
  );
  for (const url of [
    ...linked.flat(),
    ...hosts.map((candidate) => `https://${candidate}/favicon.ico`),
  ]) {
    const dataUrl = yield* imageDataUrl(url);
    if (dataUrl !== undefined) return dataUrl;
  }
  return undefined;
});
