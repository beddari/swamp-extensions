#!/usr/bin/env bash
# End-to-end smoke run against a real swamp: a scratch repository loading this
# extension from source, a fixture gPodder home, a local server for feeds and a
# stand-in Anthropic API, and stub ffmpeg and whisper-cli. Exercises every
# model method, all three workflows and both reports, then checks that the
# fixture feed password reached nothing under .swamp. Costs nothing.
#
#   ./smoke/run.sh            # keeps the scratch directory on failure
set -euo pipefail

src=$(cd "$(dirname "$0")/.." && pwd)
deno=${DENO:-$HOME/.swamp/deno/deno}
port=${PORT:-18765}
work=$(mktemp -d "${TMPDIR:-/tmp}/gpodder-smoke.XXXXXX")
repo=$work/repo
pass=0
fail=0

ok() { echo "ok   $*"; pass=$((pass + 1)); }
bad() { echo "FAIL $*"; fail=$((fail + 1)); }
check() { # description, then a command that must succeed
	local what=$1; shift
	if "$@" >/dev/null 2>&1; then ok "$what"; else bad "$what"; fi
}
q() { (cd "$repo" && swamp data query "$1" --select "${2:-attributes}" --json) | jq -c '.results'; }

"$deno" run --allow-net=127.0.0.1 --allow-read --allow-write "$src/smoke/server.ts" "$port" "$work" &
server=$!
trap 'kill $server 2>/dev/null || true' EXIT
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$port/feeds/open.xml" >/dev/null && break; sleep 0.2; done

home=$("$deno" run --allow-env --allow-read --allow-write "$src/smoke/home.ts" "http://127.0.0.1:$port")

mkdir -p "$work/bin" "$repo"
cat >"$work/bin/ffmpeg" <<'SH'
#!/bin/sh
[ "$1" = "-version" ] && { echo "ffmpeg stub"; exit 0; }
for last; do :; done
printf 'RIFF' >"$last"
SH
cat >"$work/bin/whisper-cli" <<'SH'
#!/bin/sh
[ -f "${0%/bin/*}/fail-whisper" ] && { echo "stub: told to fail" >&2; exit 1; }
of=""
while [ $# -gt 0 ]; do [ "$1" = "-of" ] && of=$2; shift; done
[ -z "$of" ] && exit 0
printf '{"result":{"language":"en"},"transcription":[{"offsets":{"from":0,"to":3000},"text":" Stub speech."},{"offsets":{"from":3000,"to":9000},"text":" More stub speech."}]}' >"$of.json"
SH
chmod +x "$work/bin/"*
touch "$work/ggml-stub.bin"

# The stand-in API takes any key; a sensitive global argument only takes a
# vault reference, so the SDK reads this one from its environment.
export ANTHROPIC_API_KEY=sk-smoke-not-a-key

cd "$repo"
swamp repo init --tool none --no-vault --json >/dev/null
swamp extension source add "$src" --json >/dev/null
swamp model create @beddari/gpodder/library gpodder --global-arg "home=$home" --global-arg httpTimeoutMs=3000 --json >/dev/null
swamp model create @beddari/gpodder/transcriber gpodder-transcriber \
	--global-arg "whisperBinary=$work/bin/whisper-cli" --global-arg "ffmpegBinary=$work/bin/ffmpeg" \
	--global-arg "whisperModel=$work/ggml-stub.bin" --json >/dev/null
swamp model create @beddari/gpodder/enricher gpodder-enricher \
	--global-arg "baseUrl=http://127.0.0.1:$port" \
	--global-arg "exportDir=$work/notes" --json >/dev/null
ok "three definitions created"

check "validate gpodder (database-readable)" swamp model validate gpodder
check "validate gpodder-transcriber (engine-ready)" swamp model validate gpodder-transcriber

swamp model method run gpodder podcasts --json >/dev/null
[ "$(q 'modelName == "gpodder" && specName == "podcast"' | jq length)" = 3 ] && ok "podcasts: 3 records" || bad "podcasts"

swamp model method run gpodder episodes --input state=all --json >/dev/null
[ "$(q 'modelName == "gpodder" && name == "episodes"' | jq -c '.[0].episodeIds')" = "[12,11,10,20,30]" ] && ok "episodes: all five, newest first" || bad "episodes"

swamp workflow run @beddari/gpodder-ingest --input backfill=2 --json >"$work/ingest.json" || true
[ "$(jq -r '.status' "$work/ingest.json")" = "succeeded" ] && ok "ingest workflow succeeded" || bad "ingest workflow: $(jq -c '.status, .error' "$work/ingest.json")"
[ "$(q 'modelName == "gpodder-transcriber" && specName == "transcript"' | jq length)" = 2 ] && ok "two transcripts" || bad "transcripts"
[ "$(q 'modelName == "gpodder-enricher" && specName == "enrichment"' | jq -c '[.[].transcriptBased]')" = "[true,true]" ] && ok "two enrichments, both from transcripts" || bad "enrichments"
[ "$(find "$work/notes" -name '*.md' | wc -l | tr -d ' ')" = 2 ] && ok "two notes exported" || bad "notes"
grep -q '"output_config":{"effort":"medium","format":{"type":"json_schema"' "$work/requests.jsonl" && ok "SDK sent structured output over the wire" || bad "request body"
[ "$(wc -l <"$work/requests.jsonl" | tr -d ' ')" = 2 ] && ok "two Claude requests" || bad "claude request count"

swamp workflow run @beddari/gpodder-ingest --json >"$work/ingest2.json" || true
[ "$(q 'modelName == "gpodder" && name == "downloads"' | jq -c '.[0].count')" = 0 ] && ok "second ingest finds nothing new" || bad "second ingest"
[ "$(wc -l <"$work/requests.jsonl" | tr -d ' ')" = 2 ] && ok "no further Claude requests" || bad "claude requests after rerun"

# gPodder downloads episode 12; whisper fails on it, so it is enriched from its
# show notes, and the next run retries it, transcribes it and enriches it again.
sqlite3 "$home/Database" "UPDATE episode SET state = 1, download_filename = '12.mp3' WHERE id = 12"
printf 'x' >"$home/Downloads/Open Feed/12.mp3"
touch "$work/fail-whisper"
swamp workflow run @beddari/gpodder-ingest --json >"$work/ingest3.json" || true
[ "$(q 'modelName == "gpodder-enricher" && name == "enrichment-12"' | jq -c '.[0].transcriptBased')" = false ] && ok "failed transcription: enriched from show notes" || bad "enrich from notes"
rm "$work/fail-whisper"
swamp workflow run @beddari/gpodder-ingest --json >"$work/ingest4.json" || true
[ "$(q 'modelName == "gpodder" && name == "downloads"' | jq -c '.[0].retried')" = "[12]" ] && ok "next run retried episode 12" || bad "retry: $(q 'modelName == "gpodder" && name == "downloads"')"
[ "$(q 'modelName == "gpodder-enricher" && name == "enrichment-12"' | jq -c '.[0].transcriptBased')" = true ] && ok "episode 12 enriched again from its transcript" || bad "re-enrich from transcript"
[ "$(wc -l <"$work/requests.jsonl" | tr -d ' ')" = 4 ] && ok "four Claude requests in all" || bad "claude request count after retry"
swamp workflow run @beddari/gpodder-ingest --json >/dev/null || true
[ "$(q 'modelName == "gpodder" && name == "downloads"' | jq -c '.[0].count')" = 0 ] && ok "done episodes are not returned again" || bad "done episodes returned"

swamp workflow run @beddari/gpodder-feed-health --input transcriber=gpodder-transcriber --input enclosures=2 --json >"$work/health.json" || true
kinds=$(q 'modelName == "gpodder" && name == "health-check"' | jq -c '[.[0].incidents[].kind] | sort')
[ "$kinds" = '["download-file-missing","enclosure-http-error","feed-http-error"]' ] && ok "feed health incidents: $kinds" || bad "feed health incidents: $kinds"

swamp workflow run @beddari/gpodder-weekly-listening --input "outputDir=$work/weeks" --json >/dev/null || true
[ -n "$(ls "$work/weeks"/*.md 2>/dev/null)" ] && ok "weekly listening page written" || bad "weekly listening page"

for r in @beddari/gpodder/feed-health-report @beddari/gpodder/listening-report; do
	check "report $r recorded" sh -c "swamp report get $r --model gpodder --json | jq -e '.markdown // .reports[0].markdown // empty' >/dev/null"
done

if grep -rq FIXTURE-FEED-PASSWORD "$repo/.swamp" "$work/notes" "$work/weeks"; then bad "feed password leaked"; else ok "feed password reached nothing"; fi
if grep -rq sk-smoke-not-a-key "$repo/.swamp/data" 2>/dev/null; then bad "API key stored in clear"; else ok "API key not in data"; fi

echo "$pass passed, $fail failed"
if [ "$fail" -eq 0 ]; then rm -rf "$work"; else echo "kept $work"; exit 1; fi
