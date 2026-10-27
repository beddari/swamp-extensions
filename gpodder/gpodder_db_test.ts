import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.13";
import {
  isFinished,
  openLibrary,
  parseChapters,
  type PathEnv,
  resolvePaths,
} from "./gpodder_db.ts";
import { FEED_PASSWORD, makeHome } from "./test_support.ts";

function env(
  vars: Record<string, string>,
  os: string,
  existing: string[] = [],
): PathEnv {
  return { get: (n) => vars[n], os, exists: (p) => existing.includes(p) };
}

Deno.test("paths follow gPodder's rules", () => {
  const H = "/Users/me";
  const mac = `${H}/Library/Application Support/gPodder`;
  assertEquals(
    resolvePaths({}, undefined, env({ HOME: H }, "darwin")).home,
    mac,
  );
  assertEquals(
    resolvePaths({}, undefined, env({ HOME: H }, "darwin", [`${H}/gPodder`]))
      .home,
    `${H}/gPodder`,
  );
  assertEquals(
    resolvePaths(
      {},
      undefined,
      env({ HOME: H }, "darwin", [`${H}/gPodder`, mac]),
    ).home,
    mac,
  );
  assertEquals(
    resolvePaths({}, undefined, env({ HOME: H }, "linux")).home,
    `${H}/gPodder`,
  );
  const p = resolvePaths(
    {},
    undefined,
    env({
      HOME: H,
      GPODDER_HOME: "/data/gp/",
      GPODDER_DOWNLOAD_DIR: "~/Podcasts",
    }, "linux"),
  );
  assertEquals(p, {
    home: "/data/gp",
    database: "/data/gp/Database",
    downloads: `${H}/Podcasts`,
  });
  assertEquals(
    resolvePaths({ home: "gp" }, "/repo", env({ HOME: H }, "linux")).database,
    "/repo/gp/Database",
  );
});

Deno.test("a library reads podcasts without credentials, episodes with files", () => {
  const h = makeHome();
  try {
    const lib = openLibrary(resolvePaths({ home: h.home }));
    try {
      assertEquals(lib.schemaVersion, 8);
      const podcasts = lib.podcasts();
      assertEquals(podcasts.map((p) => [p.id, p.hasAuth, p.paused]), [
        [1, false, false],
        [2, true, false],
        [3, false, true],
      ]);
      assertEquals(JSON.stringify(podcasts).includes(FEED_PASSWORD), false);
      assertEquals(lib.auth(), [{
        podcastId: 2,
        username: "listener",
        password: FEED_PASSWORD,
      }]);
      const downloaded = lib.episodes({ states: ["downloaded"] });
      assertEquals(downloaded.map((e) => e.id), [11, 10, 20]);
      const ten = downloaded.find((e) => e.id === 10)!;
      assertEquals(ten.file, `${h.home}/Downloads/Open Feed/10.mp3`);
      assertEquals([ten.fileExists, ten.finished, ten.played, ten.isNew], [
        true,
        true,
        true,
        false,
      ]);
      assertEquals(
        ten.notes,
        "Ten & more. See [the book](https://example.test/book).\n\n- One\n- Two",
      );
      assertEquals(ten.chapters, [{ startSec: 0, title: "Intro" }, {
        startSec: 600.5,
        title: "Main",
      }]);
      assertEquals(ten.published, "2026-10-20T06:00:00.000Z");
      const twenty = downloaded.find((e) => e.id === 20)!;
      assertEquals([twenty.fileExists, twenty.locked], [false, true]);
      assertEquals(
        lib.episodes({ states: ["normal"] }).map((e) => [e.id, e.isNew]),
        [[12, true]],
      );
      assertEquals(
        lib.episodes({ activeSince: new Date("2026-10-24T00:00:00Z") }).map((
          e,
        ) => e.id),
        [10, 20],
      );
      assertEquals(lib.episodes({ ids: [] }), []);
      assertEquals(lib.episodes({ limit: 2 }).length, 2);
    } finally {
      lib.close();
    }
  } finally {
    h.cleanup();
  }
});

Deno.test("a file name that climbs out of the downloads directory gives no file", () => {
  const h = makeHome();
  try {
    h.exec(
      "UPDATE episode SET download_filename = '../../etc/passwd' WHERE id = 10",
    );
    const lib = openLibrary(resolvePaths({ home: h.home }));
    try {
      const ten = lib.episodes({ ids: [10] })[0];
      assertEquals([ten.file, ten.fileExists], [null, false]);
    } finally {
      lib.close();
    }
  } finally {
    h.cleanup();
  }
});

Deno.test("an older schema without the v7 and v8 columns reads with blanks", () => {
  const h = makeHome();
  try {
    for (
      const c of [
        "chapters",
        "episode_art_url",
        "description_html",
        "last_playback",
        "current_position_updated",
      ]
    ) {
      h.exec(`ALTER TABLE episode DROP COLUMN ${c}`);
    }
    h.exec("ALTER TABLE podcast DROP COLUMN section");
    const lib = openLibrary(resolvePaths({ home: h.home }));
    try {
      const eleven = lib.episodes({ ids: [11] })[0];
      assertEquals([eleven.chapters, eleven.artUrl, eleven.notes], [
        [],
        null,
        "Plain notes https://example.test/eleven.",
      ]);
      assertEquals([eleven.section, eleven.lastPlaybackAt], ["", null]);
      assertEquals(
        lib.episodes({ activeSince: new Date("2026-01-01T00:00:00Z") }),
        [],
      );
    } finally {
      lib.close();
    }
  } finally {
    h.cleanup();
  }
});

Deno.test("no database, or not a gPodder one, says so", () => {
  const dir = Deno.makeTempDirSync();
  try {
    assertThrows(
      () => openLibrary(resolvePaths({ home: dir })),
      Error,
      "no gPodder database",
    );
    Deno.writeTextFileSync(`${dir}/Database`, "");
    assertThrows(
      () => openLibrary(resolvePaths({ home: dir })),
      Error,
      "not a gPodder database",
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("chapters and finished follow gPodder", () => {
  assertEquals(
    parseChapters(
      '[{"start": 5, "title": "b"}, {"start": 1, "title": "a"}, {"title": "x"}]',
    ),
    [
      { startSec: 1, title: "a" },
      { startSec: 5, title: "b" },
    ],
  );
  assertEquals(parseChapters("not json"), []);
  assertEquals([
    isFinished(0, 100),
    isFinished(90, 100),
    isFinished(990, 1000),
    isFinished(1000, 0),
  ], [false, true, true, false]);
});
