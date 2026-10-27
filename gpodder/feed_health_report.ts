/**
 * `@beddari/gpodder/feed-health-report` — after a library's `feedHealth`
 * method, the incidents by severity as a Markdown page: which feeds fail,
 * which moved or went stale, which enclosures are dead, which downloads are
 * gone or untranscribed. Other methods get a one-line note.
 *
 * @module
 */
import type { HealthCheck } from "./library.ts";
import {
  type MethodReportContext,
  notMine,
  type ReportResult,
  written,
} from "./report_support.ts";

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Render a health check as Markdown. */
export function renderHealth(h: HealthCheck): string {
  const lines = [
    "# Feed health",
    "",
    `${
      h.checkedAt.slice(0, 16).replace("T", " ")
    } UTC: ${h.healthy} of ${h.podcasts} feeds healthy; ` +
    `${h.counts.error} errors, ${h.counts.warning} warnings, ${h.counts.info} notes.`,
    "",
  ];
  for (const severity of ["error", "warning", "info"] as const) {
    const list = h.incidents.filter((i) => i.severity === severity);
    if (!list.length) continue;
    lines.push(
      `## ${
        severity === "error"
          ? "Errors"
          : severity === "warning"
          ? "Warnings"
          : "Notes"
      }`,
      "",
      "| Podcast | Kind | Detail |",
      "| --- | --- | --- |",
      ...list.map((i) =>
        `| ${cell(i.podcast)} | ${i.kind} | ${cell(i.detail)} |`
      ),
      "",
    );
  }
  if (!h.incidents.length) lines.push("Nothing to report.", "");
  return lines.join("\n");
}

/** The feed health report. */
export const report = {
  name: "@beddari/gpodder/feed-health-report",
  description: "A library's feed health check: incidents by severity",
  scope: "method" as const,
  labels: ["gpodder", "feeds", "health"],
  execute: async (context: MethodReportContext): Promise<ReportResult> => {
    if (context.methodName !== "feedHealth") {
      return notMine(context.methodName, "feedHealth");
    }
    const h = await written(context, "healthCheck") as HealthCheck | null;
    if (!h) {
      return {
        markdown: `# Feed health\n\nNo health check was recorded${
          context.errorMessage ? `: ${context.errorMessage}` : ""
        }.\n`,
        json: { failed: context.executionStatus === "failed" },
      };
    }
    return {
      markdown: renderHealth(h),
      json: {
        checkId: h.checkId,
        podcasts: h.podcasts,
        healthy: h.healthy,
        counts: h.counts,
      },
    };
  },
};
