import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.13";
import { report as listening } from "./listening_report.ts";
import { report as health } from "./feed_health_report.ts";
import type { MethodReportContext } from "./report_support.ts";

function ctx(
  methodName: string,
  spec: string,
  data: unknown,
): MethodReportContext {
  return {
    modelType: "@beddari/gpodder/library",
    modelId: "id",
    methodName,
    executionStatus: "succeeded",
    dataHandles: [{ name: "n", specName: spec, version: 1 }],
    dataRepository: {
      getContent: () =>
        Promise.resolve(new TextEncoder().encode(JSON.stringify(data))),
    },
  };
}

Deno.test("each report answers for its own method only", async () => {
  assertEquals(
    (await listening.execute(ctx("downloads", "downloads", {}))).json,
    { skipped: true, method: "downloads" },
  );
  assertEquals((await health.execute(ctx("listening", "listening", {}))).json, {
    skipped: true,
    method: "listening",
  });
});

Deno.test("the listening report renders the window", async () => {
  const r = await listening.execute(ctx("listening", "listening", {
    from: "2026-10-20T12:00:00.000Z",
    to: "2026-10-27T12:00:00.000Z",
    label: "2026-W44",
    episodes: [],
    byPodcast: [],
    totals: { episodes: 0, finished: 0, inProgress: 0, positionSec: 0 },
  }));
  assertStringIncludes(
    r.markdown,
    "# Listening 2026-W44\n\n2026-10-20 to 2026-10-27: 0 episodes",
  );
  assertStringIncludes(r.markdown, "Nothing played in this window.");
});

Deno.test("ISO weeks across a year boundary", async () => {
  const { isoWeek } = await import("./listening.ts");
  assertEquals(isoWeek(new Date(2026, 0, 1, 12)), "2026-W01");
  assertEquals(isoWeek(new Date(2027, 0, 1, 12)), "2026-W53");
  assertEquals(isoWeek(new Date(2026, 9, 25, 21)), "2026-W43");
});
