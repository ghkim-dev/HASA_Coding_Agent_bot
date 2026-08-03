import { inflateRawSync } from "node:zlib";

/**
 * Just enough ZIP to read a document.
 *
 * `.docx`, `.xlsx`, `.pptx` and `.hwpx` are all ZIP archives of XML, so reading
 * any of them starts here. Written rather than depended on because the
 * dependency list is two packages and adding an archive library to attach a
 * Word file is a poor trade — the format's central directory is a few dozen
 * lines and `node:zlib` already does the only hard part.
 *
 * Deliberately partial. Encryption, ZIP64, multi-disk archives and every
 * compression method except store and deflate are refused rather than guessed
 * at: a document this cannot read must say so, not return plausible rubbish.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

/** EOCD is 22 bytes plus a comment of up to 64 KiB. */
const MAX_COMMENT = 0xffff;

export class NotAZip extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "NotAZip";
  }
}

export interface ZipEntry {
  name: string;
  /** Uncompressed bytes. Read lazily, because most entries are never wanted. */
  read: () => Buffer;
}

function findEocd(buf: Buffer): number {
  // Scanned backwards: the signature can also occur inside file data, and the
  // last match is the real one.
  const earliest = Math.max(0, buf.length - MAX_COMMENT - 22);
  for (let i = buf.length - 22; i >= earliest; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/**
 * Lists what an archive holds, without decompressing any of it.
 *
 * The central directory is authoritative for names and offsets; the local
 * header is still read per entry, because only it says how long its own
 * variable-length fields are and therefore where the data starts.
 */
export function readZip(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  if (eocd === -1) throw new NotAZip("no end-of-central-directory record; this is not a zip archive");

  // A ZIP64 locator sits immediately before the EOCD. Refused rather than
  // half-supported: the 32-bit fields below would be truncated offsets, and
  // reading from a truncated offset produces garbage, not an error.
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIGNATURE) {
    throw new NotAZip("zip64 archives are not supported");
  }

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new NotAZip("central directory is malformed");
    }
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    // Bit 11 says the name is UTF-8. Without it the spec says CP437, but every
    // producer of these formats writes UTF-8 anyway, and the names wanted here
    // are ASCII paths like `word/document.xml`.
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLength);
    const encrypted = (flags & 0x1) !== 0;

    entries.push({
      name,
      read: () => {
        if (encrypted) throw new NotAZip(`${name} is encrypted`);
        if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
          throw new NotAZip(`${name} has no local header`);
        }
        const localName = buf.readUInt16LE(localOffset + 26);
        const localExtra = buf.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localName + localExtra;
        const data = buf.subarray(start, start + compressedSize);
        if (method === 0) return Buffer.from(data);
        if (method === 8) return inflateRawSync(data);
        throw new NotAZip(`${name} uses compression method ${method}`);
      },
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Whether these bytes begin like a zip archive. */
export function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === LOCAL_SIGNATURE;
}
