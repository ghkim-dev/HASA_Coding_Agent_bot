/**
 * Parses the light Markdown a model emits into blocks the panel can render.
 *
 * The prompt asks for prose, and prose is what should arrive. But an
 * instruction is not a guarantee — models reach for `**bold**` and numbered
 * outlines by habit, and the text-protocol models most of all. When that
 * happens the panel used to print the asterisks, so the user read the markup
 * instead of the sentence. Rendering it is the difference between a summary
 * that is merely formatted and one that is unreadable.
 *
 * Deliberately small. This is not a Markdown implementation: there are no
 * tables, no blockquotes, no reference links, no HTML passthrough. It covers
 * what a model actually produces when summarising a change, and everything it
 * does not recognise survives as the literal text the model wrote, which is the
 * correct failure — worse formatting, never lost words.
 *
 * Both nestings are real rather than flattened. An early version flattened
 * them, and each flattening told the user something untrue: emphasis around
 * `code` swallowed the backticks and showed them raw, and sub-bullets folded
 * into their parent list were renumbered as though they were top-level items.
 *
 * It lives here rather than in the webview because a parser is exactly the kind
 * of thing that is wrong in ways only a test finds.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] };

export interface ListItem {
  inlines: Inline[];
  /** Blocks indented under this item — nested lists, mostly. */
  children: Block[];
}

export type Block =
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "heading"; level: number; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; items: ListItem[] }
  | { kind: "code"; language: string | null; text: string };

const FENCE = /^(\s*)(?:```|~~~)\s*(\S*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const MARKER = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;

/**
 * Splits text into blocks.
 *
 * Fenced code is taken first and taken whole: everything between the fences is
 * content, so a line inside it that looks like a bullet is a bullet in the
 * user's code, not a list item.
 */
export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/g, "\n").split("\n"), 0);
}

/**
 * Parses lines at or beyond `indent`.
 *
 * `indent` is what makes nesting work: a list item's continuation is any line
 * indented past the marker, and those lines are handed back through here.
 */
function parseBlocks(lines: readonly string[], indent: number): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", inlines: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    const fence = FENCE.exec(line);
    if (fence !== null) {
      flushParagraph();
      const body: string[] = [];
      const strip = (fence[1] ?? "").length;
      i += 1;
      // An unterminated fence runs to the end rather than swallowing the text
      // into a paragraph — a model that streams a half-written block should
      // still show the code it has written so far.
      while (i < lines.length && FENCE.exec(lines[i] ?? "") === null) {
        body.push((lines[i] ?? "").slice(strip));
        i += 1;
      }
      const language = fence[2] ?? "";
      blocks.push({ kind: "code", language: language.length > 0 ? language : null, text: body.join("\n") });
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: (heading[1] ?? "#").length,
        inlines: parseInline(heading[2] ?? ""),
      });
      continue;
    }

    const marker = MARKER.exec(line);
    if (marker !== null) {
      flushParagraph();
      const consumed = parseList(lines, i, (marker[1] ?? "").length);
      blocks.push(consumed.list);
      i = consumed.next - 1;
      continue;
    }

    paragraph.push(line.slice(indent));
  }

  flushParagraph();
  return blocks;
}

/**
 * Collects one list, and recurses into whatever is indented under each item.
 *
 * A switch between bullet and number at the same indent starts a new list,
 * because that is what the model meant by changing it.
 */
function parseList(
  lines: readonly string[],
  start: number,
  indent: number,
): { list: Block; next: number } {
  const first = MARKER.exec(lines[start] ?? "");
  const ordered = first?.[3] !== undefined;
  const items: ListItem[] = [];
  let i = start;

  while (i < lines.length) {
    // A blank line between items makes a list loose, not finished. Treating it
    // as the end split the user's two-item outline into two lists, and the
    // second one restarted its numbering at 1.
    let probe = i;
    while (probe < lines.length && (lines[probe] ?? "").trim().length === 0) probe += 1;

    const marker = MARKER.exec(lines[probe] ?? "");
    if (marker === null) break;
    const at = (marker[1] ?? "").length;
    if (at !== indent) break;
    if ((marker[3] !== undefined) !== ordered) break;

    const inlines = parseInline(marker[4] ?? "");
    i = probe + 1;

    // Everything indented past this marker belongs to this item, blank lines
    // included, so a sub-list separated by one survives as a child.
    const nested: string[] = [];
    while (i < lines.length) {
      const line = lines[i] ?? "";
      const blank = line.trim().length === 0;
      const deeper = line.length - line.trimStart().length > indent;
      if (!blank && !deeper) break;
      // A blank line only continues the item if something indented follows it.
      if (blank) {
        const following = lines[i + 1] ?? "";
        const continues =
          following.trim().length > 0 && following.length - following.trimStart().length > indent;
        if (!continues) break;
      }
      nested.push(line);
      i += 1;
    }

    items.push({ inlines, children: nested.length > 0 ? parseBlocks(nested, indent + 1) : [] });
  }

  return { list: { kind: "list", ordered, items }, next: i };
}

/**
 * Splits a line into inline spans.
 *
 * Code spans are taken before emphasis, so `**` inside backticks stays as the
 * two characters the user's code contains. Emphasis recurses, so the backticks
 * in `**버퍼(`tmp`) 관리**` render as code rather than as themselves.
 */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let text = "";

  const flush = (): void => {
    if (text.length > 0) out.push({ kind: "text", text });
    text = "";
  };

  for (let i = 0; i < source.length; ) {
    const rest = source.slice(i);

    const code = /^(`+)([\s\S]*?)\1(?!`)/.exec(rest);
    if (code !== null && (code[2] ?? "").length > 0) {
      flush();
      out.push({ kind: "code", text: code[2] ?? "" });
      i += code[0].length;
      continue;
    }

    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong !== null) {
      flush();
      out.push({ kind: "strong", children: parseInline(strong[2] ?? "") });
      i += strong[0].length;
      continue;
    }

    // Underscores only delimit emphasis at a word boundary, so `snake_case_name`
    // survives intact — an identifier is the most common thing in this text.
    const em = /^\*(?=\S)([^*\n]*?\S)\*|^_(?=\S)([^_\n]*?\S)_(?![\w])/.exec(rest);
    if (em !== null && (i === 0 || /[^\w]/.test(source[i - 1] ?? " "))) {
      flush();
      out.push({ kind: "em", children: parseInline(em[1] ?? em[2] ?? "") });
      i += em[0].length;
      continue;
    }

    text += source[i];
    i += 1;
  }

  flush();
  return out;
}

/** The words, without any of the markup. Used where only text fits. */
export function toPlainText(blocks: readonly Block[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case "code":
          return block.text;
        case "list":
          return block.items
            .map((item) => [inlineText(item.inlines), toPlainText(item.children)].filter(Boolean).join("\n"))
            .join("\n");
        default:
          return inlineText(block.inlines);
      }
    })
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function inlineText(inlines: readonly Inline[]): string {
  return inlines.map((i) => (i.kind === "text" || i.kind === "code" ? i.text : inlineText(i.children))).join("");
}
