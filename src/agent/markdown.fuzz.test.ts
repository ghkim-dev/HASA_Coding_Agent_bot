import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { forEachSeed, fuzzIterations, type Rng } from "../testing/fuzz.ts";
import { parseMarkdown, toPlainText, type Block, type Inline } from "./markdown.ts";

/**
 * The Markdown renderer, over generated documents.
 *
 * The rule this protects is the one a hand-written test cannot cover
 * exhaustively: **no word is ever lost.** The parser sits between the model and
 * the user, and formatting it does not understand must degrade to the literal
 * text the model wrote — never to silence. A dropped sentence in a summary is
 * invisible, unfalsifiable from the user's side, and indistinguishable from the
 * model having not said it.
 *
 * Everything generated here is something a model plausibly emits when
 * summarising a change: prose with emphasis, nested outlines, fenced code, and
 * the half-written block that arrives mid-stream.
 */

const WORDS = [
  "session", "패치", "handler", "타입", "retry", "캐시", "diff", "모델",
  "assertion", "경계", "timeout", "파일", "wire", "승인", "sandbox",
];

/** A token that is markup to the parser, used to make prose ambiguous. */
const TRICKY = ["*", "**", "_", "`", "#", "-", "1.", "```", "~~~", ">", "|", "[", "]"];

function words(rng: Rng, count: number): string {
  return Array.from({ length: count }, () => rng.pick(WORDS)).join(" ");
}

function inlineText(rng: Rng): string {
  const parts: string[] = [];
  for (let i = 0; i < rng.int(1, 6); i += 1) {
    const word = rng.pick(WORDS);
    switch (rng.int(0, 5)) {
      case 0: parts.push(`**${word}**`); break;
      case 1: parts.push(`*${word}*`); break;
      case 2: parts.push(`\`${word}\``); break;
      // Deliberately unbalanced: the parser must keep the characters rather
      // than swallow the word waiting for a partner that never comes.
      case 3: parts.push(`${rng.pick(TRICKY)}${word}`); break;
      default: parts.push(word);
    }
  }
  return parts.join(" ");
}

function document(rng: Rng): string {
  const lines: string[] = [];
  for (let block = 0; block < rng.int(1, 8); block += 1) {
    switch (rng.int(0, 6)) {
      case 0:
        lines.push(`${"#".repeat(rng.int(1, 6))} ${inlineText(rng)}`, "");
        break;
      case 1: {
        const ordered = rng.bool();
        for (let i = 0; i < rng.int(1, 5); i += 1) {
          lines.push(`${ordered ? `${i + 1}.` : "-"} ${inlineText(rng)}`);
          for (let sub = 0; sub < rng.int(0, 3); sub += 1) {
            lines.push(`   - ${inlineText(rng)}`);
          }
        }
        lines.push("");
        break;
      }
      case 2:
        lines.push("```" + (rng.bool() ? rng.pick(["py", "ts", "js", ""]) : ""));
        for (let i = 0; i < rng.int(1, 5); i += 1) lines.push(`  ${words(rng, rng.int(1, 6))}`);
        // Sometimes unterminated — what a half-streamed block looks like.
        if (rng.bool(0.8)) lines.push("```");
        lines.push("");
        break;
      case 3:
        lines.push(rng.pick(TRICKY).repeat(rng.int(1, 4)), "");
        break;
      default:
        lines.push(inlineText(rng), "");
    }
  }
  return lines.join("\n");
}

/** Every character the source contains that is not a markup delimiter. */
function meaningful(source: string): string {
  return source
    .replace(/^\s{0,3}(?:```|~~~)\s*\S*$/gm, "")
    .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, "");
}

function countInlines(inlines: readonly Inline[]): number {
  return inlines.reduce(
    (n, i) => n + (i.kind === "text" || i.kind === "code" ? 1 : countInlines(i.children)),
    0,
  );
}

function walk(blocks: readonly Block[], depth = 0): { depth: number; inlines: number } {
  let maxDepth = depth;
  let inlines = 0;
  for (const block of blocks) {
    if (block.kind === "list") {
      for (const item of block.items) {
        inlines += countInlines(item.inlines);
        const nested = walk(item.children, depth + 1);
        maxDepth = Math.max(maxDepth, nested.depth);
        inlines += nested.inlines;
      }
    } else if (block.kind !== "code") {
      inlines += countInlines(block.inlines);
    }
  }
  return { depth: maxDepth, inlines };
}

describe("the renderer over generated documents", () => {
  test(`no word is lost, over ${fuzzIterations()} documents`, () => {
    forEachSeed((rng, seed) => {
      const source = document(rng);
      const rendered = toPlainText(parseMarkdown(source)).replace(/\s+/g, "");

      for (const char of new Set(meaningful(source))) {
        assert.ok(
          rendered.includes(char),
          `seed ${seed}: lost ${JSON.stringify(char)} from\n${source.slice(0, 300)}`,
        );
      }
    });
  });

  test("parsing never throws, whatever a model emits", () => {
    forEachSeed((rng, seed) => {
      const source = document(rng);
      assert.doesNotThrow(() => parseMarkdown(source), `seed ${seed}`);
    });
  });

  test("every prefix parses, because that is what streaming shows", () => {
    // The panel re-renders on each delta, so every prefix of the final text is
    // rendered at least once. A prefix that throws blanks the turn mid-answer.
    forEachSeed((rng, seed) => {
      const source = document(rng);
      for (let cut = 0; cut <= source.length; cut += Math.max(1, Math.floor(source.length / 12))) {
        assert.doesNotThrow(() => parseMarkdown(source.slice(0, cut)), `seed ${seed}, cut ${cut}`);
      }
    });
  });

  test("output is stable: the same source parses the same way twice", () => {
    forEachSeed((rng, seed) => {
      const source = document(rng);
      assert.deepEqual(parseMarkdown(source), parseMarkdown(source), `seed ${seed}`);
    });
  });

  test("no empty text span reaches the renderer", () => {
    // An empty text node is a DOM node that renders nothing — harmless but a
    // sign the tokeniser is emitting boundaries it should have merged.
    forEachSeed((rng, seed) => {
      const check = (inlines: readonly Inline[]): void => {
        for (const inline of inlines) {
          if (inline.kind === "text") assert.ok(inline.text.length > 0, `seed ${seed}: empty text span`);
          else if (inline.kind !== "code") check(inline.children);
        }
      };
      const visit = (blocks: readonly Block[]): void => {
        for (const block of blocks) {
          if (block.kind === "list") for (const item of block.items) { check(item.inlines); visit(item.children); }
          else if (block.kind !== "code") check(block.inlines);
        }
      };
      visit(parseMarkdown(document(rng)));
    });
  });

  test("nesting stays bounded, so the renderer cannot recurse away", () => {
    // The webview builds DOM by recursion; unbounded depth from generated input
    // would be a stack overflow in the panel rather than a parse error here.
    forEachSeed((rng, seed) => {
      const { depth } = walk(parseMarkdown(document(rng)));
      assert.ok(depth < 50, `seed ${seed}: nested ${depth} deep`);
    });
  });

  test("work is proportional to input, not quadratic in it", () => {
    // The panel re-parses the whole accumulated answer on every frame, so a
    // superlinear parser turns a long reply into a frozen webview.
    const one = [
      "Some **prose** with `code`.",
      "",
      "- a bullet",
      "  - nested",
      "",
      "```py",
      "x = 1",
      "```",
      "",
    ].join("\n");
    const small = one.repeat(20);
    const large = one.repeat(200);

    const time = (text: string): number => {
      const start = performance.now();
      for (let i = 0; i < 5; i += 1) parseMarkdown(text);
      return performance.now() - start;
    };
    time(small); // warm

    const ratio = time(large) / Math.max(time(small), 0.01);
    assert.ok(ratio < 40, `10x the input took ${ratio.toFixed(1)}x the time`);
  });
});
