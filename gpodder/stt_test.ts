import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import {
  openAiTranscribe,
  parseOpenAiJson,
  parseWhisperCppJson,
  toVtt,
  whisperCpp,
} from "./stt.ts";
import { fakeRunner, WHISPER_JSON } from "./fixtures.ts";

Deno.test("whisper.cpp JSON becomes seconds and trimmed text", () => {
  assertEquals(parseWhisperCppJson(WHISPER_JSON), {
    language: "en",
    durationSec: 9,
    segments: [
      { start: 0, end: 4.2, text: "Hello and welcome." },
      { start: 4.3, end: 9, text: "Today: chapters." },
    ],
  });
});

Deno.test("whisperCpp decodes to 16 kHz mono, then transcribes, and removes its temp dir", async () => {
  const calls: string[][] = [];
  const t = await whisperCpp("/x/ep.mp3", {
    ffmpeg: "ffmpeg",
    whisper: "whisper-cli",
    model: "/m/ggml.bin",
    language: "auto",
    threads: 2,
    timeoutMs: 1000,
  }, fakeRunner(calls));
  assertEquals(t.segments.length, 2);
  const [ff, wh] = calls;
  assertEquals(ff.slice(0, 1), ["ffmpeg"]);
  assertEquals(ff.slice(ff.indexOf("-ar"), ff.indexOf("-ar") + 4), [
    "-ar",
    "16000",
    "-ac",
    "1",
  ]);
  const wav = ff.at(-1)!;
  assertEquals(wh.slice(0, 5), ["whisper-cli", "-m", "/m/ggml.bin", "-f", wav]);
  let gone = false;
  try {
    Deno.statSync(wav.slice(0, wav.lastIndexOf("/")));
  } catch {
    gone = true;
  }
  assertEquals(gone, true);
});

Deno.test("a failing whisper.cpp says why", async () => {
  await assertRejects(
    () =>
      whisperCpp("/x/ep.mp3", {
        ffmpeg: "ffmpeg",
        whisper: "whisper-cli",
        model: "/m",
        language: "en",
        threads: 1,
        timeoutMs: 1000,
      }, fakeRunner([], 1)),
    Error,
    "model not found",
  );
});

Deno.test("openai: verbose_json segments, a bearer key, the size limit, a masked error", async () => {
  const file = Deno.makeTempFileSync({ suffix: ".mp3" });
  Deno.writeFileSync(file, new Uint8Array(100));
  try {
    const seen: Request[] = [];
    const opts = {
      apiUrl: "http://stt.test/v1/",
      apiKey: "sk-FIXTURE",
      model: "whisper-1",
      language: "nb",
      maxUploadBytes: 1000,
      timeoutMs: 1000,
    };
    const t = await openAiTranscribe(file, opts, async (req) => {
      seen.push(req);
      const form = await req.formData();
      assertEquals([
        form.get("model"),
        form.get("response_format"),
        form.get("language"),
      ], ["whisper-1", "verbose_json", "nb"]);
      return new Response(
        JSON.stringify({
          language: "norwegian",
          duration: 3,
          segments: [{ start: 0, end: 3, text: " Hei." }],
        }),
      );
    });
    assertEquals(seen[0].url, "http://stt.test/v1/audio/transcriptions");
    assertEquals(seen[0].headers.get("authorization"), "Bearer sk-FIXTURE");
    assertEquals(t, {
      language: "norwegian",
      durationSec: 3,
      segments: [{ start: 0, end: 3, text: "Hei." }],
    });
    await assertRejects(
      () => openAiTranscribe(file, { ...opts, maxUploadBytes: 10 }),
      Error,
      "over maxUploadBytes 10",
    );
    const err = await assertRejects(
      () =>
        openAiTranscribe(
          file,
          opts,
          () =>
            Promise.resolve(
              new Response("bad key sk-FIXTURE", { status: 401 }),
            ),
        ),
      Error,
    );
    assertStringIncludes(err.message, "HTTP 401: bad key ***");
  } finally {
    Deno.removeSync(file);
  }
});

Deno.test("text without segments is one segment", () => {
  assertEquals(
    parseOpenAiJson('{"text": "All of it.", "duration": 12}').segments,
    [{ start: 0, end: 12, text: "All of it." }],
  );
});

Deno.test("WebVTT cues", () => {
  assertEquals(
    toVtt([{ start: 0, end: 4.2, text: "Hi --> there" }, {
      start: 3661.5,
      end: 3662,
      text: "Late",
    }]),
    "WEBVTT\n\n1\n00:00:00.000 --> 00:00:04.200\nHi -> there\n\n2\n01:01:01.500 --> 01:01:02.000\nLate\n",
  );
});
