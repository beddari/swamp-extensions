import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { type GlobalArgs, model } from "./transcriber.ts";
import { makeContext } from "./test_support.ts";
import { fakeRunner } from "./fixtures.ts";
import type { DataRecord } from "./library.ts";

const g: GlobalArgs = {
  library: "gpodder",
  engine: "whisper-cpp",
  language: "auto",
  whisperBinary: "whisper-cli",
  whisperModel: "/m/ggml-base.en.bin",
  ffmpegBinary: "ffmpeg",
  threads: 2,
  apiUrl: "https://api.openai.com/v1",
  apiModel: "whisper-1",
  maxUploadBytes: 26_214_400,
  timeoutMs: 60_000,
};

function episode(id: number, extra: Record<string, unknown> = {}): DataRecord {
  return {
    name: `episode-${id}`,
    specName: "episode",
    attributes: {
      id,
      guid: `guid-${id}`,
      podcast: "P",
      title: `E${id}`,
      file: `/d/${id}.mp3`,
      fileExists: true,
      fileSize: 5,
      ...extra,
    },
  };
}

Deno.test("transcribe records the transcript and its WebVTT, then skips the same file", async () => {
  const calls: string[][] = [];
  const { context, written, files, logs } = makeContext(g, {
    others: { gpodder: [episode(10)] },
  });
  const deps = {
    run: fakeRunner(calls),
    stat: () => Promise.resolve({ size: 5 }),
  };
  const r = await model.methods.transcribe.execute(
    { episodeId: 10 },
    context,
    deps,
  );
  assertEquals(r.dataHandles.map((h) => h.name), ["transcript-10", "vtt-10"]);
  const t = written[0].data;
  assertEquals([
    t.episodeId,
    t.guid,
    t.engine,
    t.model,
    t.language,
    t.wordCount,
  ], [10, "guid-10", "whisper-cpp", "ggml-base.en.bin", "en", 5]);
  assertEquals(
    files[0].text.startsWith(
      "WEBVTT\n\n1\n00:00:00.000 --> 00:00:04.200\nHello and welcome.",
    ),
    true,
  );
  assertEquals(calls.length, 2);

  const again = await model.methods.transcribe.execute(
    { episodeId: 10 },
    context,
    deps,
  );
  assertEquals([again.dataHandles.length, calls.length], [0, 2]);
  assertEquals(logs.at(-1)!.includes("already transcribed"), true);

  await model.methods.transcribe.execute(
    { episodeId: 10, force: true },
    context,
    deps,
  );
  assertEquals(calls.length, 4);
});

Deno.test("transcribe refuses an episode without its file, or unknown to the library", async () => {
  const { context } = makeContext(g, {
    others: { gpodder: [episode(11, { fileExists: false })] },
  });
  await assertRejects(
    () => model.methods.transcribe.execute({ episodeId: 11 }, context),
    Error,
    "no downloaded file",
  );
  await assertRejects(
    () => model.methods.transcribe.execute({ episodeId: 99 }, context),
    Error,
    "gpodder has no record of episode 99",
  );
});

Deno.test("the engine-ready check needs a model file for whisper-cpp", async () => {
  const r = await model.checks["engine-ready"].execute({
    globalArgs: {
      whisperModel: "/nonexistent/ggml.bin",
      whisperBinary: "/nonexistent/w",
      ffmpegBinary: "/nonexistent/f",
    },
  });
  assertEquals(r.pass, false);
  assertEquals(
    r.errors![0],
    "whisperModel /nonexistent/ggml.bin does not exist",
  );
  assertEquals(
    (await model.checks["engine-ready"].execute({
      globalArgs: { engine: "openai", apiUrl: "nope" },
    })).errors,
    ["apiUrl is not a URL: nope"],
  );
});
