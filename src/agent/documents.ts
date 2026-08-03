import { inflateSync } from "node:zlib";
import { NotAZip, looksLikeZip, readZip, type ZipEntry } from "./zip.ts";

/**
 * Turning a document into text the model can read.
 *
 * A user attaching a spec does not care that `.docx` is a zip of XML; they care
 * that the agent read it. So every format supported here ends at the same place
 * — plain text, inlined into the prompt like any other text attachment — and the
 * ones that cannot be read say why rather than arriving as mojibake.
 *
 * The rule from `attachments.ts` carries over and is the reason this file is
 * careful: an attachment must never be silently dropped or silently mangled. A
 * document that extracts to nothing is reported as unreadable, because "the
 * model saw an empty file" and "the model saw the file" produce very different
 * answers to the same question and the user cannot tell them apart.
 *
 * No new dependencies. Office and HWPX are zip+XML, which `zip.ts` and a
 * tag-stripper handle; PDF is done as far as it can honestly be done without a
 * parser, and refused clearly when that is not far enough.
 */

export class UnreadableDocument extends Error {
  /** Shown to the user, in their language. */
  readonly userMessage: string;
  constructor(userMessage: string, detail?: string) {
    super(detail ?? userMessage);
    this.name = "UnreadableDocument";
    this.userMessage = userMessage;
  }
}

export type DocumentKind = "docx" | "xlsx" | "pptx" | "hwpx" | "hwp" | "pdf";

/** What a file name claims to be. Confirmed against the bytes before use. */
export function documentKindFor(name: string): DocumentKind | null {
  switch (/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()) {
    case "docx":
    case "docm":
      return "docx";
    case "xlsx":
    case "xlsm":
      return "xlsx";
    case "pptx":
    case "pptm":
      return "pptx";
    case "hwpx":
      return "hwpx";
    case "hwp":
      return "hwp";
    case "pdf":
      return "pdf";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Text out of an XML document, with the tags that mean "new line" honoured.
 *
 * Structure is not preserved beyond line breaks, and that is deliberate. A
 * model reading a specification needs the sentences in order; a faithful
 * rendering of Word's paragraph properties would be mostly noise, and noise in
 * a prompt costs the same as content.
 */
export function xmlText(xml: string, breakAfter: readonly string[]): string {
  // Comments and processing instructions first, so a `<!-- <w:p> -->` inside one
  // cannot introduce a break that is not in the document.
  let text = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "");
  for (const tag of breakAfter) {
    text = text.replace(new RegExp(`</${tag}>|<${tag}/>|<${tag} [^>]*/>`, "g"), "\n");
  }
  text = text.replace(/<[^>]*>/g, "");
  return decodeEntities(text);
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Office Open XML, and HWPX which is built the same way
// ---------------------------------------------------------------------------

function entry(entries: readonly ZipEntry[], name: string): ZipEntry | null {
  return entries.find((e) => e.name === name) ?? null;
}

/** Entries matching a pattern, in the numeric order a reader would see them. */
function ordered(entries: readonly ZipEntry[], pattern: RegExp): ZipEntry[] {
  const number = (name: string): number => Number(/(\d+)/.exec(name)?.[1] ?? 0);
  return entries.filter((e) => pattern.test(e.name)).sort((a, b) => number(a.name) - number(b.name));
}

function readDocx(entries: readonly ZipEntry[]): string {
  const document = entry(entries, "word/document.xml");
  if (document === null) throw new UnreadableDocument("Word 문서에서 본문(word/document.xml)을 찾지 못했습니다.");
  // `w:p` is a paragraph and `w:br` a line break; `w:tab` keeps table cells and
  // indented lists from running into one word.
  const body = xmlText(document.read().toString("utf8"), ["w:p", "w:br"]).replace(/<w:tab\/>/g, "\t");
  return tidy(body);
}

function readPptx(entries: readonly ZipEntry[]): string {
  const slides = ordered(entries, /^ppt\/slides\/slide\d+\.xml$/);
  if (slides.length === 0) throw new UnreadableDocument("PowerPoint 문서에서 슬라이드를 찾지 못했습니다.");
  const out: string[] = [];
  for (const [index, slide] of slides.entries()) {
    // `a:p` is a paragraph inside a shape's text body.
    const text = tidy(xmlText(slide.read().toString("utf8"), ["a:p", "a:br"]));
    out.push(`--- 슬라이드 ${index + 1} ---\n${text}`);
  }
  return out.join("\n\n");
}

/**
 * A spreadsheet, as rows of tab-separated cells.
 *
 * Most strings live in a shared table and the sheet holds indexes into it, so
 * the table is read first or every text cell comes out as a number.
 */
function readXlsx(entries: readonly ZipEntry[]): string {
  const sharedEntry = entry(entries, "xl/sharedStrings.xml");
  const shared: string[] = [];
  if (sharedEntry !== null) {
    const xml = sharedEntry.read().toString("utf8");
    for (const [, item] of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(tidy(xmlText(item ?? "", [])));
    }
  }

  const sheets = ordered(entries, /^xl\/worksheets\/sheet\d+\.xml$/);
  if (sheets.length === 0) throw new UnreadableDocument("Excel 문서에서 시트를 찾지 못했습니다.");

  const out: string[] = [];
  for (const [index, sheet] of sheets.entries()) {
    const xml = sheet.read().toString("utf8");
    const rows: string[] = [];
    for (const [, row] of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const match of (row ?? "").matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = match[1] ?? "";
        const inner = match[2] ?? "";
        const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
        if (/\bt="s"/.test(attrs)) {
          cells.push(shared[Number(value)] ?? "");
        } else if (/\bt="inlineStr"/.test(attrs)) {
          cells.push(tidy(xmlText(inner, [])));
        } else {
          cells.push(decodeEntities(value));
        }
      }
      // A row of nothing but empty cells is layout, not data.
      if (cells.some((c) => c.length > 0)) rows.push(cells.join("\t"));
    }
    out.push(`--- 시트 ${index + 1} ---\n${rows.join("\n")}`);
  }
  return out.join("\n\n");
}

/**
 * HWPX — the open, zipped HWP.
 *
 * Same shape as OOXML: sections of XML under `Contents/`. `hp:p` is a paragraph
 * and `hp:t` a text run, so paragraphs are the break and everything else is
 * markup.
 */
function readHwpx(entries: readonly ZipEntry[]): string {
  const sections = ordered(entries, /^Contents\/section\d+\.xml$/i);
  if (sections.length === 0) throw new UnreadableDocument("HWPX 문서에서 본문(Contents/section*.xml)을 찾지 못했습니다.");
  return tidy(sections.map((s) => xmlText(s.read().toString("utf8"), ["hp:p", "hp:lineBreak"])).join("\n"));
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/**
 * Text out of a PDF, as far as that goes without a real parser.
 *
 * A PDF's content stream holds drawing operators, and text arrives through `Tj`
 * and `TJ` with the glyphs in a string. That much is readable. What is not, in
 * anything short of a font-aware parser, is a document whose fonts use a custom
 * encoding — the bytes are glyph indexes and mean nothing without the embedded
 * CMap — or one that is a scan, where there is no text at all, only an image.
 *
 * So this extracts what it can and *refuses* when the result is too thin to
 * trust, rather than handing the model a page of ligature fragments and letting
 * it draw conclusions. The refusal names the workaround, because there is a good
 * one: copy the text out and paste it.
 */
function readPdf(buf: Buffer): string {
  if (!buf.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new UnreadableDocument("PDF 파일이 아닙니다.");
  }
  if (/\/Encrypt\b/.test(buf.toString("latin1", 0, Math.min(buf.length, 4096)))) {
    throw new UnreadableDocument("암호가 걸린 PDF는 읽을 수 없습니다.");
  }

  const pieces: string[] = [];
  // Streams are located by scanning, then decompressed if they will decompress.
  // Most content streams are FlateDecode, and the first attempt at this read
  // only the uncompressed ones — which meant scanning *compressed* bytes for
  // `(...)` and finding thousands of accidental matches. A real document came
  // back as 247,000 characters of binary noise that passed for text.
  for (const match of buf.toString("latin1").matchAll(/stream\r?\n?/g)) {
    const start = match.index + match[0].length;
    const end = buf.indexOf("endstream", start, "latin1");
    if (end === -1) continue;

    const body = decompress(buf.subarray(start, end)).toString("latin1");
    // `BT` opens a text object. A stream without one draws no text, and its
    // parentheses are data — an image, a font, an embedded file. This single
    // check is what separates content from the noise above.
    if (!/\bBT\b/.test(body)) continue;

    // `(text) Tj` and `[(a) -20 (b)] TJ`, which is the same text with kerning.
    for (const literal of body.matchAll(/\((?:\\.|[^\\()])*\)/g)) {
      pieces.push(
        literal[0]
          .slice(1, -1)
          .replace(/\\([nrtbf])/g, (_, c: string) => ({ n: "\n", r: "\r", t: "\t", b: "", f: "\n" })[c] ?? "")
          .replace(/\\([0-7]{1,3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)))
          .replace(/\\(.)/g, "$1"),
      );
    }
  }

  const text = tidy(pieces.join(" "));
  if (!looksLikeProse(text)) {
    // A scan, or — far more common in Korean documents — fonts with a custom
    // CID encoding, where the bytes are glyph indexes and mean nothing without
    // the embedded CMap. Reading that needs a font-aware parser; guessing at it
    // produces confident nonsense, which is the one outcome worth refusing.
    throw new UnreadableDocument(
      "이 PDF에서는 텍스트를 추출하지 못했습니다. 스캔 이미지이거나, 글꼴이 자체 인코딩을 써서 " +
        "본문을 읽으려면 글꼴 정보까지 해석해야 하는 경우입니다. PDF 뷰어에서 텍스트를 복사해 붙여넣거나, " +
        "원본이 있다면 원본 문서를 첨부해 주세요.",
    );
  }
  return text;
}

/** FlateDecode, or the bytes unchanged when they are not compressed. */
function decompress(bytes: Buffer): Buffer {
  try {
    return inflateSync(bytes);
  } catch {
    return bytes;
  }
}

/**
 * Whether extracted characters are text rather than debris.
 *
 * Counting letters was not enough: binary treated as latin1 is full of them, and
 * a quarter of a megabyte of that cleared a "20 letters" floor without
 * difficulty. What binary does not do is *stay* inside the small set of
 * characters real prose uses, so the test is a ratio rather than a count.
 */
function looksLikeProse(text: string): boolean {
  if (text.length < 40) return false;
  const plausible = text.replace(/[^\p{L}\p{N}\p{P}\p{Zs}\n\t]/gu, "").length;
  const letters = text.replace(/[^\p{L}]/gu, "").length;
  return plausible / text.length > 0.95 && letters >= 40;
}

// ---------------------------------------------------------------------------

export interface ExtractedDocument {
  text: string;
  kind: DocumentKind;
  /** Set when the text is complete but the shape of it was flattened. */
  note: string | null;
}

/**
 * Reads a document into text, or explains why it could not.
 *
 * The declared kind is checked against the bytes: a `.docx` that is not a zip is
 * usually a `.doc` someone renamed, and saying so is more useful than a stack
 * trace about a missing central directory.
 */
export function extractDocument(name: string, bytes: Buffer): ExtractedDocument {
  const kind = documentKindFor(name);
  if (kind === null) throw new UnreadableDocument(`${name} 형식은 문서로 읽을 수 없습니다.`);

  if (kind === "pdf") return { text: readPdf(bytes), kind, note: null };

  if (kind === "hwp") {
    // The legacy binary format: an OLE compound file of compressed records, and
    // a different problem entirely from the zipped one. Refused rather than
    // half-read, with the conversion that actually works.
    throw new UnreadableDocument(
      "구버전 한글 파일(.hwp)은 아직 읽지 못합니다. 한글에서 .hwpx 또는 PDF로 저장한 뒤 첨부해 주세요.",
    );
  }

  if (!looksLikeZip(bytes)) {
    throw new UnreadableDocument(
      `${name} 은(는) ${kind.toUpperCase()} 형식이 아닙니다. 확장자만 바뀐 구버전 파일일 수 있습니다.`,
    );
  }

  let entries: ZipEntry[];
  try {
    entries = readZip(bytes);
  } catch (err) {
    if (err instanceof NotAZip) throw new UnreadableDocument(`${name} 을(를) 열지 못했습니다: ${err.message}`);
    throw err;
  }

  const text =
    kind === "docx"
      ? readDocx(entries)
      : kind === "xlsx"
        ? readXlsx(entries)
        : kind === "pptx"
          ? readPptx(entries)
          : readHwpx(entries);

  if (text.trim().length === 0) {
    throw new UnreadableDocument(`${name} 에서 읽을 수 있는 텍스트를 찾지 못했습니다.`);
  }
  return {
    text,
    kind,
    note:
      kind === "xlsx"
        ? "표는 탭으로 구분된 행으로 변환되었습니다. 수식이 아니라 계산된 값입니다."
        : kind === "pptx"
          ? "슬라이드별 텍스트만 추출되었습니다. 도형 위치와 서식은 포함되지 않습니다."
          : null,
  };
}
