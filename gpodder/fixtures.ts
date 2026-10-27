/**
 * Recorded shapes the tests replay: a podcast feed, whisper.cpp's JSON
 * output, and a fake runner that plays ffmpeg and whisper.cpp.
 *
 * @module
 */
import type { Runner } from "./stt.ts";

/** An RSS feed with two items, the newest with a transcript. */
export const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0">
<channel><title>Open &amp; Feed</title>
<item><title><![CDATA[Newest <b>one</b>]]></title><guid>g2</guid><pubDate>Mon, 26 Oct 2026 06:00:00 GMT</pubDate>
<enclosure url="http://media.test/2.mp3" type="audio/mpeg" length="5"/>
<podcast:transcript url="http://media.test/2.vtt" type="text/vtt"/></item>
<item><title>Older</title><guid>g1</guid><pubDate>Mon, 19 Oct 2026 06:00:00 GMT</pubDate>
<enclosure url='http://media.test/1.mp3' type='audio/mpeg'/></item>
</channel></rss>`;

/** whisper.cpp's `-oj` output for two segments and one empty one. */
export const WHISPER_JSON = JSON.stringify({
  result: { language: "en" },
  transcription: [
    {
      timestamps: { from: "00:00:00,000", to: "00:00:04,200" },
      offsets: { from: 0, to: 4200 },
      text: " Hello and welcome.",
    },
    { offsets: { from: 4200, to: 4300 }, text: " " },
    { offsets: { from: 4300, to: 9000 }, text: " Today: chapters." },
  ],
});

/** A runner that plays ffmpeg and whisper.cpp, writing whisper's JSON where -of says. */
export function fakeRunner(calls: string[][], whisperCode = 0): Runner {
  return (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd.includes("whisper")) {
      const base = args[args.indexOf("-of") + 1];
      if (whisperCode === 0) {
        Deno.writeTextFileSync(`${base}.json`, WHISPER_JSON);
      }
      return Promise.resolve({
        code: whisperCode,
        stdout: "",
        stderr: whisperCode ? "error: model not found" : "",
      });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
}
