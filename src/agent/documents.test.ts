import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, deflateSync } from "node:zlib";
import { readZip, looksLikeZip, NotAZip } from "./zip.ts";
import { documentKindFor, extractDocument, UnreadableDocument, xmlText } from "./documents.ts";

/**
 * Reading the documents a user actually attaches.
 *
 * The fixtures are built here rather than checked in as binaries, so what each
 * test depends on is visible in the test. They are real archives — a real
 * central directory, real deflate — because the failure this guards against is
 * a reader that works on a hand-made shape and not on a file from Word.
 *
 * Verified separately against real documents on disk: two `.hwpx` and two
 * `.pptx` from a government/industry workflow extracted 2,499–18,595 characters
 * of correct Korean text, and two Korean `.pdf` files were correctly refused.
 */

// ---------------------------------------------------------------------------
// A zip writer, so the fixtures are archives rather than approximations.
// ---------------------------------------------------------------------------

function crc32(buf: Buffer): number {
  let table = crc32.table;
  if (table === undefined) {
    table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
    crc32.table = table;
  }
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ (table[(crc ^ byte) & 0xff] ?? 0);
  return (crc ^ -1) >>> 0;
}
crc32.table = undefined as Int32Array | undefined;

function zip(files: Record<string, string>, opts: { deflate?: boolean } = {}): Buffer {
  const method = opts.deflate === true ? 8 : 0;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, "utf8");
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, "utf8");

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); // utf-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

describe("the zip reader", () => {
  test("reads stored and deflated entries alike", () => {
    for (const deflate of [false, true]) {
      const entries = readZip(zip({ "a.txt": "hello", "b/c.txt": "world" }, { deflate }));
      assert.deepEqual(entries.map((e) => e.name), ["a.txt", "b/c.txt"]);
      assert.equal(entries[0]?.read().toString("utf8"), "hello");
      assert.equal(entries[1]?.read().toString("utf8"), "world");
    }
  });

  test("something that is not an archive is refused, not guessed at", () => {
    assert.throws(() => readZip(Buffer.from("this is a plain text file")), NotAZip);
  });

  test("names survive being non-ASCII", () => {
    const entries = readZip(zip({ "본문/내용.xml": "<a>가</a>" }));
    assert.equal(entries[0]?.name, "본문/내용.xml");
  });

  test("looksLikeZip is decided by the bytes, not the name", () => {
    assert.equal(looksLikeZip(zip({ "a.txt": "x" })), true);
    assert.equal(looksLikeZip(Buffer.from("%PDF-1.4")), false);
  });
});

describe("xml to text", () => {
  test("entities are decoded, including numeric ones", () => {
    assert.equal(xmlText("<t>a &amp; b &#65; &#x44;</t>", []), "a & b A D");
  });

  test("a tag named as a break becomes a newline", () => {
    assert.equal(xmlText("<w:p><w:t>a</w:t></w:p><w:p><w:t>b</w:t></w:p>", ["w:p"]).trim(), "a\nb");
  });

  test("a comment cannot introduce a break that is not in the document", () => {
    assert.equal(xmlText("<w:t>a<!-- </w:p> -->b</w:t>", ["w:p"]), "ab");
  });
});

// ---------------------------------------------------------------------------

const DOCX = {
  "[Content_Types].xml": "<Types/>",
  "word/document.xml":
    '<?xml version="1.0"?><w:document><w:body>' +
    "<w:p><w:r><w:t>사양서</w:t></w:r></w:p>" +
    "<w:p><w:r><w:t>첫 번째 요구사항</w:t></w:r></w:p>" +
    "</w:body></w:document>",
};

const XLSX = {
  "xl/sharedStrings.xml": "<sst><si><t>이름</t></si><si><t>수량</t></si><si><t>볼트</t></si></sst>",
  "xl/worksheets/sheet1.xml":
    "<worksheet><sheetData>" +
    '<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>' +
    '<row><c t="s"><v>2</v></c><c><v>42</v></c></row>' +
    "</sheetData></worksheet>",
};

const PPTX = {
  "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>제목</a:t></a:r></a:p></p:sld>",
  "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>두 번째 장</a:t></a:r></a:p></p:sld>",
};

const HWPX = {
  "Contents/section0.xml": "<hs:sec><hp:p><hp:t>공고문</hp:t></hp:p><hp:p><hp:t>□ 추진목적</hp:t></hp:p></hs:sec>",
};

/** The refusal itself, so a test can assert what the user would be told. */
function refusal(fn: () => unknown): UnreadableDocument {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof UnreadableDocument, `expected a refusal, got ${String(err)}`);
    return err;
  }
  return assert.fail("expected the document to be refused, but it was read");
}

describe("Office and HWPX", () => {
  test("a Word document becomes its paragraphs", () => {
    const { text, kind } = extractDocument("spec.docx", zip(DOCX, { deflate: true }));
    assert.equal(kind, "docx");
    assert.equal(text, "사양서\n첫 번째 요구사항");
  });

  test("a spreadsheet resolves its shared strings", () => {
    // Without the shared-string table every text cell is an integer, and the
    // model reads a table of indexes as if they were data.
    const { text } = extractDocument("parts.xlsx", zip(XLSX, { deflate: true }));
    assert.match(text, /이름\t수량/);
    assert.match(text, /볼트\t42/);
  });

  test("slides are numbered, because 'slide 3 says' has to mean something", () => {
    const { text } = extractDocument("deck.pptx", zip(PPTX, { deflate: true }));
    assert.match(text, /--- 슬라이드 1 ---\n제목/);
    assert.match(text, /--- 슬라이드 2 ---\n두 번째 장/);
  });

  test("an HWPX document becomes its paragraphs", () => {
    const { text, kind } = extractDocument("공고.hwpx", zip(HWPX, { deflate: true }));
    assert.equal(kind, "hwpx");
    assert.equal(text, "공고문\n□ 추진목적");
  });

  test("sections and sheets are read in numeric order, not lexical", () => {
    // `section10.xml` sorts before `section2.xml` as a string, which silently
    // reorders a long document.
    const many: Record<string, string> = {};
    for (const n of [0, 1, 2, 10, 11]) many[`Contents/section${n}.xml`] = `<hp:p><hp:t>S${n}</hp:t></hp:p>`;
    const { text } = extractDocument("long.hwpx", zip(many));
    // Order is the claim; the blank line between sections is just formatting.
    assert.deepEqual(text.split("\n").filter((line) => line.length > 0), ["S0", "S1", "S2", "S10", "S11"]);
  });
});

describe("documents that cannot be read say so", () => {
  test("a renamed legacy file is named as such, not parsed as a zip", () => {
    // `.doc` saved as `.docx` is the single most common version of this.
    const err = refusal(
      () => extractDocument("old.docx", Buffer.from("\xd0\xcf\x11\xe0 legacy compound file", "latin1")),
    );
    assert.match(err.userMessage, /DOCX 형식이 아닙니다/);
  });

  test("a legacy .hwp is refused with the conversion that works", () => {
    const err = refusal(
      () => extractDocument("보고서.hwp", Buffer.from("\xd0\xcf\x11\xe0", "latin1")),
    );
    assert.match(err.userMessage, /hwpx/i);
  });

  test("an archive with no body is not reported as an empty document", () => {
    // "The model read it and it was blank" and "the model never read it" lead
    // the user to opposite conclusions, so they must not look the same.
    assert.throws(() => extractDocument("empty.docx", zip({ "docProps/app.xml": "<x/>" })), UnreadableDocument);
  });

  test("a format nobody claimed is refused by name", () => {
    assert.throws(() => extractDocument("notes.rtf", Buffer.from("{\\rtf1}")), UnreadableDocument);
  });

  test("documentKindFor knows the macro variants too", () => {
    assert.equal(documentKindFor("a.docm"), "docx");
    assert.equal(documentKindFor("a.xlsm"), "xlsx");
    assert.equal(documentKindFor("a.PPTX"), "pptx");
    assert.equal(documentKindFor("a.txt"), null);
  });
});

// ---------------------------------------------------------------------------

/** A single-page PDF whose content stream is real, in either encoding. */
function pdf(text: string, opts: { compress?: boolean } = {}): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const stream = opts.compress === true ? deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n4 0 obj<</Length 0>>stream\n", "latin1"),
    stream,
    Buffer.from("\nendstream endobj\ntrailer<</Root 1 0 R>>\n%%EOF", "latin1"),
  ]);
}

describe("PDF", () => {
  const SENTENCE =
    "This document describes the deployment procedure for the cluster and the rollback plan.";

  test("text is read out of an uncompressed content stream", () => {
    const { text, kind } = extractDocument("plan.pdf", pdf(SENTENCE));
    assert.equal(kind, "pdf");
    assert.match(text, /deployment procedure/);
  });

  test("and out of a FlateDecode one, which is what real files use", () => {
    // The first attempt read only uncompressed streams. Because most are
    // compressed, it scanned the compressed bytes for `(...)` instead and a real
    // file came back as 247,000 characters of binary noise that passed for text.
    const { text } = extractDocument("plan.pdf", pdf(SENTENCE, { compress: true }));
    assert.match(text, /rollback plan/);
  });

  test("binary that is not text is refused rather than returned", () => {
    // The regression above, as a test. Random bytes contain plenty of letters.
    const noise = Buffer.alloc(20_000);
    for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 37 + 11) % 256;
    const err = refusal(
      () =>
        extractDocument(
          "scan.pdf",
          Buffer.concat([Buffer.from("%PDF-1.4\nstream\nBT (", "latin1"), noise, Buffer.from(") Tj\nendstream", "latin1")]),
        ),
    );
    assert.match(err.userMessage, /추출하지 못했습니다/);
  });

  test("a stream that draws no text is not mined for parentheses", () => {
    // An image or font stream has no `BT`, and its bytes are data. This is the
    // check that separates content from everything else in the file.
    assert.throws(
      () =>
        extractDocument(
          "images.pdf",
          Buffer.from("%PDF-1.4\nstream\n(nonsense) (more nonsense) (still more)\nendstream", "latin1"),
        ),
      UnreadableDocument,
    );
  });

  test("an encrypted PDF is named as encrypted", () => {
    const err = refusal(
      () => extractDocument("locked.pdf", Buffer.from("%PDF-1.4\n<</Encrypt 9 0 R>>\n", "latin1")),
    );
    assert.match(err.userMessage, /암호/);
  });

  test("something that is not a PDF at all is refused first", () => {
    assert.throws(() => extractDocument("x.pdf", Buffer.from("<html>")), UnreadableDocument);
  });
});
