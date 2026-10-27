import { assertEquals } from "jsr:@std/assert@1.0.13";
import {
  clock,
  decodeEntities,
  fileSegment,
  notesFromHtml,
  safeMarkdown,
  slug,
} from "./notes.ts";

Deno.test("HTML notes become text with Markdown links and list items", () => {
  const n = notesFromHtml(
    '<p>Hello &amp; <b>welcome</b>.</p><p>Read <a href="https://x.test/a?b=1&amp;c=2">this</a></p><ul><li>One</li><li>Two</li></ul><script>alert(1)</script>',
  );
  assertEquals(
    n.text,
    "Hello & **welcome**.\n\nRead [this](https://x.test/a?b=1&c=2)\n\n- One\n- Two",
  );
  assertEquals(n.links, [{ text: "this", url: "https://x.test/a?b=1&c=2" }]);
});

Deno.test("links that are not http, https or mailto are text only", () => {
  const n = notesFromHtml(
    '<a href="javascript:alert(1)">click</a> <a href="mailto:a@b.test">mail</a>',
  );
  assertEquals(n.text, "click [mail](mailto:a@b.test)");
  assertEquals(n.links.map((l) => l.url), ["mailto:a@b.test"]);
});

Deno.test("plain notes keep their lines and yield their URLs once", () => {
  const n = notesFromHtml(
    "Line one https://a.test/x.\nLine two https://a.test/x",
  );
  assertEquals(n.text, "Line one https://a.test/x.\nLine two https://a.test/x");
  assertEquals(n.links, [{
    text: "https://a.test/x",
    url: "https://a.test/x",
  }]);
});

Deno.test("entities decode, unknown ones stay", () => {
  assertEquals(decodeEntities("&#x41;&#66;&hellip;&bogus;"), "AB…&bogus;");
});

Deno.test("slug, file segment and clock", () => {
  assertEquals(slug("Café crème, Ånd"), "cafe-creme-and");
  assertEquals(slug("Hello, World"), "hello-world");
  assertEquals(slug("!!!"), "untitled");
  assertEquals(fileSegment('A/B: "c" #1 [x]'), "A B c 1 x");
  assertEquals(fileSegment("..hidden"), "hidden");
  assertEquals(clock(59), "0:59");
  assertEquals(clock(3725), "1:02:05");
});

Deno.test("file segments are capped in bytes, Markdown is made inert", () => {
  const long = "語".repeat(100);
  const seg = fileSegment(long);
  assertEquals(new TextEncoder().encode(seg).length <= 180, true);
  assertEquals(seg.length, 60);
  assertEquals(
    safeMarkdown('Hi <img src="https://x.test/b"> ![t](https://x.test/p.png)'),
    'Hi &lt;img src="https://x.test/b"> [t](https://x.test/p.png)',
  );
});
