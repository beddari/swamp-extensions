/**
 * The smoke run's network: podcast feeds, their enclosures, and a stand-in
 * for the Anthropic Messages API that streams one canned analysis the way
 * the real API does (server-sent events), so the real SDK runs end to end
 * without an account or a bill. Every Messages request body is appended to
 * `<dir>/requests.jsonl` for the smoke script to inspect.
 *
 * @module
 */
import { RSS } from "../fixtures.ts";

const [port, dir] = [Number(Deno.args[0]), Deno.args[1]];
const base = `http://127.0.0.1:${port}`;
const feed = RSS.replaceAll("http://media.test", `${base}/media`);

const ANSWER = {
  summary: "A canned summary from the smoke server.",
  topics: ["Testing", "Podcasts"],
  keyPoints: ["The pipeline ran end to end."],
  chapters: [{ startSec: 0, title: "Start", summary: "It begins." }],
  notes: "Clean notes.",
  mentions: [{ name: "gPodder", kind: "product" }],
};

function sse(): ReadableStream<Uint8Array> {
  const text = JSON.stringify(ANSWER);
  const events: [string, unknown][] = [
    ["message_start", {
      type: "message_start",
      message: {
        id: "msg_smoke",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 321, output_tokens: 1 },
      },
    }],
    ["content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }],
    ["content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(0, 40) },
    }],
    ["content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(40) },
    }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 99 },
    }],
    ["message_stop", { type: "message_stop" }],
  ];
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const [event, data] of events) {
        c.enqueue(
          enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      }
      c.close();
    },
  });
}

Deno.serve({
  port,
  hostname: "127.0.0.1",
  onListen: () => console.log(`listening on ${base}`),
}, async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/feeds/open.xml") {
    return new Response(feed, {
      headers: { "content-type": "application/rss+xml" },
    });
  }
  if (url.pathname === "/feeds/private.xml") {
    return new Response("nope", {
      status: req.headers.get("authorization") ? 403 : 401,
    });
  }
  if (url.pathname === "/feeds/paused.xml") {
    return new Response("gone", { status: 410 });
  }
  if (url.pathname.startsWith("/media/")) {
    return url.pathname.endsWith("1.mp3")
      ? new Response(null, { status: 404 })
      : new Response(null, { status: 200 });
  }
  if (url.pathname === "/v1/messages" && req.method === "POST") {
    const body = await req.text();
    await Deno.writeTextFile(`${dir}/requests.jsonl`, body + "\n", {
      append: true,
    });
    return new Response(sse(), {
      headers: { "content-type": "text/event-stream" },
    });
  }
  return new Response("no such path", { status: 404 });
});
