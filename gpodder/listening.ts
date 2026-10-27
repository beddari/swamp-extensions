/**
 * What was listened to in a window of time, from gPodder's playback marks,
 * and that summary as Markdown. Shared by the library model, which records
 * it, and the listening report, which renders it.
 *
 * gPodder knows two times for an episode: when playback last started
 * (`last_playback`) and when a position was last saved
 * (`current_position_updated`). Either inside the window counts as activity.
 * It knows no listening time, only how far into an episode playback reached,
 * so `positionSec` is a position reached and not time spent; and a player
 * that reports no position back to gPodder leaves only the playback mark.
 *
 * @module
 */
import { z } from "npm:zod@4";
import type { Episode } from "./gpodder_db.ts";
import { clock } from "./notes.ts";

/** One episode active in the window. */
export const ListenedSchema = z.object({
  id: z.number().int(),
  podcast: z.string(),
  title: z.string(),
  link: z.string(),
  finished: z.boolean(),
  positionSec: z.number(),
  durationSec: z.number(),
  progress: z.number().describe(
    "Position over duration, 0 to 1; 0 when the duration is unknown",
  ),
  lastActivityAt: z.string(),
});

/** One podcast's share of the window. */
export const PodcastTotalSchema = z.object({
  podcast: z.string(),
  episodes: z.number().int(),
  finished: z.number().int(),
  positionSec: z.number(),
});

/** A window's listening, as the `listening` resource records it. */
export const ListeningSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().describe("ISO week of the window's end, e.g. 2026-W43"),
  episodes: z.array(ListenedSchema),
  byPodcast: z.array(PodcastTotalSchema),
  totals: z.object({
    episodes: z.number().int(),
    finished: z.number().int(),
    inProgress: z.number().int(),
    positionSec: z.number().describe(
      "Sum of positions reached, not time spent listening",
    ),
  }),
});

/** A window's listening. */
export type Listening = z.infer<typeof ListeningSchema>;

/**
 * The ISO 8601 week a date falls in, as `YYYY-Www`, by the calendar date where
 * swamp runs: a run on Sunday evening is that Sunday's week in any time zone.
 */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(
    ((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7,
  );
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The later of an episode's two activity times, or null. */
export function lastActivity(e: Episode): string | null {
  const times = [e.lastPlaybackAt, e.positionUpdatedAt]
    .filter((t): t is string => t !== null)
    .sort();
  return times.at(-1) ?? null;
}

/** Summarise the episodes active between `from` (inclusive) and `to`. */
export function summarise(
  episodes: Episode[],
  from: Date,
  to: Date,
): Listening {
  const active = episodes
    .map((e) => ({ e, at: lastActivity(e) }))
    .filter((x): x is { e: Episode; at: string } =>
      x.at !== null && Date.parse(x.at) >= from.getTime() &&
      Date.parse(x.at) < to.getTime()
    )
    .sort((a, b) => b.at.localeCompare(a.at) || a.e.id - b.e.id);
  const listened = active.map(({ e, at }) => ({
    id: e.id,
    podcast: e.podcast,
    title: e.title,
    link: e.link,
    finished: e.finished,
    positionSec: e.positionSec,
    durationSec: e.durationSec,
    progress: e.durationSec > 0
      ? Math.min(1, Math.round((e.positionSec / e.durationSec) * 1000) / 1000)
      : 0,
    lastActivityAt: at,
  }));
  const totals = new Map<string, z.infer<typeof PodcastTotalSchema>>();
  for (const l of listened) {
    const t = totals.get(l.podcast) ??
      { podcast: l.podcast, episodes: 0, finished: 0, positionSec: 0 };
    t.episodes++;
    if (l.finished) t.finished++;
    t.positionSec += l.positionSec;
    totals.set(l.podcast, t);
  }
  const finished = listened.filter((l) => l.finished).length;
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    label: isoWeek(new Date(to.getTime() - 1)),
    episodes: listened,
    byPodcast: [...totals.values()].sort((a, b) =>
      b.positionSec - a.positionSec || a.podcast.localeCompare(b.podcast)
    ),
    totals: {
      episodes: listened.length,
      finished,
      inProgress: listened.filter((l) => !l.finished && l.positionSec > 0)
        .length,
      positionSec: listened.reduce((sum, l) => sum + l.positionSec, 0),
    },
  };
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** A window's listening as a Markdown page. */
export function renderListening(l: Listening): string {
  const lines = [
    `# Listening ${l.label}`,
    "",
    `${l.from.slice(0, 10)} to ${
      l.to.slice(0, 10)
    }: ${l.totals.episodes} episodes, ` +
    `${l.totals.finished} finished, ${l.totals.inProgress} in progress, ` +
    `${clock(l.totals.positionSec)} of positions reached.`,
    "",
  ];
  if (l.episodes.length === 0) {
    lines.push("Nothing played in this window.", "");
    return lines.join("\n");
  }
  lines.push(
    "## By podcast",
    "",
    "| Podcast | Episodes | Finished | Reached |",
    "| --- | ---: | ---: | ---: |",
    ...l.byPodcast.map((p) =>
      `| ${cell(p.podcast)} | ${p.episodes} | ${p.finished} | ${
        clock(p.positionSec)
      } |`
    ),
    "",
    "## Episodes",
    "",
    "| Last played | Podcast | Episode | Progress |",
    "| --- | --- | --- | ---: |",
    ...l.episodes.map((e) => {
      const title = e.link ? `[${cell(e.title)}](${e.link})` : cell(e.title);
      const progress = e.finished
        ? "finished"
        : e.durationSec > 0
        ? `${Math.round(e.progress * 100)}% (${clock(e.positionSec)} of ${
          clock(e.durationSec)
        })`
        : clock(e.positionSec);
      return `| ${e.lastActivityAt.slice(0, 16).replace("T", " ")} | ${
        cell(e.podcast)
      } | ${title} | ${progress} |`;
    }),
    "",
  );
  return lines.join("\n");
}
