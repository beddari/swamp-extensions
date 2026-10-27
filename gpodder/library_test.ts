import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { model, redactUrl, window } from "./library.ts";
import { __setFetch } from "./feeds.ts";
import {
  FEED_PASSWORD,
  globalArgs,
  libraryContext,
  makeHome,
  type Written,
} from "./test_support.ts";
import { RSS } from "./fixtures.ts";

async function withHome(
  fn: (h: ReturnType<typeof makeHome>) => Promise<void>,
): Promise<void> {
  const h = makeHome();
  try {
    await fn(h);
  } finally {
    h.cleanup();
  }
}

Deno.test("podcasts never record a credential", async () => {
  await withHome(async (h) => {
    const { context, written } = libraryContext(globalArgs(h.home));
    await model.methods.podcasts.execute({}, context);
    assertEquals(written.map((w) => w.name), [
      "podcast-1",
      "podcast-2",
      "podcast-3",
    ]);
    assertEquals(JSON.stringify(written).includes(FEED_PASSWORD), false);
  });
});

Deno.test("episodes by state, with honest truncation", async () => {
  await withHome(async (h) => {
    const { context, written } = libraryContext(globalArgs(h.home));
    await model.methods.episodes.execute(
      { state: "downloaded", limit: 2 },
      context,
    );
    const list = written.find((w) => w.spec === "episodeList")!.data;
    assertEquals([list.count, list.truncated, list.episodeIds], [2, true, [
      11,
      10,
    ]]);
    written.length = 0;
    await model.methods.episodes.execute({ state: "new" }, context);
    assertEquals(
      written.filter((w) => w.spec === "episode").map((w) => w.name),
      ["episode-12"],
    );
  });
});

Deno.test("downloads: the first run is a baseline, then only new files on disk come back", async () => {
  await withHome(async (h) => {
    const written: Written[] = [];
    const { context, logs } = libraryContext(globalArgs(h.home), written);
    const run = async () => {
      const from = written.length;
      await model.methods.downloads.execute({}, context);
      return written.slice(from);
    };
    const first = await run();
    const d1 = first.find((w) => w.spec === "downloads")!.data;
    assertEquals([d1.baseline, d1.count], [true, 0]);
    assertEquals(first.find((w) => w.spec === "cursor")!.data.downloadedIds, [
      10,
      11,
    ]);
    assertStringIncludes(
      logs.join("\n"),
      "first run: 2 downloads taken as seen",
    );

    // gPodder downloads episode 12; its file lands on disk.
    h.exec(
      "UPDATE episode SET state = 1, download_filename = '12.mp3' WHERE id = 12",
    );
    Deno.writeFileSync(
      `${h.home}/Downloads/Open Feed/12.mp3`,
      new Uint8Array([1]),
    );
    const second = await run();
    const d2 = second.find((w) => w.spec === "downloads")!;
    assertEquals([d2.data.baseline, d2.data.episodeIds], [false, [12]]);
    assertEquals(
      second.find((w) => w.name === "episode-12")!.tags.batch,
      d2.data.batchId,
    );
    assertEquals(second.find((w) => w.spec === "cursor")!.data.downloadedIds, [
      10,
      11,
      12,
    ]);

    // Nothing new; and an episode deleted in gPodder leaves the cursor.
    h.exec("UPDATE episode SET state = 2 WHERE id = 10");
    const third = await run();
    assertEquals(third.find((w) => w.spec === "downloads")!.data.count, 0);
    assertEquals(third.find((w) => w.spec === "cursor")!.data.downloadedIds, [
      11,
      12,
    ]);
  });
});

Deno.test("downloads: backfill on the first run, and a limit leaves the rest pending", async () => {
  await withHome(async (h) => {
    const { context, written } = libraryContext(globalArgs(h.home));
    await model.methods.downloads.execute({ backfill: 5, limit: 1 }, context);
    const d = written.find((w) => w.spec === "downloads")!.data;
    assertEquals([d.baseline, d.episodeIds, d.truncated, d.pending], [
      true,
      [11],
      true,
      1,
    ]);
  });
});

Deno.test("listening covers the window and nothing older", async () => {
  await withHome(async (h) => {
    const out = Deno.makeTempDirSync();
    try {
      const { context, written } = libraryContext(globalArgs(h.home));
      await model.methods.listening.execute({
        days: 7,
        until: "2026-10-27T12:00:00Z",
        outputDir: out,
      }, context);
      const l = written[0];
      assertEquals(l.name, "listening-2026-w44");
      assertEquals((l.data.episodes as { id: number }[]).map((e) => e.id), [
        10,
        20,
      ]);
      assertEquals(l.data.totals, {
        episodes: 2,
        finished: 1,
        inProgress: 1,
        positionSec: 4795,
      });
      assertStringIncludes(
        Deno.readTextFileSync(`${out}/2026-W44.md`),
        "| Open Feed | 1 | 1 | 59:55 |",
      );
    } finally {
      Deno.removeSync(out, { recursive: true });
    }
  });
});

Deno.test("window rejects a bad until", () => {
  let err = "";
  try {
    window({ days: 7, until: "soon" });
  } catch (e) {
    err = (e as Error).message;
  }
  assertEquals(err, "until is not a date: soon");
});

function feedServer(seen: Request[]) {
  __setFetch((req) => {
    seen.push(req);
    const u = req.url;
    if (u === "http://feeds.test/open.xml") {
      return Promise.resolve(
        new Response(RSS, {
          headers: { "content-type": "application/rss+xml" },
        }),
      );
    }
    if (u === "http://feeds.test/private.xml") {
      return Promise.resolve(
        req.headers.get("authorization")
          ? new Response(null, { status: 500 })
          : new Response(null, { status: 401 }),
      );
    }
    if (u.startsWith("http://media.test/")) {
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    return Promise.reject(
      new Error(`no route for ${u} (password ${FEED_PASSWORD})`),
    );
  });
}

Deno.test("feedHealth records each feed, every incident, and never a password", async () => {
  await withHome(async (h) => {
    const seen: Request[] = [];
    feedServer(seen);
    try {
      const { context, written, logs } = libraryContext(globalArgs(h.home));
      await model.methods.feedHealth.execute({}, context);
      assertEquals(
        written.filter((w) => w.spec === "feedHealth").map((w) => w.name),
        ["feed-1", "feed-2"],
      );
      const check = written.find((w) => w.spec === "healthCheck")!.data as {
        counts: Record<string, number>;
        incidents: { kind: string }[];
        healthy: number;
      };
      assertEquals(check.incidents.map((i) => i.kind), [
        "feed-http-error",
        "download-file-missing",
      ]);
      assertEquals([check.healthy, check.counts], [1, {
        error: 1,
        warning: 1,
        info: 0,
      }]);
      const auth = seen.find((r) => r.url.endsWith("private.xml"))!.headers.get(
        "authorization",
      )!;
      assertEquals(
        atob(auth.replace("Basic ", "")),
        `listener:${FEED_PASSWORD}`,
      );
      const ids = new Set(written.map((w) => w.tags.check));
      assertEquals(ids.size, 1);
      assertStringIncludes(
        logs.join("\n"),
        "warning: error feed-http-error Private Feed: HTTP 500",
      );
      assertEquals(
        (JSON.stringify(written) + logs.join("\n")).includes(FEED_PASSWORD),
        false,
      );
    } finally {
      __setFetch();
    }
  });
});

Deno.test("feedHealth reports untranscribed downloads and fails when asked", async () => {
  await withHome(async (h) => {
    feedServer([]);
    try {
      const { context, written } = libraryContext(globalArgs(h.home));
      (context as unknown as { queryData: (p: string) => Promise<unknown[]> })
        .queryData = (p) =>
          Promise.resolve(
            p.includes('modelName == "tx"')
              ? [{
                name: "transcript-10",
                specName: "transcript",
                attributes: { episodeId: 10 },
              }]
              : [],
          );
      await assertRejects(
        () =>
          model.methods.feedHealth.execute({
            transcriber: "tx",
            failOn: "error",
            podcastIds: [1, 2],
          }, context),
        Error,
        "1 incidents at error or worse",
      );
      const check = written.find((w) => w.spec === "healthCheck")!.data as {
        incidents: { kind: string; detail: string }[];
      };
      const untranscribed = check.incidents.filter((i) =>
        i.kind === "download-not-transcribed"
      );
      assertEquals(untranscribed.map((i) => i.detail), [
        "Episode Eleven (episode 11) has no transcript in tx",
      ]);
    } finally {
      __setFetch();
    }
  });
});

Deno.test("URLs lose embedded credentials", () => {
  assertEquals(
    redactUrl("https://u:p@feeds.test/x.xml"),
    "https://feeds.test/x.xml",
  );
  assertEquals(redactUrl("not a url"), "not a url");
});

Deno.test("the database-readable check names a missing database", async () => {
  const r = await model.checks["database-readable"].execute({
    globalArgs: { home: "/nonexistent/gp" },
  });
  assertEquals(r.pass, false);
  assertStringIncludes(
    r.errors![0],
    "no gPodder database at /nonexistent/gp/Database",
  );
});

Deno.test("downloads with pendingFor returns an episode again until it is done, then gives up", async () => {
  await withHome(async (h) => {
    const written: Written[] = [];
    const { context, logs } = libraryContext(globalArgs(h.home), written);
    const done: Record<string, unknown>[] = [];
    (context as unknown as { queryData: (p: string) => Promise<unknown[]> })
      .queryData = (p) =>
        Promise.resolve(
          p.includes('"enricher"')
            ? done.map((a) => ({ name: "x", attributes: a }))
            : [],
        );
    const run = async () => {
      const from = written.length;
      await model.methods.downloads.execute(
        { backfill: 1, pendingFor: ["enricher"], maxAttempts: 2 },
        context,
      );
      return written.slice(from).find((w) => w.spec === "downloads")!.data;
    };
    assertEquals((await run()).episodeIds, [11]);
    // The enricher failed: 11 comes back once more, then is given up on.
    const second = await run();
    assertEquals([second.episodeIds, second.retried], [[11], [11]]);
    const third = await run();
    assertEquals([third.episodeIds, third.gaveUp], [[], [11]]);
    assertStringIncludes(logs.join("\n"), "not done after 2 attempts");
    // Once done, it is neither returned nor given up on.
    done.push({ episodeId: 11, guid: "guid-11" });
    const fourth = await run();
    assertEquals([fourth.episodeIds, fourth.gaveUp], [[], []]);
    const cursor = written.findLast((w) => w.spec === "cursor")!.data;
    assertEquals(cursor.attempts, []);
  });
});
