/**
 * `@beddari/gpodder/transcriber` — speech to text for downloaded episodes.
 * Takes an episode id, finds the episode's record in a library definition,
 * transcribes its file, and records the transcript as timed segments and as
 * a WebVTT file.
 *
 * Transcribing is slow and, on a paid endpoint, costs money, so an episode
 * already transcribed is skipped: same guid, same file size, same engine
 * and model. `force` transcribes it again.
 *
 * @module
 */
import { z } from "npm:zod@4";
import type { DataHandle, DataRecord, Logger } from "./library.ts";
import {
  denoRunner,
  openAiTranscribe,
  type Runner,
  type Segment,
  toVtt,
  type Transcription,
  whisperCpp,
} from "./stt.ts";
import { expandHome, inRepo } from "./gpodder_db.ts";

/** Global arguments: which engine, and how to run it. */
export const GlobalArgsSchema = z.object({
  library: z.string().default("gpodder").describe(
    "Name of the @beddari/gpodder/library definition whose episode records are transcribed",
  ),
  engine: z.enum(["whisper-cpp", "openai"]).default("whisper-cpp").describe(
    "whisper-cpp: whisper.cpp on this machine, audio never leaves it. " +
      "openai: an OpenAI-compatible /audio/transcriptions endpoint, OpenAI's or a local server's",
  ),
  language: z.string().default("auto").describe(
    "Spoken language as an ISO 639-1 code, e.g. en or nb; auto lets the model detect it",
  ),
  whisperBinary: z.string().default("whisper-cli").describe(
    "whisper.cpp's command-line program (whisper-cli; main in older builds)",
  ),
  whisperModel: z.string().optional().describe(
    "whisper.cpp model file, e.g. ~/models/ggml-large-v3-turbo.bin; required by whisper-cpp. " +
      "A relative path is taken from the repository root",
  ),
  ffmpegBinary: z.string().default("ffmpeg").describe(
    "ffmpeg, which decodes the episode for whisper.cpp",
  ),
  threads: z.coerce.number().int().min(1).max(64).default(4).describe(
    "whisper.cpp threads",
  ),
  apiUrl: z.string().default("https://api.openai.com/v1").describe(
    "Base URL of the OpenAI-compatible API, without /audio/transcriptions",
  ),
  apiKey: z.string().optional().meta({ sensitive: true }).describe(
    'API key for the openai engine, e.g. ${{ vault.get("<vault>", "openai-api-key") }}; ' +
      "a local server may need none",
  ),
  apiModel: z.string().default("whisper-1").describe(
    "Transcription model on that endpoint; it must return verbose_json segments for timestamps",
  ),
  maxUploadBytes: z.coerce.number().int().min(1).default(26_214_400).describe(
    "Largest file the openai engine sends; OpenAI's limit is 25 MB",
  ),
  timeoutMs: z.coerce.number().int().min(10_000).default(14_400_000).describe(
    "How long one transcription may take, decoding included",
  ),
});

/** Resolved global arguments. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** The subset of the swamp method context this model uses. */
export interface TranscriberContext {
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
  ): Promise<DataHandle>;
  /** The latest version of one of this definition's resources. */
  readResource?(name: string): Promise<Record<string, unknown> | null>;
  /** The latest records of another definition. */
  readModelData?(modelName: string, specName?: string): Promise<DataRecord[]>;
  /** A writer for one file resource. */
  createFileWriter(
    specName: string,
    name: string,
  ): { writeText(text: string): Promise<DataHandle> };
}

const SegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
});

/** One episode's transcript. */
export const TranscriptSchema = z.object({
  episodeId: z.number().int(),
  guid: z.string(),
  podcast: z.string(),
  title: z.string(),
  file: z.string(),
  fileSize: z.number(),
  engine: z.enum(["whisper-cpp", "openai"]),
  model: z.string(),
  language: z.string().nullable(),
  durationSec: z.number().nullable(),
  segments: z.array(SegmentSchema),
  wordCount: z.number().int(),
  transcribedAt: z.string(),
  elapsedMs: z.number().int(),
});

/** One episode's transcript. */
export type Transcript = z.infer<typeof TranscriptSchema>;

const TranscribeArgs = z.object({
  episodeId: z.coerce.number().int().describe(
    "gPodder's id of a downloaded episode, as in the library's episode-<id> records",
  ),
  force: z.boolean().default(false).describe(
    "Transcribe again even when this episode's file was already transcribed with this engine and model",
  ),
});

/** The fields of a library episode record a transcription needs. */
interface EpisodeRef {
  id: number;
  guid: string;
  podcast: string;
  title: string;
  file: string | null;
  fileExists: boolean;
  fileSize: number;
}

/** Look up one episode record of a library definition. */
export async function findEpisode(
  readModelData: TranscriberContext["readModelData"],
  library: string,
  episodeId: number,
): Promise<Record<string, unknown>> {
  if (!readModelData) {
    throw new Error(
      "this swamp cannot read another model's data from a method",
    );
  }
  const rows = await readModelData(library, "episode");
  const row = rows.find((r) => r.name === `episode-${episodeId}`);
  if (!row) {
    throw new Error(
      `${library} has no record of episode ${episodeId}; run its downloads or episodes method first`,
    );
  }
  return row.attributes;
}

function modelName(g: GlobalArgs): string {
  return g.engine === "openai"
    ? g.apiModel
    : (g.whisperModel ?? "").split("/").at(-1) ?? "";
}

function words(segments: Segment[]): number {
  return segments.reduce(
    (n, s) => n + s.text.split(/\s+/).filter(Boolean).length,
    0,
  );
}

/** Transcribe one file with the configured engine. */
export function transcribeFile(
  file: string,
  g: GlobalArgs,
  repoDir: string | undefined,
  signal?: AbortSignal,
  run: Runner = denoRunner,
  fetchImpl?: (r: Request) => Promise<Response>,
): Promise<Transcription> {
  if (g.engine === "whisper-cpp") {
    if (!g.whisperModel) {
      throw new Error("the whisper-cpp engine needs whisperModel");
    }
    return whisperCpp(file, {
      ffmpeg: g.ffmpegBinary,
      whisper: g.whisperBinary,
      model: expandHome(inRepo(g.whisperModel, repoDir)),
      language: g.language,
      threads: g.threads,
      timeoutMs: g.timeoutMs,
      signal,
    }, run);
  }
  return openAiTranscribe(file, {
    apiUrl: g.apiUrl,
    apiKey: g.apiKey,
    model: g.apiModel,
    language: g.language,
    maxUploadBytes: g.maxUploadBytes,
    timeoutMs: g.timeoutMs,
    signal,
  }, fetchImpl);
}

/** Pre-flight checks: the engine can run before anything is attempted. */
const checks = {
  "engine-ready": {
    description:
      "whisper-cpp: the model file exists and both programs run. openai: the API URL is a URL",
    labels: ["live"],
    execute: async (
      context: {
        globalArgs: z.input<typeof GlobalArgsSchema>;
        repoDir?: string;
      },
    ): Promise<{ pass: boolean; errors?: string[] }> => {
      const g = GlobalArgsSchema.parse(context.globalArgs);
      const errors: string[] = [];
      if (g.engine === "openai") {
        try {
          new URL(g.apiUrl);
        } catch {
          errors.push(`apiUrl is not a URL: ${g.apiUrl}`);
        }
      } else if (!g.whisperModel) {
        errors.push("the whisper-cpp engine needs whisperModel");
      } else {
        const path = expandHome(inRepo(g.whisperModel, context.repoDir));
        try {
          await Deno.stat(path);
        } catch {
          errors.push(`whisperModel ${path} does not exist`);
        }
        for (
          const [bin, args] of [[g.ffmpegBinary, ["-version"]], [
            g.whisperBinary,
            ["-h"],
          ]] as const
        ) {
          try {
            await denoRunner(bin, [...args], { timeoutMs: 15_000 });
          } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err));
          }
        }
      }
      return errors.length ? { pass: false, errors } : { pass: true };
    },
  },
};

/** Transcribes downloaded gPodder episodes. */
export const model = {
  type: "@beddari/gpodder/transcriber",
  version: "2026.10.27.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    transcript: {
      description:
        "One episode's transcript: timed segments, language, engine and model",
      schema: TranscriptSchema,
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
  },
  files: {
    vtt: {
      description: "One episode's transcript as WebVTT",
      contentType: "text/vtt",
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
  },
  methods: {
    transcribe: {
      description:
        "Transcribe one downloaded episode's file and record its transcript and WebVTT; " +
        "skipped when the same file was already transcribed the same way, unless force",
      arguments: TranscribeArgs,
      execute: async (
        raw: z.input<typeof TranscribeArgs>,
        context: TranscriberContext,
        deps: {
          run?: Runner;
          fetch?: (r: Request) => Promise<Response>;
          stat?: (path: string) => Promise<{ size: number }>;
        } = {},
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const args = TranscribeArgs.parse(raw);
        const g = context.globalArgs;
        const ep = await findEpisode(
          context.readModelData?.bind(context),
          g.library,
          args.episodeId,
        ) as unknown as EpisodeRef;
        if (!ep.file || !ep.fileExists) {
          throw new Error(
            `episode ${ep.id} (${ep.title}) has no downloaded file in the library's record`,
          );
        }
        const name = `transcript-${ep.id}`;
        // The size on disk, not the feed's announced length, which is often
        // 0: a file replaced or downloaded again is transcribed again.
        const fileSize = await (deps.stat ?? Deno.stat)(ep.file)
          .then((st) => st.size)
          .catch(() => {
            throw new Error(`episode ${ep.id}: cannot read ${ep.file}`);
          });
        const existing = await context.readResource?.(name) as
          | Transcript
          | null
          | undefined;
        if (
          !args.force && existing && existing.guid === ep.guid &&
          existing.fileSize === fileSize && existing.engine === g.engine &&
          existing.model === modelName(g)
        ) {
          context.logger.info(
            "episode {id} already transcribed {at}; skipped",
            {
              id: ep.id,
              at: existing.transcribedAt,
            },
          );
          return { dataHandles: [] };
        }
        context.logger.info(
          "transcribing episode {id} ({title}) with {engine}",
          {
            id: ep.id,
            title: ep.title,
            engine: g.engine,
          },
        );
        const started = performance.now();
        const result = await transcribeFile(
          ep.file,
          g,
          context.repoDir,
          context.signal,
          deps.run,
          deps.fetch,
        );
        if (result.segments.length === 0) {
          throw new Error(`${g.engine} heard no speech in ${ep.file}`);
        }
        const transcript: Transcript = {
          episodeId: ep.id,
          guid: ep.guid,
          podcast: ep.podcast,
          title: ep.title,
          file: ep.file,
          fileSize,
          engine: g.engine,
          model: modelName(g),
          language: result.language,
          durationSec: result.durationSec,
          segments: result.segments,
          wordCount: words(result.segments),
          transcribedAt: new Date().toISOString(),
          elapsedMs: Math.round(performance.now() - started),
        };
        // The WebVTT first: the transcript record is what later runs skip
        // on, so it is written only once everything else is.
        const vtt = await context.createFileWriter("vtt", `vtt-${ep.id}`)
          .writeText(toVtt(result.segments));
        const handle = await context.writeResource(
          "transcript",
          name,
          transcript,
        );
        context.logger.info(
          "episode {id}: {words} words in {segments} segments",
          {
            id: ep.id,
            words: transcript.wordCount,
            segments: result.segments.length,
          },
        );
        return { dataHandles: [handle, vtt] };
      },
    },
  },
};
