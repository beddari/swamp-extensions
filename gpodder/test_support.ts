/**
 * Test helpers: a throwaway gPodder home with a schema-8 database made with
 * gPodder's own `CREATE TABLE` statements, a few podcasts and episodes, and
 * downloaded files; and fake method contexts that keep what a method writes
 * and logs.
 *
 * The one feed password here, {@link FEED_PASSWORD}, is a marker: tests
 * assert it reaches no record, log line or error.
 *
 * @module
 */
import { DatabaseSync } from "node:sqlite";
import type {
  DataHandle,
  DataRecord,
  GlobalArgs,
  ModelContext,
} from "./library.ts";

/** The password of the one feed that needs credentials. */
export const FEED_PASSWORD = "FIXTURE-FEED-PASSWORD";

/** gPodder 3.11's schema, version 8, as `gpodder/schema.py` creates it. */
const SCHEMA = [
  `CREATE TABLE podcast (
    id INTEGER PRIMARY KEY NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    link TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    cover_url TEXT NULL DEFAULT NULL,
    auth_username TEXT NULL DEFAULT NULL,
    auth_password TEXT NULL DEFAULT NULL,
    http_last_modified TEXT NULL DEFAULT NULL,
    http_etag TEXT NULL DEFAULT NULL,
    auto_archive_episodes INTEGER NOT NULL DEFAULT 0,
    download_folder TEXT NOT NULL DEFAULT '',
    pause_subscription INTEGER NOT NULL DEFAULT 0,
    section TEXT NOT NULL DEFAULT '',
    payment_url TEXT NULL DEFAULT NULL,
    download_strategy INTEGER NOT NULL DEFAULT 0,
    sync_to_mp3_player INTEGER NOT NULL DEFAULT 1,
    cover_thumb BLOB NULL DEFAULT NULL
  )`,
  `CREATE TABLE episode (
    id INTEGER PRIMARY KEY NOT NULL,
    podcast_id INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL,
    published INTEGER NOT NULL DEFAULT 0,
    guid TEXT NOT NULL,
    link TEXT NOT NULL DEFAULT '',
    file_size INTEGER NOT NULL DEFAULT 0,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    state INTEGER NOT NULL DEFAULT 0,
    is_new INTEGER NOT NULL DEFAULT 0,
    archive INTEGER NOT NULL DEFAULT 0,
    download_filename TEXT NULL DEFAULT NULL,
    total_time INTEGER NOT NULL DEFAULT 0,
    current_position INTEGER NOT NULL DEFAULT 0,
    current_position_updated INTEGER NOT NULL DEFAULT 0,
    last_playback INTEGER NOT NULL DEFAULT 0,
    payment_url TEXT NULL DEFAULT NULL,
    description_html TEXT NOT NULL DEFAULT '',
    episode_art_url TEXT NULL DEFAULT NULL,
    chapters TEXT NULL DEFAULT NULL
  )`,
  "CREATE TABLE version (version integer)",
  "INSERT INTO version (version) VALUES (8)",
];

/** A fixed "now" for the fixtures: Tuesday 2026-10-27 12:00 UTC. */
export const NOW = new Date("2026-10-27T12:00:00Z");

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** A throwaway gPodder home. */
export interface Home {
  home: string;
  database: string;
  /** Run SQL against the fixture database, to change it mid-test. */
  exec(sql: string, ...params: (string | number | null)[]): void;
  cleanup(): void;
}

/**
 * A gPodder home holding three podcasts: an open feed with two downloaded
 * episodes, one played and one not, plus one new; a feed behind basic auth
 * with one downloaded episode whose file is gone; and a paused feed.
 */
export function makeHome(): Home {
  const home = Deno.makeTempDirSync({ prefix: "gpodder-home-" });
  const database = `${home}/Database`;
  const db = new DatabaseSync(database);
  for (const sql of SCHEMA) db.exec(sql);
  const podcast = db.prepare(
    "INSERT INTO podcast (id, title, url, link, description, auth_username, auth_password, download_folder, pause_subscription, section) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  podcast.run(
    1,
    "Open Feed",
    "http://feeds.test/open.xml",
    "https://open.test",
    "An open show",
    null,
    null,
    "Open Feed",
    0,
    "audio",
  );
  podcast.run(
    2,
    "Private Feed",
    "http://feeds.test/private.xml",
    "",
    "",
    "listener",
    FEED_PASSWORD,
    "Private Feed",
    0,
    "audio",
  );
  podcast.run(
    3,
    "Paused Feed",
    "http://feeds.test/paused.xml",
    "",
    "",
    null,
    null,
    "Paused Feed",
    1,
    "audio",
  );
  const episode = db.prepare(
    `INSERT INTO episode (id, podcast_id, title, description, url, published, guid, link, file_size, mime_type, state, is_new, archive,
       download_filename, total_time, current_position, current_position_updated, last_playback, description_html, chapters)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  episode.run(
    10,
    1,
    "Episode Ten",
    "",
    "http://media.test/10.mp3",
    at("2026-10-20T06:00:00Z"),
    "guid-10",
    "https://open.test/10",
    5,
    "audio/mpeg",
    1,
    0,
    0,
    "10.mp3",
    3600,
    3595,
    at("2026-10-25T20:00:00Z"),
    at("2026-10-25T19:00:00Z"),
    '<p>Ten &amp; more. See <a href="https://example.test/book">the book</a>.</p><ul><li>One</li><li>Two</li></ul>',
    JSON.stringify([{ start: 0, title: "Intro" }, {
      start: 600.5,
      title: "Main",
    }]),
  );
  episode.run(
    11,
    1,
    "Episode Eleven",
    "Plain notes https://example.test/eleven.",
    "http://media.test/11.mp3",
    at("2026-10-26T06:00:00Z"),
    "guid-11",
    "",
    5,
    "audio/mpeg",
    1,
    1,
    0,
    "11.mp3",
    1800,
    0,
    0,
    0,
    "",
    null,
  );
  episode.run(
    12,
    1,
    "Episode Twelve",
    "",
    "http://media.test/12.mp3",
    at("2026-10-27T06:00:00Z"),
    "guid-12",
    "",
    0,
    "audio/mpeg",
    0,
    1,
    0,
    null,
    0,
    0,
    0,
    0,
    "",
    null,
  );
  episode.run(
    20,
    2,
    "Private One",
    "",
    "http://media.test/20.mp3",
    at("2026-09-01T06:00:00Z"),
    "guid-20",
    "",
    5,
    "audio/mpeg",
    1,
    0,
    1,
    "20.mp3",
    2400,
    1200,
    at("2026-10-24T08:00:00Z"),
    at("2026-10-24T07:30:00Z"),
    "",
    null,
  );
  episode.run(
    30,
    3,
    "Old Played",
    "",
    "http://media.test/30.mp3",
    at("2025-01-01T06:00:00Z"),
    "guid-30",
    "",
    0,
    "audio/mpeg",
    2,
    0,
    0,
    null,
    1000,
    1000,
    at("2025-02-01T06:00:00Z"),
    at("2025-02-01T05:00:00Z"),
    "",
    null,
  );
  db.close();
  for (
    const [folder, file] of [["Open Feed", "10.mp3"], ["Open Feed", "11.mp3"]]
  ) {
    Deno.mkdirSync(`${home}/Downloads/${folder}`, { recursive: true });
    Deno.writeFileSync(
      `${home}/Downloads/${folder}/${file}`,
      new Uint8Array([1, 2, 3, 4, 5]),
    );
  }
  return {
    home,
    database,
    exec(sql, ...params) {
      const w = new DatabaseSync(database);
      try {
        w.prepare(sql).run(...params);
      } finally {
        w.close();
      }
    },
    cleanup: () => Deno.removeSync(home, { recursive: true }),
  };
}

/** Library global arguments for a fixture home. */
export function globalArgs(
  home: string,
  overrides: Partial<GlobalArgs> = {},
): GlobalArgs {
  return {
    home,
    busyTimeoutMs: 1000,
    httpTimeoutMs: 2000,
    concurrency: 2,
    maxFeedBytes: 1_000_000,
    ...overrides,
  };
}

/** One `writeResource` or file write. */
export interface Written {
  spec: string;
  name: string;
  data: Record<string, unknown>;
  tags: Record<string, string>;
}

/** Fill `{name}` placeholders the way the swamp logger does. */
function render(message: string, props: Record<string, unknown> = {}): string {
  return message.replace(/\{(\w+)\}/g, (_, k) => String(props[k]));
}

/**
 * A method context for any of the three models. `others` is the data of
 * other definitions by name, for `readModelData` and `queryData`.
 */
export function makeContext<G>(
  globalArgs: G,
  opts: {
    written?: Written[];
    others?: Record<string, DataRecord[]>;
    name?: string;
    repoDir?: string;
  } = {},
) {
  const written = opts.written ?? [];
  const logs: string[] = [];
  const files: { spec: string; name: string; text: string }[] = [];
  const self = opts.name ?? "self";
  const own = (): DataRecord[] => {
    const latest = new Map<string, Written>();
    for (const w of written) latest.set(w.name, w);
    return [...latest.values()].map((w) => ({
      name: w.name,
      specName: w.spec,
      attributes: w.data,
      tags: w.tags,
    }));
  };
  const context = {
    globalArgs,
    definition: { name: self },
    repoDir: opts.repoDir,
    logger: {
      info: (m: string, p?: Record<string, unknown>) =>
        logs.push(`info: ${render(m, p)}`),
      warning: (m: string, p?: Record<string, unknown>) =>
        logs.push(`warning: ${render(m, p)}`),
    },
    writeResource(
      spec: string,
      name: string,
      data: Record<string, unknown>,
      overrides?: { tags?: Record<string, string> },
    ): Promise<DataHandle> {
      written.push({
        spec,
        name,
        data: structuredClone(data),
        tags: overrides?.tags ?? {},
      });
      return Promise.resolve({ name });
    },
    readResource(name: string) {
      const last = written.findLast((w) => w.name === name);
      return Promise.resolve(last ? structuredClone(last.data) : null);
    },
    readModelData(modelName: string, specName?: string): Promise<DataRecord[]> {
      const rows = modelName === self ? own() : opts.others?.[modelName] ?? [];
      return Promise.resolve(
        rows.filter((r) => !specName || r.specName === specName),
      );
    },
    queryData(predicate: string): Promise<unknown[]> {
      const name = /modelName == "([^"]+)"/.exec(predicate)?.[1];
      const spec = /specName == "([^"]+)"/.exec(predicate)?.[1];
      if (!name) {
        return Promise.reject(new Error("query does not name a model"));
      }
      const rows = name === self ? own() : opts.others?.[name] ?? [];
      return Promise.resolve(rows.filter((r) => !spec || r.specName === spec));
    },
    createFileWriter(spec: string, name: string) {
      return {
        writeText(text: string): Promise<DataHandle> {
          files.push({ spec, name, text });
          return Promise.resolve({ name });
        },
      };
    },
  };
  return { context, written, logs, files };
}

/** A library context, typed as the library model wants it. */
export function libraryContext(g: GlobalArgs, written: Written[] = []) {
  const made = makeContext(g, { written, name: "gpodder" });
  return {
    ...made,
    context: made.context as ModelContext & typeof made.context,
  };
}

/** Records as another definition's data. */
export function records(written: Written[]): DataRecord[] {
  const latest = new Map<string, Written>();
  for (const w of written) latest.set(w.name, w);
  return [...latest.values()].map((w) => ({
    name: w.name,
    specName: w.spec,
    attributes: w.data,
    tags: w.tags,
  }));
}
