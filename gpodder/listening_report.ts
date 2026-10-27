/**
 * `@beddari/gpodder/listening-report` — after a library's `listening` method,
 * the window's listening as a Markdown page: per-podcast totals and every
 * episode played, with its progress. Other methods get a one-line note.
 *
 * @module
 */
import { type Listening, renderListening } from "./listening.ts";
import {
  type MethodReportContext,
  notMine,
  type ReportResult,
  written,
} from "./report_support.ts";

/** The weekly listening report. */
export const report = {
  name: "@beddari/gpodder/listening-report",
  description:
    "What was played in a library's listening window, by podcast and by episode",
  scope: "method" as const,
  labels: ["gpodder", "listening", "audit"],
  execute: async (context: MethodReportContext): Promise<ReportResult> => {
    if (context.methodName !== "listening") {
      return notMine(context.methodName, "listening");
    }
    if (context.executionStatus === "failed") {
      return {
        markdown: `# Listening\n\nThe run failed: ${
          context.errorMessage ?? "no message"
        }\n`,
        json: { failed: true, error: context.errorMessage ?? null },
      };
    }
    const l = await written(context, "listening") as Listening | null;
    if (!l) {
      return {
        markdown: "# Listening\n\nNo listening record was written.\n",
        json: {},
      };
    }
    return {
      markdown: renderListening(l),
      json: {
        label: l.label,
        from: l.from,
        to: l.to,
        totals: l.totals,
        byPodcast: l.byPodcast,
      },
    };
  },
};
