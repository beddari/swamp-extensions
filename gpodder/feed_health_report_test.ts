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

Deno.test("the feed health report groups incidents by severity", async () => {
  const r = await health.execute(ctx("feedHealth", "healthCheck", {
    checkId: "c",
    checkedAt: "2026-10-27T06:00:00.000Z",
    podcasts: 2,
    healthy: 1,
    counts: { error: 1, warning: 0, info: 1 },
    incidents: [
      {
        kind: "feed-http-error",
        severity: "error",
        podcastId: 2,
        podcast: "A|B",
        url: "u",
        detail: "HTTP 500",
      },
      {
        kind: "no-published-transcripts",
        severity: "info",
        podcastId: 1,
        podcast: "C",
        url: "u",
        detail: "none",
      },
    ],
  }));
  assertStringIncludes(
    r.markdown,
    "1 of 2 feeds healthy; 1 errors, 0 warnings, 1 notes.",
  );
  assertStringIncludes(
    r.markdown,
    "## Errors\n\n| Podcast | Kind | Detail |\n| --- | --- | --- |\n| A\\|B | feed-http-error | HTTP 500 |",
  );
  assertStringIncludes(r.markdown, "## Notes");
});
