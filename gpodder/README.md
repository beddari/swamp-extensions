# @beddari/gpodder

A [gPodder](https://gpodder.github.io) podcast library as swamp data, and a
pipeline from new downloads to notes: every episode gPodder downloads is
transcribed, read by Claude for a summary, topics and timestamped chapters, and
written as a Markdown note into a personal knowledge base such as an Obsidian
vault or a notes repository. Alongside it, a weekly listening audit and a daily
feed health check. Nothing here ever writes to gPodder.

| Model type                     | Method       | Does                                                                                              |
| ------------------------------ | ------------ | ------------------------------------------------------------------------------------------------- |
| `@beddari/gpodder/library`     | `podcasts`   | One record per subscription, without its credentials                                              |
|                                | `episodes`   | One record per episode by state: file, position, show notes as Markdown, feed chapters            |
|                                | `downloads`  | The episodes downloaded since the last run, by a cursor; what the ingest workflow starts from     |
|                                | `listening`  | What was played in a window, per episode and per podcast; optionally a Markdown page per week     |
|                                | `feedHealth` | Fetches every feed, probes its newest enclosures, checks downloads, records and logs incidents    |
| `@beddari/gpodder/transcriber` | `transcribe` | One episode to timed segments and WebVTT, with whisper.cpp locally or an OpenAI-compatible server |
| `@beddari/gpodder/enricher`    | `enrich`     | Claude reads notes and transcript: summary, topics, chapters, key points, clean notes, mentions   |
|                                | `export`     | Every enriched episode as a Markdown note with front matter, rewritten only when it changed       |

| Workflow                            | When               | Runs                                                                   |
| ----------------------------------- | ------------------ | ---------------------------------------------------------------------- |
| `@beddari/gpodder-ingest`           | hourly, or on hook | `downloads`, then `transcribe` and `enrich` per episode, then `export` |
| `@beddari/gpodder-feed-health`      | daily at 06:00     | `feedHealth`, rendered by `@beddari/gpodder/feed-health-report`        |
| `@beddari/gpodder-weekly-listening` | Sundays at 20:00   | `listening`, rendered by `@beddari/gpodder/listening-report`           |

Written against gPodder 3.11 (database schema 8); older schemas read with the
newer columns blank.

## Setup

The workflows use three definitions by name: `gpodder`, `gpodder-transcriber`
and `gpodder-enricher`.

```sh
swamp extension pull @beddari/gpodder

# gPodder's library. home defaults to $GPODDER_HOME, else
# ~/Library/Application Support/gPodder on macOS, else ~/gPodder.
swamp model create @beddari/gpodder/library gpodder

# Speech to text with whisper.cpp: audio never leaves the machine.
swamp model create @beddari/gpodder/transcriber gpodder-transcriber \
  --global-arg whisperModel=~/models/ggml-large-v3-turbo.bin \
  --global-arg language=auto

# Claude, with the key in a vault and the notes going into a vault folder.
swamp vault put default anthropic-api-key
swamp model create @beddari/gpodder/enricher gpodder-enricher \
  --global-arg 'apiKey=${{ vault.get("default", "anthropic-api-key") }}' \
  --global-arg exportDir=~/Notes/Podcasts

swamp model validate gpodder
swamp model validate gpodder-transcriber
```

The first `downloads` run, and so the first ingest, takes the library as it
stands as already seen, so it does not transcribe and summarise years of
episodes. Use `backfill` to take some of the newest anyway:

```sh
swamp workflow run @beddari/gpodder-ingest --input backfill=5
```

In the ingest workflow, `downloads` runs with `pendingFor` naming the
transcriber and the enricher: an episode it returned stays due until both have a
record of it. One whose transcription or enrichment failed comes back on the
next runs, up to `maxAttempts` (default 3), after which it is reported in the
`downloads` record's `gaveUp` and a warning. One enriched from its show notes
because transcription failed is transcribed and enriched again once that works.
Each job of a run takes only the episodes that run's `downloads` returned, so
two overlapping runs never take each other's work.

The schedules in the workflows' `trigger` fire while `swamp serve` runs.

### Run it right after a download

gPodder runs Python extensions from its `Extensions` directory.
[`contrib/swamp_ingest.py`](contrib/swamp_ingest.py), in this extension's source
repository, is one: after each download it restarts a timer, and once no
download has finished for two minutes it runs the ingest workflow in the
background, in the swamp repository you name. The delay also gives gPodder time
to commit the episode's new state before swamp reads the database. A run that
misses an episode is harmless, because the cursor returns it next time. While a
run it started is still going, it starts no second one. gPodder started from the
Finder has a minimal PATH, so the hook also looks for swamp in `~/.local/bin`,
`/opt/homebrew/bin` and `/usr/local/bin`; set its `swamp` option to the full
path otherwise.

```sh
mkdir -p ~/Library/Application\ Support/gPodder/Extensions
cp contrib/swamp_ingest.py ~/Library/Application\ Support/gPodder/Extensions/
# Restart gPodder, enable "Run swamp after downloads" under Preferences >
# Extensions, and set its repo option to your swamp repository.
```

Output from those runs goes to `.swamp/gpodder-hook.log` in that repository.

## Transcription

`engine: whisper-cpp` (default) decodes the episode to 16 kHz mono with ffmpeg
in a temporary directory and runs whisper.cpp's `whisper-cli` on it; both must
be installed (`brew install whisper-cpp ffmpeg`) and `whisperModel` must name a
ggml model file. The `engine-ready` check verifies all three.

`engine: openai` posts the file to `<apiUrl>/audio/transcriptions` asking for
`verbose_json` segments. That is OpenAI's API by default (`apiModel: whisper-1`,
which returns segments; the newer models do not), or any compatible server, such
as a local speaches or LocalAI, by `apiUrl`. OpenAI takes at most 25 MB, so a
longer episode is refused before upload (`maxUploadBytes`) rather than failing
there; use whisper-cpp for those.

An episode is transcribed once: the same guid, size on disk, engine and model
are skipped unless `force: true`. The WebVTT file is written before the
transcript record, so an interrupted run leaves nothing that later runs would
skip on.

## Enrichment

One Messages API request per episode, streamed, with structured output: the
answer must match a JSON schema, and is checked against it again before it is
recorded. The defaults are `model: claude-opus-5-5` at `effort: medium` with
adaptive thinking, and server-side fallback on a policy refusal
(`fallbacks: true`; Claude API only, off when `baseUrl` points elsewhere).

Show notes and transcripts are text from third parties. The system prompt fences
them as material to describe, never instructions to follow, and the answer can
only take the schema's shape. Nothing is cut to fit: an episode whose prompt is
over `maxInputChars` fails and says so. `topics` sets a fixed vocabulary, which
the schema then enforces; `outputLanguage` sets the language of the summaries.
Chapters are kept only when they start inside the episode and in order. Without
a transcript, the episode is enriched from its show notes and feed chapters, and
again from the transcript once there is one; `requireTranscript: true` refuses
instead.

The key comes from `apiKey`, which as a sensitive argument takes only a vault
reference, or else from the SDK's own lookup: `ANTHROPIC_API_KEY`, or an
`ant auth login` profile.

## Notes

`export` writes `<exportDir>/<podcast>/<YYYY-MM-DD> <title>.md`, with YAML front
matter that Obsidian and most static-site tools read (title, podcast, published,
duration, listened, episode link, guid, tags from the topics) and the summary,
key points, chapters, cleaned show notes, mentions and links, and with
`includeTranscript: true` the timed transcript. A note is rewritten only when
its content changed, so the directory can be a git repository without noise; a
note whose episode was retitled is moved, not duplicated.

The media URL goes in the front matter only with `includeAudioUrl: true`: a
private feed's media URLs carry its access token, and notes are often synced or
committed. Everything from the feed or from Claude is made inert first: raw HTML
is escaped and images become plain links, so opening a note loads nothing from
the network. A note that cannot be written (a full disk, a name the file system
refuses) is listed in the export record's `skipped`, and the others are still
written.

## Listening

gPodder records when playback last started and when a position was last saved;
either inside the window counts as listening. It records a position reached, not
time spent, and only what its player reports back: an external player that
reports no position leaves only the playback mark. `listening` records the
window under the ISO week of its end, by the local date where swamp runs
(`listening-2026-w44`), and with `outputDir` also writes `2026-W44.md` there.
The window is the last `days` days, not the calendar week its label names; the
Sunday-evening schedule makes the two nearly the same.

## Feed health

| Incident                   | Severity | Means                                                       |
| -------------------------- | -------- | ----------------------------------------------------------- |
| `feed-unreachable`         | error    | No answer: DNS, connection, TLS or timeout                  |
| `feed-http-error`          | error    | HTTP 400 or above                                           |
| `feed-not-a-feed`          | error    | The answer is neither RSS nor Atom                          |
| `enclosure-unreachable`    | error    | One of the newest enclosures gives no answer                |
| `enclosure-http-error`     | error    | One of the newest enclosures gives HTTP 400 or above        |
| `feed-moved`               | warning  | A permanent redirect; gPodder may still use the old URL     |
| `feed-stale`               | warning  | The newest episode is older than `staleDays`                |
| `feed-empty`               | warning  | The feed lists no episodes                                  |
| `download-file-missing`    | warning  | gPodder lists an episode as downloaded but its file is gone |
| `no-published-transcripts` | info     | No episode carries a Podcasting 2.0 `<podcast:transcript>`  |
| `download-not-transcribed` | info     | A download the named `transcriber` has no transcript of     |

Enclosures are probed with HEAD, and with a one-byte ranged GET where a server
refuses HEAD; up to ten redirects are followed, enough for chains of analytics
prefixes. A feed that needs credentials is fetched with gPodder's own, which go
to the feed's own origin only: never across a redirect to another host or from
https to http, and to an enclosure only on the feed's origin. They are never
recorded, and URLs are recorded without user info. A cancelled check records
nothing rather than every feed it did not reach as unreachable. Each error and
warning is also a log line through swamp's logger, so a scheduled run leaves a
trail without anyone reading the data. `failOn: error` or `warning` fails the
run after everything is recorded.

## Development

```sh
swamp extension source add ~/kode/beddari/swamp-extensions/gpodder
~/.swamp/deno/deno task test
./smoke/run.sh
```

`smoke/run.sh` runs every method, all three workflows and both reports in a
scratch swamp repository, against a fixture gPodder home, a local server playing
the feeds and the Anthropic API, and stub ffmpeg and whisper-cli. It costs
nothing and needs no account.

## License

MIT — see LICENSE.md.
