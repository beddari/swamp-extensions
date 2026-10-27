import { assertEquals } from "jsr:@std/assert@1.0.13";
import {
  __setFetch,
  feedIncidents,
  type FetchResult,
  fetchUrl,
  parseFeed,
  probeEnclosure,
} from "./feeds.ts";
import { RSS } from "./fixtures.ts";

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title>
<entry><title>E</title><id>urn:e</id><updated>2026-08-01T00:00:00Z</updated>
<link rel="enclosure" href="http://media.test/a.mp3" type="audio/mpeg"/></entry></feed>`;

Deno.test("RSS and Atom are read for items, dates, enclosures and transcripts", () => {
  const rss = parseFeed(RSS);
  assertEquals([rss.kind, rss.title, rss.items.length], [
    "rss",
    "Open & Feed",
    2,
  ]);
  assertEquals(rss.items[0], {
    title: "Newest <b>one</b>",
    guid: "g2",
    published: "2026-10-26T06:00:00.000Z",
    enclosureUrl: "http://media.test/2.mp3",
    enclosureType: "audio/mpeg",
    transcripts: [{ url: "http://media.test/2.vtt", type: "text/vtt" }],
  });
  assertEquals(rss.items[1].enclosureUrl, "http://media.test/1.mp3");
  const atom = parseFeed(ATOM);
  assertEquals(
    [atom.kind, atom.items[0].enclosureUrl, atom.items[0].published],
    ["atom", "http://media.test/a.mp3", "2026-08-01T00:00:00.000Z"],
  );
  assertEquals(parseFeed("<html><body>gone</body></html>").kind, null);
});

const ok: FetchResult = {
  url: "u",
  finalUrl: "u",
  status: 200,
  permanentRedirect: null,
  contentType: "application/rss+xml",
  latencyMs: 5,
  error: null,
};
const pod = { id: 1, title: "P", url: "http://feeds.test/p.xml" };
const rules = {
  staleDays: 30,
  now: new Date("2026-10-27T12:00:00Z"),
  transcriptTag: true,
};

Deno.test("a healthy feed has no incidents", () => {
  assertEquals(
    feedIncidents(pod, ok, parseFeed(RSS), [{
      ...ok,
      url: "http://media.test/2.mp3",
    }], rules),
    [],
  );
});

Deno.test("every incident kind a feed can have", () => {
  const kinds = (f: FetchResult, xml: string | null, enc: FetchResult[] = []) =>
    feedIncidents(pod, f, xml === null ? null : parseFeed(xml), enc, rules).map(
      (i) => `${i.severity} ${i.kind}`,
    );
  assertEquals(kinds({ ...ok, status: null, error: "timed out" }, null), [
    "error feed-unreachable",
  ]);
  assertEquals(kinds({ ...ok, status: 404 }, null), ["error feed-http-error"]);
  assertEquals(kinds(ok, "<html/>"), ["error feed-not-a-feed"]);
  assertEquals(kinds(ok, "<rss><channel></channel></rss>"), [
    "warning feed-empty",
  ]);
  assertEquals(
    kinds({ ...ok, permanentRedirect: "http://new.test/p.xml" }, RSS),
    ["warning feed-moved"],
  );
  assertEquals(kinds(ok, ATOM), [
    "warning feed-stale",
    "info no-published-transcripts",
  ]);
  assertEquals(
    kinds(ok, RSS, [{ ...ok, status: 410 }, {
      ...ok,
      status: null,
      error: "refused",
    }]),
    ["error enclosure-http-error", "error enclosure-unreachable"],
  );
});

Deno.test("a permanent redirect is reported and followed; HEAD refused falls back to a ranged GET", async () => {
  const seen: string[] = [];
  __setFetch((req) => {
    seen.push(
      `${req.method} ${req.url} ${req.headers.get("range") ?? ""}`.trim(),
    );
    if (req.url === "http://a.test/old") {
      return Promise.resolve(
        new Response(null, { status: 301, headers: { location: "/new" } }),
      );
    }
    if (req.url === "http://a.test/new") {
      return Promise.resolve(new Response("x".repeat(100), { status: 200 }));
    }
    if (req.method === "HEAD") {
      return Promise.resolve(new Response(null, { status: 405 }));
    }
    return Promise.resolve(new Response("b", { status: 206 }));
  });
  try {
    const got = await fetchUrl("http://a.test/old", {
      timeoutMs: 1000,
      maxBytes: 10,
    });
    assertEquals([got.status, got.permanentRedirect, got.finalUrl, got.body], [
      200,
      "http://a.test/new",
      "http://a.test/new",
      "x".repeat(10),
    ]);
    const probe = await probeEnclosure("http://a.test/e.mp3", 1000);
    assertEquals(probe.status, 206);
    assertEquals(seen.slice(2), [
      "HEAD http://a.test/e.mp3",
      "GET http://a.test/e.mp3 bytes=0-0",
    ]);
  } finally {
    __setFetch();
  }
});

Deno.test("credentials go to the feed's origin only, never across a redirect", async () => {
  const seen: [string, string | null][] = [];
  __setFetch((req) => {
    seen.push([req.url, req.headers.get("authorization")]);
    if (req.url === "https://a.test/feed") {
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "http://a.test/feed" },
        }),
      );
    }
    return Promise.resolve(new Response("<rss></rss>", { status: 200 }));
  });
  try {
    await fetchUrl("https://a.test/feed", {
      headers: { authorization: "Basic c2VjcmV0" },
      timeoutMs: 1000,
      maxBytes: 100,
    });
    assertEquals(seen, [
      ["https://a.test/feed", "Basic c2VjcmV0"],
      ["http://a.test/feed", null],
    ]);
  } finally {
    __setFetch();
  }
});
