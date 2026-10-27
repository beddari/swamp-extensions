/**
 * `@beddari/gpodder/library` — a gPodder library as swamp data: its
 * subscriptions, its episodes and their files, what was newly downloaded,
 * what was listened to, and how healthy the feeds are. Reads gPodder's
 * database read-only and never writes it.
 *
 * `downloads` is the method the ingest workflow starts from: it records the
 * episodes downloaded since its last run, keeps a cursor of what it has seen,
 * and leaves transcription and enrichment to the steps that follow. gPodder
 * records no download time, so "new" means downloaded and not in the cursor.
 *
 * `feedHealth` fetches every subscribed feed and probes its newest
 * enclosures, records one `feedHealth` record per feed and one `healthCheck`
 * with every incident, and logs each error and warning, so a scheduled run
 * leaves a trail without anyone reading the data.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  type Episode,
  type EpisodeState,
  expandHome,
  type FeedAuth,
  type GpodderPaths,
  inRepo,
  type Library,
  openLibrary,
  type Podcast,
  resolvePaths,
  STATES,
} from "./gpodder_db.ts";
import {
  feedIncidents,
  fetchUrl,
  type Incident,
  INCIDENT_KINDS,
  mapLimit,
  parseFeed,
  probeEnclosure,
  SEVERITIES,
  type Severity,
} from "./feeds.ts";
import { ListeningSchema, renderListening, summarise } from "./listening.ts";

/** Global arguments: where gPodder is, and how feeds are fetched. */
export const GlobalArgsSchema = z.object({
  home: z.string().optional().describe(
    "gPodder's home directory, holding Database. Default: $GPODDER_HOME, else ~/Library/Application Support/gPodder " +
      "on macOS, else ~/gPodder, as gPodder itself decides. A relative path is taken from the repository root",
  ),
  downloads: z.string().optional().describe(
    "gPodder's download directory. Default: $GPODDER_DOWNLOAD_DIR, else <home>/Downloads",
  ),
  busyTimeoutMs: z.coerce.number().int().min(0).default(5000).describe(
    "How long a read waits for a gPodder that is writing its database",
  ),
  httpTimeoutMs: z.coerce.number().int().min(1000).default(20000).describe(
    "Per-request timeout for feeds and enclosures, in milliseconds",
  ),
  concurrency: z.coerce.number().int().min(1).max(32).default(4).describe(
    "Feeds fetched at once by feedHealth",
  ),
  maxFeedBytes: z.coerce.number().int().min(65536).default(8_388_608).describe(
    "Bytes of a feed read at most; a larger feed is read up to here",
  ),
});

/** Resolved global arguments. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Handle returned by `writeResource`. */
export interface DataHandle {
  /** The data name. */
  name: string;
}

/** The subset of the swamp logger the models use. */
export interface Logger {
  /** Log at info level. */
  info(message: string, props?: Record<string, unknown>): void;
  /** Log at warning level. */
  warning(message: string, props?: Record<string, unknown>): void;
}

/** One data record as `queryData` and `readModelData` return it. */
export interface DataRecord {
  /** The data name. */
  name: string;
  /** The resource spec the record was written to. */
  specName?: string;
  /** The record's content. */
  attributes: Record<string, unknown>;
  /** The record's tags. */
  tags?: Record<string, string>;
}

/** The subset of the swamp method context this model uses. */
export interface ModelContext {
  /** The definition's global arguments, resolved. */
  globalArgs: GlobalArgs;
  /** The method's logger. */
  logger: Logger;
  /** Aborted when the run is cancelled. */
  signal?: AbortSignal;
  /** The repository root. */
  repoDir?: string;
  /** Record one resource. */
  writeResource(
    specName: string,
    name: string,
    data: Record<string, unknown>,
    overrides?: { tags?: Record<string, string> },
  ): Promise<DataHandle>;
  /** The latest version of one of this definition's resources. */
  readResource?(name: string): Promise<Record<string, unknown> | null>;
  /** Records across the repository matching a CEL predicate. */
  queryData?(predicate: string): Promise<unknown[]>;
}

/** What every `execute` returns. */
export interface MethodResult {
  /** What the method wrote. */
  dataHandles: DataHandle[];
}

/** Result of a pre-flight check. */
export interface CheckResult {
  /** Whether the check passed. */
  pass: boolean;
  /** Why it did not. */
  errors?: string[];
}

const LinkSchema = z.object({ text: z.string(), url: z.string() });

const ChapterSchema = z.object({
  startSec: z.number(),
  title: z.string(),
});

/** A subscription, without its credentials. */
export const PodcastSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  url: z.string(),
  link: z.string(),
  description: z.string(),
  section: z.string(),
  coverUrl: z.string().nullable(),
  paused: z.boolean(),
  hasAuth: z.boolean().describe(
    "The feed needs credentials; they are never recorded",
  ),
  downloadFolder: z.string(),
});

/** An episode, with its podcast and its file. */
export const EpisodeSchema = z.object({
  id: z.number().int(),
  podcastId: z.number().int(),
  podcast: z.string(),
  podcastUrl: z.string(),
  section: z.string(),
  guid: z.string(),
  title: z.string(),
  url: z.string(),
  link: z.string(),
  published: z.string().nullable(),
  state: z.enum(STATES),
  isNew: z.boolean().describe(
    "gPodder's new: not downloaded, not played, not deleted",
  ),
  played: z.boolean(),
  locked: z.boolean().describe(
    "Kept from automatic cleanup (gPodder's archive flag)",
  ),
  finished: z.boolean(),
  durationSec: z.number(),
  positionSec: z.number(),
  positionUpdatedAt: z.string().nullable(),
  lastPlaybackAt: z.string().nullable(),
  fileSize: z.number(),
  mimeType: z.string(),
  file: z.string().nullable(),
  fileExists: z.boolean(),
  notes: z.string().describe("Show notes as Markdown-flavoured text"),
  links: z.array(LinkSchema),
  chapters: z.array(ChapterSchema).describe("Chapters the feed published"),
  artUrl: z.string().nullable(),
});

const EpisodeListSchema = z.object({
  state: z.string(),
  count: z.number().int(),
  truncated: z.boolean(),
  episodeIds: z.array(z.number().int()),
});

const CursorSchema = z.object({
  downloadedIds: z.array(z.number().int()),
  attempts: z.array(z.object({ id: z.number().int(), count: z.number().int() }))
    .describe("How often each episode not yet done was returned"),
  updatedAt: z.string(),
});

const DownloadsSchema = z.object({
  batchId: z.string(),
  baseline: z.boolean().describe(
    "The first run: the library as it stood was taken as seen",
  ),
  count: z.number().int(),
  episodeIds: z.array(z.number().int()),
  retried: z.array(z.number().int()).describe(
    "Returned before and returned again: not yet done in every pendingFor definition",
  ),
  gaveUp: z.array(z.number().int()).describe(
    "Not done after maxAttempts; no longer returned",
  ),
  truncated: z.boolean().describe(
    "More due downloads than limit; the rest come next run",
  ),
  pending: z.number().int(),
});

const IncidentSchema = z.object({
  kind: z.enum(INCIDENT_KINDS),
  severity: z.enum(SEVERITIES),
  podcastId: z.number().int(),
  podcast: z.string(),
  url: z.string(),
  detail: z.string(),
});

const ProbeSchema = z.object({
  url: z.string(),
  status: z.number().int().nullable(),
  latencyMs: z.number().int().nullable(),
  error: z.string().nullable(),
});

const FeedHealthSchema = z.object({
  checkId: z.string(),
  podcastId: z.number().int(),
  podcast: z.string(),
  url: z.string(),
  status: z.number().int().nullable(),
  finalUrl: z.string(),
  permanentRedirect: z.string().nullable(),
  contentType: z.string().nullable(),
  latencyMs: z.number().int().nullable(),
  error: z.string().nullable(),
  feedKind: z.enum(["rss", "atom"]).nullable(),
  items: z.number().int(),
  newestPublished: z.string().nullable(),
  publishesTranscripts: z.boolean(),
  enclosures: z.array(ProbeSchema),
  incidents: z.array(IncidentSchema),
  healthy: z.boolean().describe("No error-severity incident"),
});

const HealthCheckSchema = z.object({
  checkId: z.string(),
  checkedAt: z.string(),
  podcasts: z.number().int(),
  healthy: z.number().int(),
  counts: z.object({
    error: z.number().int(),
    warning: z.number().int(),
    info: z.number().int(),
  }),
  incidents: z.array(IncidentSchema),
});

/** A record type for an incident. */
export type IncidentRecord = z.infer<typeof IncidentSchema>;

/** A feed's health record. */
export type FeedHealth = z.infer<typeof FeedHealthSchema>;

/** A health check's summary record. */
export type HealthCheck = z.infer<typeof HealthCheckSchema>;

function paths(context: ModelContext): GpodderPaths {
  return resolvePaths(context.globalArgs, context.repoDir);
}

function open(context: ModelContext): Library {
  return openLibrary(paths(context), context.globalArgs.busyTimeoutMs);
}

function withLibrary<T>(context: ModelContext, fn: (lib: Library) => T): T {
  const lib = open(context);
  try {
    return fn(lib);
  } finally {
    lib.close();
  }
}

/**
 * An episode as recorded: its URLs without user info, like every URL this
 * model records.
 */
function episodeRecord(e: Episode): Record<string, unknown> {
  return {
    ...e,
    url: redactUrl(e.url),
    podcastUrl: redactUrl(e.podcastUrl),
  };
}

const checks = {
  "database-readable": {
    description:
      "gPodder's database is where the definition says, readable, and has gPodder's tables",
    execute: (
      context: {
        globalArgs: z.input<typeof GlobalArgsSchema>;
        repoDir?: string;
      },
    ): Promise<CheckResult> => {
      try {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const lib = openLibrary(
          resolvePaths(g, context.repoDir),
          g.busyTimeoutMs,
        );
        lib.close();
        return Promise.resolve({ pass: true });
      } catch (err) {
        return Promise.resolve({
          pass: false,
          errors: [err instanceof Error ? err.message : String(err)],
        });
      }
    },
  },
};

const EpisodesArgs = z.object({
  state: z.enum(["downloaded", "new", "deleted", "all"]).default("downloaded")
    .describe(
      "downloaded: files on disk; new: gPodder's new episodes; all: every episode",
    ),
  podcastIds: z.array(z.number().int()).optional().describe(
    "Only these podcasts; every podcast when omitted",
  ),
  limit: z.coerce.number().int().min(1).max(5000).default(500).describe(
    "The newest this many, by publication date",
  ),
});

const DownloadsArgs = z.object({
  backfill: z.coerce.number().int().min(0).default(0).describe(
    "On the first run only: also return this many of the newest downloads instead of taking them all as seen",
  ),
  limit: z.coerce.number().int().min(1).max(500).default(25).describe(
    "New downloads returned at most per run; the rest stay new for the next",
  ),
  pendingFor: z.array(z.string()).default([]).describe(
    "Definitions, e.g. a transcriber and an enricher, whose record of an episode (episodeId and guid) means it is done. " +
      "Until each has one, an episode returned earlier is returned again, so a failed step is retried",
  ),
  maxAttempts: z.coerce.number().int().min(1).default(3).describe(
    "How often an episode is returned before it is given up on",
  ),
});

const ListeningArgs = z.object({
  days: z.coerce.number().int().min(1).max(366).default(7).describe(
    "Length of the window, ending at until",
  ),
  until: z.string().optional().describe(
    "End of the window, ISO 8601; now when omitted",
  ),
  outputDir: z.string().optional().describe(
    "Also write the summary as <outputDir>/<YYYY-Www>.md, e.g. into a notes repository; " +
      "a relative path is taken from the repository root",
  ),
});

const FeedHealthArgs = z.object({
  podcastIds: z.array(z.number().int()).optional().describe(
    "Only these podcasts; every subscription when omitted",
  ),
  includePaused: z.boolean().default(false).describe(
    "Also check subscriptions gPodder has paused",
  ),
  enclosures: z.coerce.number().int().min(0).max(10).default(1).describe(
    "Newest enclosures probed per feed, with HEAD; 0 probes none",
  ),
  staleDays: z.coerce.number().int().min(1).default(120).describe(
    "A feed whose newest episode is older than this is stale",
  ),
  transcriptTag: z.boolean().default(true).describe(
    "Report feeds that publish no <podcast:transcript>, as info",
  ),
  checkDownloads: z.boolean().default(true).describe(
    "Report downloaded episodes whose file is gone",
  ),
  transcriber: z.string().optional().describe(
    "Name of a @beddari/gpodder/transcriber definition: report downloaded episodes it has not transcribed",
  ),
  failOn: z.enum(["none", "error", "warning"]).default("none").describe(
    "Fail the method, after recording everything, on an incident of at least this severity",
  ),
});

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function writer(context: ModelContext) {
  const handles: DataHandle[] = [];
  return {
    handles,
    async write(
      spec: string,
      name: string,
      data: Record<string, unknown>,
      tags?: Record<string, string>,
    ): Promise<void> {
      handles.push(
        await context.writeResource(
          spec,
          name,
          data,
          tags ? { tags } : undefined,
        ),
      );
    },
  };
}

/** The window a listening run covers. */
export function window(
  args: { days: number; until?: string },
  now = new Date(),
): { from: Date; to: Date } {
  const to = args.until ? new Date(args.until) : now;
  if (Number.isNaN(to.getTime())) {
    throw new Error(`until is not a date: ${args.until}`);
  }
  return { from: new Date(to.getTime() - args.days * 86_400_000), to };
}

/** Basic credentials as an Authorization header value. */
function basic(auth: FeedAuth | undefined): Record<string, string> {
  if (!auth) return {};
  const bytes = new TextEncoder().encode(`${auth.username}:${auth.password}`);
  return { authorization: `Basic ${btoa(String.fromCharCode(...bytes))}` };
}

/** Remove a feed password from a string that might echo it. */
function mask(s: string, auth: FeedAuth | undefined): string {
  return auth && auth.password ? s.split(auth.password).join("***") : s;
}

/** A feed URL without user info, which gPodder sometimes keeps in it. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
    }
    return u.toString();
  } catch {
    return url;
  }
}

async function checkFeed(
  podcast: Podcast,
  auth: FeedAuth | undefined,
  args: z.infer<typeof FeedHealthArgs>,
  g: GlobalArgs,
  checkId: string,
  now: Date,
  signal?: AbortSignal,
): Promise<FeedHealth> {
  const fetched = await fetchUrl(podcast.url, {
    headers: basic(auth),
    timeoutMs: g.httpTimeoutMs,
    maxBytes: g.maxFeedBytes,
    signal,
  });
  const parsed = fetched.body !== null && fetched.status !== null &&
      fetched.status < 400
    ? parseFeed(fetched.body)
    : null;
  const urls = (parsed?.items ?? [])
    .map((i) => i.enclosureUrl)
    .filter((u): u is string => !!u)
    .slice(0, args.enclosures);
  const probes = [];
  // A private feed's media often sits behind the same credentials; they go
  // to the feed's own origin and nowhere else.
  const feedOrigin = new URL(podcast.url).origin;
  for (const u of urls) {
    const same = URL.canParse(u) && new URL(u).origin === feedOrigin;
    probes.push(
      await probeEnclosure(u, g.httpTimeoutMs, signal, same ? basic(auth) : {}),
    );
  }
  const url = redactUrl(podcast.url);
  const incidents = feedIncidents(
    { id: podcast.id, title: podcast.title, url },
    {
      ...fetched,
      permanentRedirect: fetched.permanentRedirect &&
        redactUrl(fetched.permanentRedirect),
      error: fetched.error && mask(fetched.error, auth),
    },
    parsed,
    probes,
    { staleDays: args.staleDays, now, transcriptTag: args.transcriptTag },
  ).map((i) => ({ ...i, url: redactUrl(i.url) }));
  const newest = (parsed?.items ?? [])
    .map((i) => i.published)
    .filter((d): d is string => d !== null)
    .sort()
    .at(-1) ?? null;
  return {
    checkId,
    podcastId: podcast.id,
    podcast: podcast.title,
    url,
    status: fetched.status,
    finalUrl: redactUrl(fetched.finalUrl),
    permanentRedirect: fetched.permanentRedirect &&
      redactUrl(fetched.permanentRedirect),
    contentType: fetched.contentType,
    latencyMs: fetched.latencyMs,
    error: fetched.error && mask(fetched.error, auth),
    feedKind: parsed?.kind ?? null,
    items: parsed?.items.length ?? 0,
    newestPublished: newest,
    publishesTranscripts: (parsed?.items ?? []).some((i) =>
      i.transcripts.length > 0
    ),
    enclosures: probes.map((p) => ({
      url: redactUrl(p.url),
      status: p.status,
      latencyMs: p.latencyMs,
      error: p.error,
    })),
    incidents,
    healthy: !incidents.some((i) => i.severity === "error"),
  };
}

/**
 * A test for "done": every named definition holds a record whose
 * `episodeId` and `guid` are the episode's.
 */
async function doneEpisodes(
  context: ModelContext,
  definitions: string[],
): Promise<(e: Episode) => boolean> {
  if (!context.queryData) {
    throw new Error("this swamp cannot query data from a method");
  }
  const sets: Set<string>[] = [];
  for (const name of definitions) {
    const rows = await context.queryData(
      `modelName == ${JSON.stringify(name)}`,
    ) as DataRecord[];
    sets.push(
      new Set(
        rows.map((r) => `${r.attributes.episodeId} ${r.attributes.guid}`),
      ),
    );
  }
  return (e) => sets.every((set) => set.has(`${e.id} ${e.guid}`));
}

/** The episode ids a transcriber definition has transcripts for. */
async function transcribedIds(
  context: ModelContext,
  transcriber: string,
): Promise<Set<number>> {
  if (!context.queryData) {
    throw new Error("this swamp cannot query data from a method");
  }
  const rows = await context.queryData(
    `modelName == ${JSON.stringify(transcriber)} && specName == "transcript"`,
  ) as DataRecord[];
  return new Set(
    rows.map((r) => Number(r.attributes.episodeId)).filter(Number.isFinite),
  );
}

/** Downloads that are not what they should be: gone, or not transcribed. */
export function downloadIncidents(
  downloaded: Episode[],
  opts: {
    checkFiles: boolean;
    transcribed?: Set<number>;
    transcriber?: string;
  },
): Incident[] {
  const out: Incident[] = [];
  for (const e of downloaded) {
    const base = {
      podcastId: e.podcastId,
      podcast: e.podcast,
      url: redactUrl(e.url),
    };
    if (opts.checkFiles && !e.fileExists) {
      out.push({
        ...base,
        kind: "download-file-missing",
        severity: "warning",
        detail: `${e.title}: gPodder lists it as downloaded, but ${
          e.file ?? "its file"
        } is not there`,
      });
    } else if (opts.transcribed && !opts.transcribed.has(e.id)) {
      out.push({
        ...base,
        kind: "download-not-transcribed",
        severity: "info",
        detail:
          `${e.title} (episode ${e.id}) has no transcript in ${opts.transcriber}`,
      });
    }
  }
  return out;
}

/** A gPodder library, read from its database. */
export const model = {
  type: "@beddari/gpodder/library",
  version: "2026.10.27.1",
  globalArguments: GlobalArgsSchema,
  checks,
  reports: [
    "@beddari/gpodder/listening-report",
    "@beddari/gpodder/feed-health-report",
  ],
  resources: {
    podcast: {
      description: "One subscription, without its credentials",
      schema: PodcastSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    episode: {
      description:
        "One episode: its podcast, state, playback position, file and show notes",
      schema: EpisodeSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    episodeList: {
      description:
        "Which episodes one episodes run returned, and whether it stopped at its limit",
      schema: EpisodeListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    cursor: {
      description: "The downloaded episodes downloads has already returned",
      schema: CursorSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    downloads: {
      description: "One downloads run: which episodes were new",
      schema: DownloadsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    listening: {
      description: "What was played in one window of time",
      schema: ListeningSchema,
      lifetime: "infinite" as const,
      garbageCollection: 60,
    },
    feedHealth: {
      description:
        "One feed's fetch, its newest enclosures and its incidents, from one health check",
      schema: FeedHealthSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    healthCheck: {
      description: "One health check: every incident across the library",
      schema: HealthCheckSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
  },
  methods: {
    podcasts: {
      kind: "list" as const,
      description:
        "Record every subscription, without its credentials. Read-only.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const podcasts = withLibrary(context, (lib) => lib.podcasts());
        const out = writer(context);
        for (const p of podcasts) {
          await out.write("podcast", `podcast-${p.id}`, {
            ...p,
            url: redactUrl(p.url),
          });
        }
        context.logger.info("stored {count} podcasts", {
          count: podcasts.length,
        });
        return { dataHandles: out.handles };
      },
    },
    episodes: {
      kind: "list" as const,
      description:
        "Record episodes by state, newest first, one record each. Read-only.",
      arguments: EpisodesArgs,
      execute: async (
        raw: z.input<typeof EpisodesArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const args = EpisodesArgs.parse(raw);
        const states: EpisodeState[] | undefined = args.state === "all"
          ? undefined
          : args.state === "new"
          ? ["normal"]
          : [args.state];
        // gPodder's new is a state and a flag; the flag is filtered here, so
        // the limit applies after it rather than in the query.
        const found = withLibrary(context, (lib) =>
          lib.episodes({
            states,
            podcastIds: args.podcastIds,
            limit: args.state === "new" ? undefined : args.limit + 1,
          })).filter((e) => args.state !== "new" || e.isNew);
        const episodes = found.slice(0, args.limit);
        const out = writer(context);
        for (const e of episodes) {
          await out.write("episode", `episode-${e.id}`, episodeRecord(e));
        }
        await out.write("episodeList", "episodes", {
          state: args.state,
          count: episodes.length,
          truncated: found.length > args.limit,
          episodeIds: episodes.map((e) => e.id),
        });
        context.logger.info("stored {count} {state} episodes", {
          count: episodes.length,
          state: args.state,
        });
        return { dataHandles: out.handles };
      },
    },
    downloads: {
      kind: "list" as const,
      description:
        "Record the episodes downloaded since the last run, newest first, and advance the cursor. With pendingFor, " +
        "an episode returned earlier comes back until those definitions all have a record of it, up to maxAttempts. " +
        "The first run takes the library as seen, less backfill. Reads gPodder only.",
      arguments: DownloadsArgs,
      execute: async (
        raw: z.input<typeof DownloadsArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const args = DownloadsArgs.parse(raw);
        const cursor = await context.readResource?.("cursor") as
          | z.infer<typeof CursorSchema>
          | null
          | undefined;
        const downloaded = withLibrary(
          context,
          (lib) => lib.episodes({ states: ["downloaded"] }),
        );
        const onDisk = downloaded.filter((e) => e.fileExists);
        const baseline = !cursor;
        const seen = new Set(cursor?.downloadedIds ?? []);
        const attempts = new Map(
          (cursor?.attempts ?? []).map((a) => [a.id, a.count]),
        );
        const done = args.pendingFor.length
          ? await doneEpisodes(context, args.pendingFor)
          : null;
        const isDone = (e: Episode) => done === null || done(e);
        // Returned before, not yet done everywhere, attempts left: due again.
        const due = (e: Episode) =>
          seen.has(e.id) && attempts.has(e.id) && !isDone(e) &&
          (attempts.get(e.id) ?? 0) < args.maxAttempts;
        const fresh = baseline
          ? onDisk.slice(0, args.backfill)
          : onDisk.filter((e) => !seen.has(e.id));
        const retry = baseline || done === null ? [] : onDisk.filter(due);
        const candidates = [...fresh, ...retry];
        const emitted = candidates.slice(0, args.limit);
        const gaveUp = done === null
          ? []
          : onDisk.filter((e) =>
            attempts.has(e.id) && !isDone(e) &&
            (attempts.get(e.id) ?? 0) >= args.maxAttempts
          );
        // Written first, so a run that fails here records nothing new; the
        // cursor last, so a run that fails before it returns the same
        // episodes again.
        const batchId = crypto.randomUUID();
        const out = writer(context);
        for (const e of emitted) {
          await out.write("episode", `episode-${e.id}`, episodeRecord(e), {
            batch: batchId,
          });
        }
        // The cursor keeps what is still downloaded and was seen, plus what
        // this run returned; on the first run, everything on disk. An episode
        // deleted and downloaded again is new again. Attempts are counted
        // only for episodes that pendingFor tracks and that are not done.
        const still = new Set(onDisk.map((e) => e.id));
        const next = baseline
          ? onDisk.map((e) => e.id)
          : [...seen].filter((id) => still.has(id))
            .concat(emitted.map((e) => e.id));
        if (done !== null) {
          for (const e of emitted) {
            attempts.set(e.id, (attempts.get(e.id) ?? 0) + 1);
          }
          for (const e of onDisk) if (isDone(e)) attempts.delete(e.id);
        }
        await out.write("downloads", "downloads", {
          batchId,
          baseline,
          count: emitted.length,
          episodeIds: emitted.map((e) => e.id),
          retried: emitted.filter((e) => seen.has(e.id)).map((e) => e.id),
          gaveUp: gaveUp.map((e) => e.id),
          truncated: candidates.length > emitted.length,
          pending: candidates.length - emitted.length,
        }, { batch: batchId });
        await out.write("cursor", "cursor", {
          downloadedIds: [...new Set(next)].sort((a, b) => a - b),
          attempts: [...attempts]
            .filter(([id]) => still.has(id))
            .sort(([a], [b]) => a - b)
            .map(([id, count]) => ({ id, count })),
          updatedAt: new Date().toISOString(),
        });
        for (const e of gaveUp) {
          context.logger.warning(
            "episode {id} ({title}) not done after {count} attempts; not retried",
            { id: e.id, title: e.title, count: attempts.get(e.id) },
          );
        }
        context.logger.info(
          baseline
            ? "first run: {seen} downloads taken as seen, {count} returned"
            : "{count} downloads returned ({retried} again), {pending} left for the next run",
          {
            seen: onDisk.length,
            count: emitted.length,
            retried: emitted.filter((e) => seen.has(e.id)).length,
            pending: candidates.length - emitted.length,
          },
        );
        return { dataHandles: out.handles };
      },
    },
    listening: {
      kind: "list" as const,
      description:
        "Record what was played in a window ending now (or at until): episodes, progress and per-podcast totals. " +
        "Reads gPodder only; with outputDir, also writes the week's Markdown page there.",
      arguments: ListeningArgs,
      execute: async (
        raw: z.input<typeof ListeningArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const args = ListeningArgs.parse(raw);
        const { from, to } = window(args);
        const episodes = withLibrary(
          context,
          (lib) => lib.episodes({ activeSince: from }),
        );
        const summary = summarise(episodes, from, to);
        // The page first: a write that fails then fails the method before
        // anything is recorded.
        if (args.outputDir) {
          const dir = expandHome(inRepo(args.outputDir, context.repoDir));
          await Deno.mkdir(dir, { recursive: true });
          await Deno.writeTextFile(
            `${dir}/${summary.label}.md`,
            renderListening(summary),
          );
        }
        const out = writer(context);
        await out.write(
          "listening",
          `listening-${summary.label.toLowerCase()}`,
          summary,
        );
        context.logger.info(
          "{label}: {episodes} episodes, {finished} finished",
          {
            label: summary.label,
            episodes: summary.totals.episodes,
            finished: summary.totals.finished,
          },
        );
        return { dataHandles: out.handles };
      },
    },
    feedHealth: {
      kind: "list" as const,
      description:
        "Fetch every subscribed feed, probe its newest enclosures, check downloads, and record the incidents; " +
        "each error and warning is also logged. Reads feeds and gPodder only.",
      arguments: FeedHealthArgs,
      execute: async (
        raw: z.input<typeof FeedHealthArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const args = FeedHealthArgs.parse(raw);
        const g = context.globalArgs;
        const { podcasts, auth, downloaded } = withLibrary(context, (lib) => ({
          podcasts: lib.podcasts(),
          auth: lib.auth(),
          downloaded: args.checkDownloads || args.transcriber
            ? lib.episodes({ states: ["downloaded"] })
            : [],
        }));
        const wanted = podcasts.filter((p) =>
          (args.podcastIds ? args.podcastIds.includes(p.id) : true) &&
          (args.includePaused || !p.paused)
        );
        const checkId = crypto.randomUUID();
        const now = new Date();
        context.logger.info("checking {count} feeds", { count: wanted.length });
        const feeds = await mapLimit(
          wanted,
          g.concurrency,
          (p) =>
            checkFeed(
              p,
              auth.find((a) => a.podcastId === p.id),
              args,
              g,
              checkId,
              now,
              context.signal,
            ),
        );
        // A cancelled run leaves every feed it did not reach "unreachable";
        // that is not a health check, so nothing is recorded.
        if (context.signal?.aborted) {
          throw new Error("feedHealth was cancelled; nothing recorded");
        }
        const ids = new Set(wanted.map((p) => p.id));
        const transcribed = args.transcriber
          ? await transcribedIds(context, args.transcriber)
          : undefined;
        const downloads = downloadIncidents(
          downloaded.filter((e) => ids.has(e.podcastId)),
          {
            checkFiles: args.checkDownloads,
            transcribed,
            transcriber: args.transcriber,
          },
        );
        const incidents = [...feeds.flatMap((f) => f.incidents), ...downloads]
          .sort((a, b) =>
            RANK[a.severity] - RANK[b.severity] || a.podcastId - b.podcastId ||
            a.kind.localeCompare(b.kind)
          );
        const out = writer(context);
        for (const f of feeds) {
          await out.write("feedHealth", `feed-${f.podcastId}`, f, {
            check: checkId,
          });
        }
        const counts = { error: 0, warning: 0, info: 0 };
        for (const i of incidents) counts[i.severity]++;
        await out.write("healthCheck", "health-check", {
          checkId,
          checkedAt: now.toISOString(),
          podcasts: feeds.length,
          healthy: feeds.filter((f) => f.healthy).length,
          counts,
          incidents,
        }, { check: checkId });
        for (const i of incidents) {
          if (i.severity !== "info") {
            context.logger.warning("{severity} {kind} {podcast}: {detail}", {
              ...i,
            });
          }
        }
        context.logger.info(
          "{healthy} of {podcasts} feeds healthy; {error} errors, {warning} warnings, {info} notes",
          {
            healthy: feeds.filter((f) => f.healthy).length,
            podcasts: feeds.length,
            ...counts,
          },
        );
        const worst = args.failOn === "none" ? -1 : RANK[args.failOn];
        const failing = incidents.filter((i) => RANK[i.severity] <= worst);
        if (failing.length > 0) {
          throw new Error(
            `${failing.length} incidents at ${args.failOn} or worse; see the healthCheck record`,
          );
        }
        return { dataHandles: out.handles };
      },
    },
  },
};
