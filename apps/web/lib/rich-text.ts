// Notice bodies are a small Markdown subset: bold, italic, bullet and numbered
// lists, links and event images. This module parses that subset into plain
// data (never HTML) so every surface renders it the same safe way and the
// board can fall back to text. Old plain-text notices are valid input: a
// single line break is a line break, a blank line starts a paragraph.
// Image syntax: ![alt](file:<fileId>). Anything else (external image URLs,
// scripts, raw HTML) is shown as text or dropped, never executed or fetched.

export type Inline =
  | { t: "text"; v: string }
  | { t: "bold"; c: Inline[] }
  | { t: "italic"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "image"; fileId: string; alt: string }
  | { t: "br" };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; items: Inline[][] };

const FILE_ID = /^[A-Za-z0-9_-]{1,160}$/;
// Escape · image · link · bold · italic, earliest match wins. A URL may hold
// one level of parentheses, so a stray ")" never leaks into the text.
const INLINE =
  /\\([\\*_[\]()!#+\-.>~|`{}])|!\[([^\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))*)\)|\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))*)\)|\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*|\*(?=\S)([^*\n]+?)(?<=\S)\*/g;

export function safeHref(value: string): string | null {
  const href = value.trim();
  return /^(https?:\/\/|mailto:|tel:)[^\s<>"']+$/i.test(href) ? href : null;
}

function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  const text = (value: string) => {
    if (!value) return;
    const last = out[out.length - 1];
    if (last?.t === "text") last.v += value;
    else out.push({ t: "text", v: value });
  };
  let cursor = 0;
  for (const match of source.matchAll(INLINE)) {
    const index = match.index ?? 0;
    text(source.slice(cursor, index));
    cursor = index + match[0].length;
    const [, escaped, imageAlt, imageSrc, linkText, linkHref, bold, italic] = match;
    if (escaped !== undefined) text(escaped);
    else if (imageSrc !== undefined) {
      const id = imageSrc.startsWith("file:") ? imageSrc.slice(5) : "";
      if (FILE_ID.test(id)) out.push({ t: "image", fileId: id, alt: imageAlt ?? "" });
      else text(imageAlt ?? "");
    } else if (linkHref !== undefined) {
      const href = safeHref(linkHref);
      if (href) out.push({ t: "link", href, c: parseInline(linkText) });
      else out.push(...parseInline(linkText));
    } else if (bold !== undefined) out.push({ t: "bold", c: parseInline(bold) });
    else if (italic !== undefined) out.push({ t: "italic", c: parseInline(italic) });
  }
  text(source.slice(cursor));
  return out;
}

function lines(source: string): Inline[] {
  const out: Inline[] = [];
  source.split("\n").forEach((line, index) => {
    if (index > 0) out.push({ t: "br" });
    out.push(...parseInline(line));
  });
  return out;
}

export function parseRichText(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { kind: "ul" | "ol"; items: Inline[][] } | null = null;
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ t: "p", c: lines(paragraph.join("\n")) });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push({ t: list.kind, items: list.items });
    list = null;
  };
  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    // An empty paragraph from an editor can arrive as &nbsp;: it is only a blank line.
    if (!line.trim() || line.trim() === "&nbsp;") { flushParagraph(); flushList(); continue; }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const number = bullet ? null : line.match(/^\s*\d+[.)]\s+(.*)$/);
    const item = bullet ?? number;
    if (item) {
      flushParagraph();
      const kind = bullet ? "ul" : "ol";
      if (list && list.kind !== kind) flushList();
      list ??= { kind, items: [] };
      list.items.push(parseInline(item[1]));
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

function inlineText(nodes: Inline[]): string {
  return nodes.map((node) => {
    if (node.t === "text") return node.v;
    if (node.t === "br") return "\n";
    if (node.t === "image") return "";
    return inlineText(node.c);
  }).join("");
}

// Text only: no formatting marks, images dropped, list items as bullets. Used
// by the venue board and by one-line ledger summaries.
export function richPlainText(source: string): string {
  return parseRichText(source).map((block) => {
    if (block.t === "p") return inlineText(block.c).replace(/^\n+|\n+$/g, "");
    return block.items.map((item, index) => `${block.t === "ol" ? `${index + 1}.` : "•"} ${inlineText(item)}`).join("\n");
  }).filter(Boolean).join("\n\n");
}

export function richSummary(source: string): string {
  return richPlainText(source).replace(/\s+/g, " ").trim();
}

export function richImageIds(source: string): string[] {
  const ids: string[] = [];
  const walk = (nodes: Inline[]) => nodes.forEach((node) => {
    if (node.t === "image") { if (!ids.includes(node.fileId)) ids.push(node.fileId); }
    else if (node.t === "bold" || node.t === "italic" || node.t === "link") walk(node.c);
  });
  for (const block of parseRichText(source)) {
    if (block.t === "p") walk(block.c);
    else block.items.forEach(walk);
  }
  return ids;
}
