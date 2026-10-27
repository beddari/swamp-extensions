/**
 * Speech to text, two ways: whisper.cpp on this machine, through ffmpeg, or
 * any server that speaks OpenAI's `/audio/transcriptions` (OpenAI itself, or
 * a local one such as speaches or LocalAI). Both give timed segments; WebVTT
 * is made from those.
 *
 * whisper.cpp is the default because an episode's audio then never leaves
 * the machine. It wants 16 kHz mono PCM, which ffmpeg makes in a temporary
 * directory that is removed whatever happens.
 *
 * @module
 */

/** A stretch of speech, in seconds from the start. */
export interface Segment {
  start: number;
  end: number;
  text: string;
}

/** A transcription: its segments, the language heard, how long the audio is. */
export interface Transcription {
  language: string | null;
  durationSec: number | null;
  segments: Segment[];
}

/** What running a program gave. */
export interface CommandOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program; replaced in tests. */
export type Runner = (
  cmd: string,
  args: string[],
  opts: { signal?: AbortSignal; timeoutMs: number },
) => Promise<CommandOutput>;

/** The real runner: `Deno.Command`, killed at the timeout or on abort. */
export const denoRunner: Runner = async (cmd, args, opts) => {
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)])
    : AbortSignal.timeout(opts.timeoutMs);
  let out: Deno.CommandOutput;
  try {
    // ffmpeg and whisper.cpp are programs, with no swamp primitive to call
    // them; the arguments are an argument vector, never a shell line, and the
    // README lists them.
    // swamp-quality-ignore deno-command
    out = await new Deno.Command(cmd, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal,
    }).output();
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(`${cmd} not found; install it or set its path`);
    }
    throw err;
  }
  if (signal.aborted) {
    throw new Error(
      `${cmd} stopped after ${opts.timeoutMs} ms or was cancelled`,
    );
  }
  const dec = new TextDecoder();
  return {
    code: out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
  };
};

/** The last lines of a program's error output, for an error message. */
function tail(s: string, lines = 8): string {
  return s.trim().split("\n").slice(-lines).join("\n");
}

/** whisper.cpp's `-oj` output, as much of it as is read. */
interface WhisperCppJson {
  result?: { language?: string };
  transcription?: {
    offsets?: { from?: number; to?: number };
    text?: string;
  }[];
}

/**
 * Segments from whisper.cpp's JSON output (`-oj`): offsets are milliseconds,
 * text carries a leading space, and empty segments are dropped.
 */
export function parseWhisperCppJson(raw: string): Transcription {
  const json = JSON.parse(raw) as WhisperCppJson;
  if (!Array.isArray(json.transcription)) {
    throw new Error("whisper.cpp output has no transcription");
  }
  const segments = json.transcription
    .map((s) => ({
      start: (Number(s.offsets?.from) || 0) / 1000,
      end: (Number(s.offsets?.to) || 0) / 1000,
      text: String(s.text ?? "").trim(),
    }))
    .filter((s) => s.text !== "");
  return {
    language: json.result?.language ?? null,
    durationSec: segments.at(-1)?.end ?? null,
    segments,
  };
}

/** How to run whisper.cpp. */
export interface WhisperCppOptions {
  ffmpeg: string;
  whisper: string;
  model: string;
  language: string;
  threads: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Transcribe a file with whisper.cpp, through a temporary 16 kHz WAV. */
export async function whisperCpp(
  file: string,
  opts: WhisperCppOptions,
  run: Runner = denoRunner,
): Promise<Transcription> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-gpodder-stt-" });
  try {
    const wav = `${dir}/audio.wav`;
    const conv = await run(opts.ffmpeg, [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      file,
      "-vn",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      wav,
    ], { signal: opts.signal, timeoutMs: opts.timeoutMs });
    if (conv.code !== 0) {
      throw new Error(`ffmpeg could not decode ${file}:\n${tail(conv.stderr)}`);
    }
    const base = `${dir}/out`;
    const stt = await run(opts.whisper, [
      "-m",
      opts.model,
      "-f",
      wav,
      "-l",
      opts.language,
      "-t",
      String(opts.threads),
      "-oj",
      "-of",
      base,
      "-np",
    ], { signal: opts.signal, timeoutMs: opts.timeoutMs });
    if (stt.code !== 0) {
      throw new Error(`whisper.cpp failed on ${file}:\n${tail(stt.stderr)}`);
    }
    return parseWhisperCppJson(await Deno.readTextFile(`${base}.json`));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** How to reach an OpenAI-compatible transcription endpoint. */
export interface OpenAiOptions {
  apiUrl: string;
  apiKey?: string;
  model: string;
  language: string;
  maxUploadBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

type Fetch = (input: Request) => Promise<Response>;

/**
 * Transcribe a file over `POST {apiUrl}/audio/transcriptions`, asking for
 * `verbose_json` with segment timestamps. A file over `maxUploadBytes` is
 * refused before it is sent: OpenAI takes 25 MB, and a long episode is more.
 */
export async function openAiTranscribe(
  file: string,
  opts: OpenAiOptions,
  fetchImpl: Fetch = (r) => fetch(r),
): Promise<Transcription> {
  const size = (await Deno.stat(file)).size;
  if (size > opts.maxUploadBytes) {
    throw new Error(
      `${file} is ${size} bytes, over maxUploadBytes ${opts.maxUploadBytes}; ` +
        "use the whisper-cpp engine, or raise the limit for a server that takes more",
    );
  }
  const form = new FormData();
  const bytes = await Deno.readFile(file);
  form.append("file", new Blob([bytes]), file.split("/").at(-1) ?? "audio");
  form.append("model", opts.model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  if (opts.language !== "auto") form.append("language", opts.language);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)])
    : AbortSignal.timeout(opts.timeoutMs);
  const response = await fetchImpl(
    new Request(`${opts.apiUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
      body: form,
      signal,
    }),
  );
  const text = await response.text();
  if (!response.ok) {
    const masked = opts.apiKey ? text.split(opts.apiKey).join("***") : text;
    throw new Error(
      `transcription endpoint answered HTTP ${response.status}: ${
        masked.slice(0, 500)
      }`,
    );
  }
  return parseOpenAiJson(text);
}

/** Segments from a `verbose_json` transcription. */
export function parseOpenAiJson(raw: string): Transcription {
  const json = JSON.parse(raw) as {
    language?: string;
    duration?: number;
    text?: string;
    segments?: { start?: number; end?: number; text?: string }[];
  };
  const segments = Array.isArray(json.segments)
    ? json.segments.map((s) => ({
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text: String(s.text ?? "").trim(),
    })).filter((s) => s.text !== "")
    : [];
  if (segments.length === 0 && json.text) {
    // A model that returns no segments still returns the text: one segment.
    segments.push({
      start: 0,
      end: Number(json.duration) || 0,
      text: json.text.trim(),
    });
  }
  return {
    language: json.language ?? null,
    durationSec: Number.isFinite(Number(json.duration))
      ? Number(json.duration)
      : null,
    segments,
  };
}

function stamp(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = String(Math.floor(ms / 3_600_000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0");
  return `${h}:${m}:${s}.${String(ms % 1000).padStart(3, "0")}`;
}

/** Segments as a WebVTT file. */
export function toVtt(segments: Segment[]): string {
  const cues = segments.map((s, i) =>
    `${i + 1}\n${stamp(s.start)} --> ${stamp(Math.max(s.end, s.start))}\n${
      s.text.replace(/-->/g, "->").replace(/\n{2,}/g, "\n")
    }`
  );
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

/** Segments as plain text, one paragraph per segment. */
export function plainText(segments: Segment[]): string {
  return segments.map((s) => s.text).join("\n");
}
