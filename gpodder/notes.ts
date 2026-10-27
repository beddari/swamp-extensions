/**
 * Show notes as feeds publish them, HTML of every quality, turned into
 * Markdown-flavoured plain text and the list of links they carry; plus the
 * file names and slugs the exports use. No dependency and no DOM: a feed's
 * HTML is read for its text and its links, never rendered.
 *
 * @module
 */

/** A link found in show notes. */
export interface NoteLink {
  text: string;
  url: string;
}

/** Show notes as text, and their links. */
export interface Notes {
  text: string;
  links: NoteLink[];
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
};

/** Decode HTML character references; an unknown one is left as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X"
        ? parseInt(ref.slice(2), 16)
        : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(
    `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : null;
}

/** Only links a reader can follow are kept: http, https and mailto. */
function followable(url: string): boolean {
  return /^(https?:|mailto:)/i.test(url.trim());
}

/**
 * Show notes as Markdown-flavoured text: paragraphs and line breaks kept,
 * list items as `- `, headings as `## `, links as `[text](url)`, scripts and
 * styles dropped, whitespace collapsed. Text without markup passes through
 * with its line breaks.
 */
export function notesFromHtml(html: string): Notes {
  const links: NoteLink[] = [];
  const seen = new Set<string>();
  if (!/<[a-z!/]/i.test(html)) {
    const text = decodeEntities(html).replace(/\r\n?/g, "\n")
      .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    for (const m of text.matchAll(/https?:\/\/[^\s<>()"']+/g)) {
      const url = m[0].replace(/[.,;:!?]+$/, "");
      if (!seen.has(url)) {
        seen.add(url);
        links.push({ text: url, url });
      }
    }
    return { text, links };
  }
  let s = html.replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/\s+/g, " ");
  s = s.replace(
    /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi,
    (_whole, attrs: string, inner: string) => {
      const href = attr(`<a ${attrs}>`, "href");
      const text = decodeEntities(inner.replace(/<[^>]*>/g, "")).trim();
      if (!href || !followable(href)) return text;
      const url = href.trim();
      if (!seen.has(url)) {
        seen.add(url);
        links.push({ text: text || url, url });
      }
      return text && text !== url ? `[${text}](${url})` : url;
    },
  );
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<h[1-6]\b[^>]*>/gi, "\n\n## ")
    .replace(
      /<\/(p|div|ul|ol|h[1-6]|blockquote|table|tr|section)\s*>/gi,
      "\n\n",
    )
    .replace(/<(p|div|ul|ol|blockquote|table|tr|section)\b[^>]*>/gi, "\n\n")
    .replace(/<\/?(strong|b)\b[^>]*>/gi, "**")
    .replace(/<\/?(em|i)\b[^>]*>/gi, "_")
    .replace(/<[^>]*>/g, "");
  const text = decodeEntities(s)
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\*\*\s*\*\*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, links };
}

/** A lowercase ASCII slug: letters, digits and single dashes. */
export function slug(s: string, max = 60): string {
  const out = s.normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out.slice(0, max).replace(/-+$/, "") || "untitled";
}

/**
 * A title as one path segment: readable, Unicode kept, with nothing a file
 * system or Obsidian treats specially (`/ \ : * ? " < > | # ^ [ ]` and
 * control characters), no leading dot, at most `max` characters and
 * `maxBytes` bytes of UTF-8.
 */
export function fileSegment(s: string, max = 100, maxBytes = 180): string {
  // Control characters are what this strips, so the range is meant.
  // deno-lint-ignore no-control-regex
  const out = s.replace(/[\u0000-\u001f\u007f/\\:*?"<>|#^[\]]+/g, " ")
    .replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  // File names are limited in bytes (255 on APFS and ext4), not characters:
  // a long title in a script of three-byte characters is cut by bytes too.
  const enc = new TextEncoder();
  const chars = Array.from(out).slice(0, max);
  while (chars.length && enc.encode(chars.join("")).length > maxBytes) {
    chars.pop();
  }
  return chars.join("").trim() || "untitled";
}

/**
 * Text from a feed or a model made safe to put in a Markdown note: raw HTML
 * becomes text (`<` escaped), and an image (`![...](...)`) becomes a plain
 * link, so a note never loads anything from the network when it is opened.
 */
export function safeMarkdown(s: string): string {
  return s.replace(/</g, "&lt;").replace(/!\[/g, "[");
}

/** Seconds as `h:mm:ss`, or `m:ss` under an hour. */
export function clock(totalSec: number): string {
  const t = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
