/**
 * gPodder's own storage, read and never written: where it keeps its database
 * and downloads, and the podcasts and episodes in that database as plain
 * records.
 *
 * gPodder keeps everything in one SQLite file, `Database`, under its home
 * directory, and every downloaded file under `Downloads/<podcast folder>/`.
 * The home is `$GPODDER_HOME`, else `~/Library/Application Support/gPodder`
 * on macOS, else `~/gPodder`; the downloads are `$GPODDER_DOWNLOAD_DIR`, else
 * `<home>/Downloads`. These are gPodder's own rules (`gpodder/__init__.py`).
 *
 * The database is opened read-only with a busy timeout, so a running gPodder
 * that holds a write lock delays a read rather than failing it, and nothing
 * here can change what gPodder sees. Written against schema version 8
 * (gPodder 3.11); columns that older schemas lack read as empty.
 *
 * @module
 */
import { DatabaseSync } from "node:sqlite";
import { type NoteLink, notesFromHtml } from "./notes.ts";

/** gPodder's episode states (`gpodder.STATE_*`). */
export const STATES = ["normal", "downloaded", "deleted"] as const;

/** One of {@link STATES}. */
export type EpisodeState = typeof STATES[number];

/** Where gPodder keeps its database and its downloads. */
export interface GpodderPaths {
  home: string;
  database: string;
  downloads: string;
}

/** The parts of the process environment the paths depend on. */
export interface PathEnv {
  get(name: string): string | undefined;
  os: string;
  exists(path: string): boolean;
}

const denoEnv: PathEnv = {
  get: (name) => Deno.env.get(name),
  os: Deno.build.os,
  exists: (path) => {
    try {
      Deno.statSync(path);
      return true;
    } catch {
      return false;
    }
  },
};

/** `~/x` as an absolute path; anything else unchanged. */
export function expandHome(path: string, env: PathEnv = denoEnv): string {
  if (path !== "~" && !path.startsWith("~/")) return path;
  const home = env.get("HOME");
  if (!home) throw new Error(`cannot expand ${path}: HOME is not set`);
  return home + path.slice(1);
}

/**
 * A relative path taken from the repository root rather than whatever
 * directory swamp started in; absolute and `~/` paths are left as they are.
 */
export function inRepo(path: string, repoDir?: string): string {
  if (!repoDir || path.startsWith("/") || path.startsWith("~")) return path;
  return `${repoDir.replace(/\/+$/, "")}/${path}`;
}

/**
 * gPodder's home, database and downloads, by gPodder's own rules unless the
 * definition names them. On macOS gPodder moved its home from `~/gPodder` to
 * `~/Library/Application Support/gPodder` and keeps the old one only while
 * the new one does not exist; the same choice is made here.
 */
export function resolvePaths(
  given: { home?: string; downloads?: string },
  repoDir?: string,
  env: PathEnv = denoEnv,
): GpodderPaths {
  const full = (p: string) => expandHome(inRepo(p, repoDir), env);
  let home = given.home ?? env.get("GPODDER_HOME");
  if (!home) {
    const old = expandHome("~/gPodder", env);
    const mac = expandHome("~/Library/Application Support/gPodder", env);
    home = env.os === "darwin" && (!env.exists(old) || env.exists(mac))
      ? mac
      : old;
  }
  home = full(home).replace(/\/+$/, "");
  const downloads = given.downloads ?? env.get("GPODDER_DOWNLOAD_DIR") ??
    `${home}/Downloads`;
  return {
    home,
    database: `${home}/Database`,
    downloads: full(downloads).replace(/\/+$/, ""),
  };
}

/** One subscription. Its credentials are never part of it. */
export interface Podcast {
  id: number;
  title: string;
  url: string;
  link: string;
  description: string;
  section: string;
  coverUrl: string | null;
  paused: boolean;
  hasAuth: boolean;
  downloadFolder: string;
}

/** A chapter mark, from the feed or from a transcript. */
export interface Chapter {
  startSec: number;
  title: string;
}

/** One episode, joined with its podcast and its file on disk. */
export interface Episode {
  id: number;
  podcastId: number;
  podcast: string;
  podcastUrl: string;
  section: string;
  guid: string;
  title: string;
  url: string;
  link: string;
  published: string | null;
  state: EpisodeState;
  isNew: boolean;
  played: boolean;
  locked: boolean;
  finished: boolean;
  durationSec: number;
  positionSec: number;
  positionUpdatedAt: string | null;
  lastPlaybackAt: string | null;
  fileSize: number;
  mimeType: string;
  file: string | null;
  fileExists: boolean;
  notes: string;
  links: NoteLink[];
  chapters: Chapter[];
  artUrl: string | null;
}

/** HTTP basic credentials of one subscription, for fetching its feed. */
export interface FeedAuth {
  podcastId: number;
  username: string;
  password: string;
}

/** An open, read-only gPodder database. */
export interface Library {
  schemaVersion: number;
  podcasts(): Podcast[];
  episodes(filter?: EpisodeFilter): Episode[];
  auth(): FeedAuth[];
  close(): void;
}

/** Which episodes to read; every field narrows, none means all. */
export interface EpisodeFilter {
  states?: EpisodeState[];
  podcastIds?: number[];
  ids?: number[];
  /** Only episodes played or positioned at or after this time. */
  activeSince?: Date;
  /** The newest this many, by publication date. */
  limit?: number;
}

const EPISODE_COLUMNS = [
  "id",
  "podcast_id",
  "title",
  "description",
  "url",
  "published",
  "guid",
  "link",
  "file_size",
  "mime_type",
  "state",
  "is_new",
  "archive",
  "download_filename",
  "total_time",
  "current_position",
  "current_position_updated",
  "last_playback",
  "description_html",
  "episode_art_url",
  "chapters",
];

const PODCAST_COLUMNS = [
  "id",
  "title",
  "url",
  "link",
  "description",
  "cover_url",
  "auth_username",
  "auth_password",
  "download_folder",
  "pause_subscription",
  "section",
];

type Row = Record<string, unknown>;

function iso(seconds: unknown): string | null {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

/**
 * gPodder's chapters column: the feed's chapters as podcastparser parsed them,
 * a JSON list of `{start, title}` with `start` in seconds. Anything else reads
 * as no chapters.
 */
export function parseChapters(raw: unknown): Chapter[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list
      .filter((c) => c && Number.isFinite(Number(c.start)))
      .map((c) => ({ startSec: Number(c.start), title: str(c.title) }))
      .sort((a, b) => a.startSec - b.startSec);
  } catch {
    return [];
  }
}

/**
 * gPodder's own test for a finished episode (`PodcastEpisode.is_finished`):
 * a position within the last ten seconds or past 99 percent.
 */
export function isFinished(positionSec: number, durationSec: number): boolean {
  return positionSec > 0 && durationSec > 0 &&
    (positionSec + 10 >= durationSec || positionSec >= durationSec * 0.99);
}

/** The columns a table has, so an older schema reads with blanks. */
function columns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
  return new Set(rows.map((r) => String(r.name)));
}

function select(have: Set<string>, wanted: string[], alias: string): string {
  return wanted
    .map((c) => have.has(c) ? `${alias}.${c} AS ${c}` : `NULL AS ${c}`)
    .join(", ");
}

/**
 * Open gPodder's database read-only. `busyTimeoutMs` is how long a read
 * waits for a gPodder that is writing.
 */
export function openLibrary(
  paths: GpodderPaths,
  busyTimeoutMs = 5000,
  exists: (path: string) => boolean = denoEnv.exists,
): Library {
  if (!exists(paths.database)) {
    throw new Error(
      `no gPodder database at ${paths.database}; set home, or GPODDER_HOME, to gPodder's home directory`,
    );
  }
  const db = new DatabaseSync(paths.database, {
    readOnly: true,
    timeout: busyTimeoutMs,
  });
  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Row[]).map((r) => String(r.name)),
    );
    for (const t of ["podcast", "episode"]) {
      if (!tables.has(t)) {
        throw new Error(
          `${paths.database} is not a gPodder database: no ${t} table`,
        );
      }
    }
    const version = tables.has("version")
      ? Number(
        (db.prepare("SELECT version FROM version").get() as Row | undefined)
          ?.version ?? 0,
      )
      : 0;
    const podcastCols = columns(db, "podcast");
    const episodeCols = columns(db, "episode");
    return {
      schemaVersion: version,
      podcasts: () => readPodcasts(db, podcastCols),
      episodes: (filter = {}) =>
        readEpisodes(db, episodeCols, podcastCols, paths, filter, exists),
      auth: () => readAuth(db, podcastCols),
      close: () => db.close(),
    };
  } catch (err) {
    db.close();
    throw err;
  }
}

function readPodcasts(db: DatabaseSync, have: Set<string>): Podcast[] {
  const rows = db.prepare(
    `SELECT ${select(have, PODCAST_COLUMNS, "p")} FROM podcast p ORDER BY p.id`,
  ).all() as Row[];
  return rows.map((r) => ({
    id: Number(r.id),
    title: str(r.title),
    url: str(r.url),
    link: str(r.link),
    description: str(r.description),
    section: str(r.section),
    coverUrl: r.cover_url ? str(r.cover_url) : null,
    paused: Number(r.pause_subscription) === 1,
    hasAuth: Boolean(r.auth_username),
    downloadFolder: str(r.download_folder),
  }));
}

function readAuth(db: DatabaseSync, have: Set<string>): FeedAuth[] {
  if (!have.has("auth_username")) return [];
  const rows = db.prepare(
    "SELECT id, auth_username, auth_password FROM podcast WHERE auth_username IS NOT NULL AND auth_username != ''",
  ).all() as Row[];
  return rows.map((r) => ({
    podcastId: Number(r.id),
    username: str(r.auth_username),
    password: str(r.auth_password),
  }));
}

function readEpisodes(
  db: DatabaseSync,
  have: Set<string>,
  podcastHave: Set<string>,
  paths: GpodderPaths,
  filter: EpisodeFilter,
  exists: (path: string) => boolean,
): Episode[] {
  const where: string[] = [];
  const params: (number | string)[] = [];
  const list = (column: string, values: number[]) => {
    where.push(`${column} IN (${values.map(() => "?").join(", ")})`);
    params.push(...values);
  };
  if (filter.states) {
    if (filter.states.length === 0) return [];
    list("e.state", filter.states.map((s) => STATES.indexOf(s)));
  }
  if (filter.podcastIds) {
    if (filter.podcastIds.length === 0) return [];
    list("e.podcast_id", filter.podcastIds);
  }
  if (filter.ids) {
    if (filter.ids.length === 0) return [];
    list("e.id", filter.ids);
  }
  if (filter.activeSince) {
    // A schema without playback columns has no activity to find.
    const marks = ["last_playback", "current_position_updated"]
      .filter((c) => have.has(c));
    if (marks.length === 0) return [];
    const since = Math.floor(filter.activeSince.getTime() / 1000);
    where.push(`(${marks.map((c) => `e.${c} >= ?`).join(" OR ")})`);
    params.push(...marks.map(() => since));
  }
  const podcastCol = (c: string, alias: string) =>
    podcastHave.has(c) ? `p.${c} AS ${alias}` : `'' AS ${alias}`;
  const limit = filter.limit !== undefined
    ? ` LIMIT ${Math.max(0, Math.floor(filter.limit))}`
    : "";
  const rows = db.prepare(
    `SELECT ${select(have, EPISODE_COLUMNS, "e")},
            p.title AS podcast_title, p.url AS podcast_url,
            ${podcastCol("section", "podcast_section")},
            ${podcastCol("download_folder", "podcast_folder")}
       FROM episode e JOIN podcast p ON p.id = e.podcast_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY e.published DESC, e.id DESC${limit}`,
  ).all(...params) as Row[];
  return rows.map((r) => toEpisode(r, paths, exists));
}

function toEpisode(
  r: Row,
  paths: GpodderPaths,
  exists: (path: string) => boolean,
): Episode {
  const state = STATES[Number(r.state)] ?? "normal";
  const isNew = Number(r.is_new) === 1;
  const durationSec = Number(r.total_time) || 0;
  const positionSec = Number(r.current_position) || 0;
  // gPodder joins the podcast's folder and the episode's file name under the
  // downloads directory and nothing else; a name that would climb out of
  // that directory is not a file this model will point at.
  const name = str(r.download_filename);
  const folder = str(r.podcast_folder);
  const safe = name !== "" && folder !== "" &&
    ![name, folder].some((p) => p.includes("/") || p === ".." || p === ".");
  const file = safe ? `${paths.downloads}/${folder}/${name}` : null;
  const html = str(r.description_html);
  const notes = notesFromHtml(html !== "" ? html : str(r.description));
  return {
    id: Number(r.id),
    podcastId: Number(r.podcast_id),
    podcast: str(r.podcast_title),
    podcastUrl: str(r.podcast_url),
    section: str(r.podcast_section),
    guid: str(r.guid),
    title: str(r.title),
    url: str(r.url),
    link: str(r.link),
    published: iso(r.published),
    state,
    isNew: state === "normal" && isNew,
    played: !isNew,
    locked: Number(r.archive) === 1,
    finished: isFinished(positionSec, durationSec),
    durationSec,
    positionSec,
    positionUpdatedAt: iso(r.current_position_updated),
    lastPlaybackAt: iso(r.last_playback),
    fileSize: Number(r.file_size) || 0,
    mimeType: str(r.mime_type),
    file,
    fileExists: file !== null && state === "downloaded" && exists(file),
    notes: notes.text,
    links: notes.links,
    chapters: parseChapters(r.chapters),
    artUrl: r.episode_art_url ? str(r.episode_art_url) : null,
  };
}
