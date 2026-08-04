/**
 * A web page as the text of it.
 *
 * Not a renderer and not a parser: a page reaches the model to be read, so what
 * matters is that the sentences survive in order, the code blocks survive
 * verbatim, and the navigation chrome does not eat the context window. Layout
 * does not matter at all.
 *
 * Written here rather than depended on for the same reason `zip.ts` was: the
 * dependency list is two packages, and an HTML parser to read a documentation
 * page is a poor trade when the job is "drop the tags and keep the text".
 */

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  divide: "÷",
  eacute: "é",
  egrave: "è",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  szlig: "ß",
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Elements whose contents are not prose and must not be read as it. */
const DROPPED = ["script", "style", "noscript", "svg", "template", "iframe", "canvas"];

/** Elements that end a line of text. */
const BLOCK =
  "p|div|section|article|header|footer|nav|aside|main|h[1-6]|li|tr|br|hr|blockquote|pre|figure|figcaption|form|table|thead|tbody|ul|ol|dl|dt|dd";

export interface PageText {
  title: string | null;
  text: string;
}

/**
 * Reduces a page to its readable text, with `<pre>` blocks kept as code.
 *
 * The main-content guess is deliberately crude — `<main>` or `<article>` when
 * one exists, the body otherwise. A documentation page that marks its content
 * correctly gets a clean read; one that does not still gets everything, which
 * is the right way round for a fallback.
 */
export function htmlToText(html: string): PageText {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];

  let body = html;
  for (const tag of DROPPED) {
    body = body.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, "gi"), " ");
    // A self-closing or unclosed one would otherwise leave its opening tag to be
    // stripped as an ordinary tag, which is harmless, and its attributes with it.
  }
  body = body.replace(/<!--[\s\S]*?-->/g, " ");

  const main =
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(body)?.[1] ??
    /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(body)?.[1] ??
    /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(body)?.[1] ??
    body;

  // Code is fenced before the tags go, because indentation and line breaks
  // inside `<pre>` are the content — a code sample flattened into a paragraph is
  // worse than no code sample.
  let text = main.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code: string) => {
    const plain = decodeHtmlEntities(code.replace(/<[^>]*>/g, ""));
    return `\n\n\`\`\`\n${plain.replace(/^\n+|\n+$/g, "")}\n\`\`\`\n\n`;
  });

  text = text.replace(new RegExp(`</?(?:${BLOCK})\\b[^>]*>`, "gi"), "\n");
  text = text.replace(/<[^>]*>/g, "");
  text = decodeHtmlEntities(text);

  return {
    title: title === undefined ? null : decodeHtmlEntities(title.replace(/<[^>]*>/g, "")).trim() || null,
    text: tidy(text),
  };
}

export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
