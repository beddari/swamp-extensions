/**
 * Feed health: fetch each subscribed feed the way a podcast client does,
 * read just enough of it to know it is a feed, how fresh it is and whether it
 * publishes transcripts, probe the newest enclosures, and name what is wrong
 * as incidents.
 *
 * Reading is deliberately shallow and dependency-free: RSS `<item>` and Atom
 * `<entry>` blocks, their dates, their enclosures, and Podcasting 2.0
 * `<podcast:transcript>` tags. Nothing here parses a feed for content.
 *
 * @module
 */
import { decodeEntities } from "./notes.ts";

type Fetch = (input: Request) => Promise<Response>;

let fetchImpl: Fetch = (request) => fetch(request);

/** Replace `fetch`, for tests; no argument puts the real one back. */
export function __setFetch(f?: Fetch): void {
  fetchImpl = f ?? ((request) => fetch(request));
}

/** How serious an incident is. `error` fails a run that asks to. */
export const SEVERITIES = ["error", "warning", "info"] as const;

/** One of {@link SEVERITIES}. */
export type Severity = typeof SEVERITIES[number];

/** Every kind of incident feedHealth can report. */
export const INCIDENT_KINDS = [
  "feed-unreachable",
  "feed-http-error",
  "feed-not-a-feed",
  "feed-moved",
  "feed-stale",
  "feed-empty",
  "enclosure-unreachable",
  "enclosure-http-error",
  "no-published-transcripts",
  "download-file-missing",
  "download-not-transcribed",
] as const;

/** One of {@link INCIDENT_KINDS}. */
export type IncidentKind = typeof INCIDENT_KINDS[number];

/** Something wrong with one feed, one enclosure or one download. */
export interface Incident {
  kind: IncidentKind;
  severity: Severity;
  podcastId: number;
  podcast: string;
  url: string;
  detail: string;
}

/** What fetching one URL gave. */
export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number | null;
  permanentRedirect: string | null;
  contentType: string | null;
  latencyMs: number | null;
  error: string | null;
}

/** One item of a feed, as much of it as health needs. */
export interface FeedItem {
  title: string;
  guid: string;
  published: string | null;
  enclosureUrl: string | null;
  enclosureType: string | null;
  transcripts: { url: string; type: string }[];
}

/** A feed, as much of it as health needs. */
export interface ParsedFeed {
  kind: "rss" | "atom" | null;
  title: string;
  items: FeedItem[];
}

/** Options for {@link fetchUrl}. */
export interface FetchOptions {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  timeoutMs: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

function errText(err: unknown): string {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return "timed out";
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Fetch a URL following redirects by hand, so a permanent redirect (301,
 * 308) is seen and reported rather than silently followed. With `maxBytes`
 * the body is read up to that many bytes and returned; a feed larger than
 * that is cut there, which health reading tolerates.
 *
 * Credentials in `headers.authorization` go to the URL's own origin only: a
 * redirect to another host, port or scheme (https to http included) is
 * followed without them, as browsers do.
 */
export async function fetchUrl(
  url: string,
  opts: FetchOptions,
): Promise<FetchResult & { body: string | null }> {
  const started = performance.now();
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)])
    : AbortSignal.timeout(opts.timeoutMs);
  let current = url;
  let permanentRedirect: string | null = null;
  const origin = new URL(url).origin;
  const max = opts.maxRedirects ?? 10;
  try {
    for (let hop = 0; hop <= max; hop++) {
      const headers: Record<string, string> = {
        "user-agent": "swamp-gpodder-feed-health (+https://swamp-club.com)",
        ...opts.headers,
      };
      if (new URL(current).origin !== origin) delete headers.authorization;
      const response = await fetchImpl(
        new Request(current, {
          method: opts.method ?? "GET",
          headers,
          redirect: "manual",
          signal,
        }),
      );
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        const next = new URL(location, current).toString();
        if (
          (response.status === 301 || response.status === 308) &&
          permanentRedirect === null && hop === 0
        ) {
          permanentRedirect = next;
        }
        current = next;
        continue;
      }
      const body = opts.maxBytes && response.body
        ? await readCapped(response.body, opts.maxBytes)
        : (await response.body?.cancel(), null);
      return {
        url,
        finalUrl: current,
        status: response.status,
        permanentRedirect,
        contentType: response.headers.get("content-type"),
        latencyMs: Math.round(performance.now() - started),
        error: null,
        body,
      };
    }
    throw new Error(`more than ${max} redirects`);
  } catch (err) {
    return {
      url,
      finalUrl: current,
      status: null,
      permanentRedirect,
      contentType: null,
      latencyMs: null,
      error: errText(err),
      body: null,
    };
  }
}

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(size, maxBytes));
  let at = 0;
  for (const c of chunks) {
    const part = c.subarray(0, all.length - at);
    all.set(part, at);
    at += part.length;
    if (at >= all.length) break;
  }
  return new TextDecoder().decode(all);
}

function tagText(block: string, name: string): string {
  const m = new RegExp(
    `<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`,
    "i",
  ).exec(block);
  if (!m) return "";
  const inner = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
  return decodeEntities(inner).trim();
}

function tagAttr(tag: string, name: string): string | null {
  const m = new RegExp(
    `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "i",
  ).exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? "") : null;
}

function date(s: string): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Read a feed's kind, title and items, RSS or Atom; anything else is `null`. */
export function parseFeed(xml: string): ParsedFeed {
  const head = xml.slice(0, 4096);
  const kind = /<rss\b|<rdf:RDF\b/i.test(head)
    ? "rss"
    : /<feed\b[^>]*xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2005\/Atom/i.test(
        head,
      )
    ? "atom"
    : null;
  if (kind === null) return { kind, title: "", items: [] };
  const itemTag = kind === "rss" ? "item" : "entry";
  const blocks = [...xml.matchAll(
    new RegExp(`<${itemTag}\\b[\\s\\S]*?</${itemTag}\\s*>`, "gi"),
  )].map((m) => m[0]);
  const channel = blocks.length ? xml.slice(0, xml.indexOf(blocks[0])) : xml;
  const items = blocks.map((block): FeedItem => {
    let enclosureUrl: string | null = null;
    let enclosureType: string | null = null;
    if (kind === "rss") {
      const enc = /<enclosure\b[^>]*>/i.exec(block)?.[0];
      if (enc) {
        enclosureUrl = tagAttr(enc, "url");
        enclosureType = tagAttr(enc, "type");
      }
    } else {
      for (const link of block.matchAll(/<link\b[^>]*>/gi)) {
        if (tagAttr(link[0], "rel") === "enclosure") {
          enclosureUrl = tagAttr(link[0], "href");
          enclosureType = tagAttr(link[0], "type");
          break;
        }
      }
    }
    const transcripts = [...block.matchAll(/<podcast:transcript\b[^>]*>/gi)]
      .map((m) => ({
        url: tagAttr(m[0], "url") ?? "",
        type: tagAttr(m[0], "type") ?? "",
      }))
      .filter((t) => t.url !== "");
    return {
      title: tagText(block, "title"),
      guid: tagText(block, kind === "rss" ? "guid" : "id"),
      published: date(
        kind === "rss"
          ? tagText(block, "pubDate") || tagText(block, "dc:date")
          : tagText(block, "published") || tagText(block, "updated"),
      ),
      enclosureUrl,
      enclosureType,
      transcripts,
    };
  });
  return { kind, title: tagText(channel, "title"), items };
}

/**
 * Probe an enclosure without downloading it: HEAD, and when a server refuses
 * HEAD (some CDNs answer 403 or 405), a GET of its first byte.
 */
export async function probeEnclosure(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
  headers: Record<string, string> = {},
): Promise<FetchResult> {
  const head = await fetchUrl(url, {
    method: "HEAD",
    headers,
    timeoutMs,
    signal,
  });
  if (head.status !== null && [403, 405, 501].includes(head.status)) {
    const { body: _body, ...got } = await fetchUrl(url, {
      method: "GET",
      headers: { ...headers, range: "bytes=0-0" },
      timeoutMs,
      signal,
    });
    return got;
  }
  const { body: _body, ...result } = head;
  return result;
}

/** The thresholds incidents are judged by. */
export interface HealthRules {
  staleDays: number;
  now: Date;
  transcriptTag: boolean;
}

/**
 * The incidents in one feed's fetch, parse and enclosure probes. Pure: the
 * same inputs always give the same incidents, in the same order.
 */
export function feedIncidents(
  podcast: { id: number; title: string; url: string },
  feed: FetchResult,
  parsed: ParsedFeed | null,
  enclosures: FetchResult[],
  rules: HealthRules,
): Incident[] {
  const out: Incident[] = [];
  const add = (
    kind: IncidentKind,
    severity: Severity,
    url: string,
    detail: string,
  ) =>
    out.push({
      kind,
      severity,
      podcastId: podcast.id,
      podcast: podcast.title,
      url,
      detail,
    });
  if (feed.status === null) {
    add("feed-unreachable", "error", podcast.url, feed.error ?? "no answer");
    return out;
  }
  if (feed.status >= 400) {
    add("feed-http-error", "error", podcast.url, `HTTP ${feed.status}`);
    return out;
  }
  if (feed.permanentRedirect) {
    add(
      "feed-moved",
      "warning",
      podcast.url,
      `permanently redirected to ${feed.permanentRedirect}`,
    );
  }
  if (!parsed || parsed.kind === null) {
    add(
      "feed-not-a-feed",
      "error",
      podcast.url,
      `not RSS or Atom (content-type ${feed.contentType ?? "none"})`,
    );
    return out;
  }
  if (parsed.items.length === 0) {
    add("feed-empty", "warning", podcast.url, "the feed lists no episodes");
    return out;
  }
  const newest = parsed.items
    .map((i) => i.published)
    .filter((d): d is string => d !== null)
    .sort()
    .at(-1);
  if (newest) {
    const age = (rules.now.getTime() - Date.parse(newest)) / 86_400_000;
    if (age > rules.staleDays) {
      add(
        "feed-stale",
        "warning",
        podcast.url,
        `newest episode published ${newest.slice(0, 10)}, ${
          Math.floor(age)
        } days ago`,
      );
    }
  }
  for (const e of enclosures) {
    if (e.status === null) {
      add("enclosure-unreachable", "error", e.url, e.error ?? "no answer");
    } else if (e.status >= 400) {
      add("enclosure-http-error", "error", e.url, `HTTP ${e.status}`);
    }
  }
  if (
    rules.transcriptTag &&
    !parsed.items.some((i) => i.transcripts.length > 0)
  ) {
    add(
      "no-published-transcripts",
      "info",
      podcast.url,
      "no episode carries a <podcast:transcript> tag",
    );
  }
  return out;
}

/** Run `fn` over `items`, at most `limit` at once, results in input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}
