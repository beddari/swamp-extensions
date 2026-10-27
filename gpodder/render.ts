/**
 * One episode as a Markdown note for a personal knowledge base: YAML front
 * matter Obsidian and most static-site tools read, then the summary, key
 * points, chapters, cleaned show notes, mentions, links and optionally the
 * transcript. Every piece of feed or model text goes through `safeMarkdown`,
 * so a note shows text and links and loads nothing. The same inputs always render the same bytes, so an export
 * rewrites only what changed.
 *
 * @module
 */
import { clock, fileSegment, safeMarkdown as md, slug } from "./notes.ts";

/** The parts of a library episode record a note uses. */
export interface NoteEpisode {
  id: number;
  podcast: string;
  title: string;
  guid: string;
  link: string;
  url: string;
  published: string | null;
  durationSec: number;
  finished: boolean;
  links: { text: string; url: string }[];
}

/** The parts of an enrichment a note uses. */
export interface NoteEnrichment {
  summary: string;
  topics: string[];
  keyPoints: string[];
  chapters: { startSec: number; title: string; summary: string }[];
  notes: string;
  mentions: { name: string; kind: string }[];
  model: string;
  transcriptBased: boolean;
  enrichedAt: string;
}

/** A YAML scalar: JSON strings are valid YAML and need no further escaping. */
function y(v: string | number | boolean | null): string {
  return v === null
    ? "null"
    : typeof v === "string"
    ? JSON.stringify(v)
    : String(v);
}

/** The note's path below the export directory: `<podcast>/<date> <title>.md`. */
export function notePath(e: NoteEpisode): string {
  const date = e.published?.slice(0, 10) ?? "undated";
  return `${fileSegment(e.podcast, 80, 120)}/${date} ${
    fileSegment(e.title)
  }.md`;
}

/** Render one note. */
export function renderNote(
  e: NoteEpisode,
  x: NoteEnrichment,
  transcript?: { start: number; text: string }[],
  opts: { audioUrl?: boolean } = {},
): string {
  const tags = [...new Set(["podcast", ...x.topics.map((t) => slug(t, 40))])];
  const front = [
    "---",
    `title: ${y(e.title)}`,
    `podcast: ${y(e.podcast)}`,
    `published: ${y(e.published?.slice(0, 10) ?? null)}`,
    `duration: ${y(e.durationSec > 0 ? clock(e.durationSec) : null)}`,
    `listened: ${y(e.finished)}`,
    `episode: ${y(e.link || null)}`,
    ...(opts.audioUrl ? [`audio: ${y(e.url || null)}`] : []),
    `guid: ${y(e.guid)}`,
    `gpodder_id: ${e.id}`,
    "tags:",
    ...tags.map((t) => `  - ${y(t)}`),
    `enriched_with: ${y(x.model)}`,
    `enriched_at: ${y(x.enrichedAt)}`,
    `from_transcript: ${y(x.transcriptBased)}`,
    "---",
    "",
  ];
  const body = [`# ${md(e.title)}`, "", md(x.summary.trim()), ""];
  if (x.keyPoints.length) {
    body.push("## Key points", "", ...x.keyPoints.map((p) => `- ${md(p)}`), "");
  }
  if (x.chapters.length) {
    body.push(
      "## Chapters",
      "",
      ...x.chapters.map((c) =>
        `- **${clock(c.startSec)}** ${md(c.title)}${
          c.summary ? ` — ${md(c.summary)}` : ""
        }`
      ),
      "",
    );
  }
  if (x.notes.trim()) body.push("## Show notes", "", md(x.notes.trim()), "");
  if (x.mentions.length) {
    body.push(
      "## Mentioned",
      "",
      ...x.mentions.map((m) => `- ${md(m.name)} (${m.kind})`),
      "",
    );
  }
  if (e.links.length) {
    body.push(
      "## Links",
      "",
      ...e.links.map((l) =>
        l.text && l.text !== l.url
          ? `- [${md(l.text).replace(/[[\]]/g, "")}](${l.url})`
          : `- <${l.url}>`
      ),
      "",
    );
  }
  if (transcript?.length) {
    body.push(
      "## Transcript",
      "",
      ...transcript.map((s) => `**${clock(s.start)}** ${md(s.text)}`).flatMap((
        l,
      ) => [l, ""]),
    );
  }
  return [...front, ...body].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() +
    "\n";
}
