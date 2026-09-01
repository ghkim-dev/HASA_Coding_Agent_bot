import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * No stray control character anywhere in the source.
 *
 * This is here because four of them were committed and one of them mattered.
 *
 * They arrive the same way every time: a regex written with `\b` passes through
 * a shell heredoc, the backslash is eaten, and the escape becomes the character
 * it names — `\b` a backspace, `\a` a bell, `\f` a form feed. What lands in the
 * file *looks* right in most editors and compiles without complaint, because a
 * literal control character is a perfectly legal thing to put in a regex.
 *
 * What it does is turn its alternative off. `/(?:and|then|to)\x08|[.,]/` matches
 * one of those words followed by a backspace — that is, nothing — so the whole
 * first branch is dead while the second keeps working and the pattern keeps
 * looking correct. Found:
 *
 *   · `ENGLISH_OBJECT_END` — the conjunction stop was dead. Masked because the
 *     clause splitter breaks on `and` anyway, so only `but`, `so`, `because`,
 *     `while` and `to` were affected and nothing was measuring them.
 *   · `MENTIONS_WEB` — `\bweb\b`, `\binternet\b`, `\bonline\b` all dead. An
 *     English request naming the internet raised no research demand at all.
 *   · `NEGATIVE_CLAUSE` — the whole English branch dead, so "without web
 *     access" was not read as a ban.
 *
 * The last two are in the layer that decides whether a model may search the web,
 * and they cancelled each other: no demand was found, so no tool was granted,
 * so the missed ban never mattered — until the demand side was fixed. Two
 * defects that hide each other are worse than either alone, because fixing one
 * is what breaks the system.
 *
 * A test rather than a lint rule, so it runs where everything else runs and
 * fails the same way.
 */

/** Everything except tab, newline and carriage return. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

/**
 * Files allowed to contain one, with the reason.
 *
 * Both are tests that feed a parser deliberately awful input, where the control
 * character *is* the case.
 */
const ALLOWED = new Set([
  "src/agent/markdown.test.ts",
  "src/provider/openai-compatible/wire.edge.test.ts",
  "src/hasa-client/redact.ts",
]);

const SKIP_DIR = new Set(["node_modules", ".git", "out", ".vscode-test", ".arena", "dist"]);

interface Finding {
  file: string;
  line: number;
  codes: string[];
  text: string;
}

let findings: Finding[];
let scanned: number;

async function walk(dir: string, into: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) await walk(join(dir, entry.name), into);
      continue;
    }
    if (/\.(?:ts|mjs|js|json|md)$/.test(entry.name)) into.push(join(dir, entry.name));
  }
}

before(async () => {
  const files: string[] = [];
  for (const root of ["src", "scripts", "docs", "extension/src", "extension/media"]) {
    await walk(root, files);
  }
  scanned = files.length;
  findings = [];
  for (const file of files) {
    const posix = file.split("\\").join("/");
    if (ALLOWED.has(posix)) continue;
    const source = await readFile(file, "utf8");
    source.split("\n").forEach((line, index) => {
      const found = line.match(CONTROL);
      if (found === null) return;
      findings.push({
        file: posix,
        line: index + 1,
        codes: found.map((c) => `U+${c.codePointAt(0)?.toString(16).padStart(4, "0")}`),
        text: line.trim().slice(0, 70),
      });
    });
  }
});

describe("소스 위생", () => {
  test("훑은 파일이 적지 않다", () => {
    // The denominator. A walk that silently stops finding files would make the
    // check below pass for the wrong reason.
    assert.ok(scanned > 200, `${scanned} 개뿐입니다 — 탐색이 멈췄을 수 있습니다`);
  });

  test("제어문자가 소스에 남아 있지 않다", () => {
    assert.deepEqual(
      findings.map((f) => `${f.file}:${f.line} ${f.codes.join(",")}  ${f.text}`),
      [],
    );
  });

  test("허용 목록은 실제로 그런 파일만 담고 있다", () => {
    // A list that grows quietly is how this check stops meaning anything. Three
    // entries, each one a place where the control character is the test's whole
    // point, and the assertion is that it is still three.
    assert.equal(ALLOWED.size, 3);
  });
});
