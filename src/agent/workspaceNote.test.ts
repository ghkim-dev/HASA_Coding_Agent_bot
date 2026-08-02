import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { workspaceNote, MODE_DEFINITIONS } from "./modes.ts";

/**
 * What the model is told it cannot do here.
 *
 * The distinction these tests protect is between "you cannot run anything" and
 * "Python is not installed". Only the second is something the user can fix, and
 * collapsing them is what left a beginner believing their file was broken.
 */

const GAP = {
  language: "Python",
  files: ["calculator.py"],
  install: "install Python from https://www.python.org/downloads/",
};

describe("a workspace where everything works", () => {
  test("says nothing at all", () => {
    assert.equal(workspaceNote({ canRunCommands: true, isGitRepo: true }), "");
  });

  test("adds nothing to the prompt", () => {
    const note = workspaceNote({ canRunCommands: true, isGitRepo: true, runtimeGaps: [] });
    assert.equal(note, "");
  });
});

describe("a missing interpreter", () => {
  const note = workspaceNote({ canRunCommands: false, isGitRepo: true, runtimeGaps: [GAP] });

  test("names the language, the file and the fix", () => {
    assert.match(note, /Python/);
    assert.match(note, /calculator\.py/);
    assert.match(note, /python\.org/);
  });

  test("says the code is fine, because that is the part the user doubts", () => {
    assert.match(note, /the code is fine/i);
  });

  test("comes before the generic cannot-run line", () => {
    // Order matters: the specific fixable fact should be the one the model
    // reaches for first.
    const specific = note.indexOf("Python");
    const generic = note.indexOf("You cannot run programs");
    assert.ok(specific !== -1 && generic !== -1);
    assert.ok(specific < generic, "the actionable line should come first");
  });

  test("forbids inventing another way to run it", () => {
    assert.match(note, /Do not guess at another way to run it/i);
  });

  test("asks for plain language, since the reader is not a programmer", () => {
    assert.match(note, /without jargon/i);
  });
});

describe("several gaps", () => {
  test("each language is reported on its own terms", () => {
    const note = workspaceNote({
      canRunCommands: false,
      isGitRepo: true,
      runtimeGaps: [GAP, { language: "JavaScript", files: ["index.js"], install: "install Node.js from https://nodejs.org/" }],
    });
    assert.match(note, /Python/);
    assert.match(note, /JavaScript/);
    assert.match(note, /nodejs\.org/);
  });
});

describe("a workspace that can run things", () => {
  test("a gap is still reported even when other commands exist", () => {
    // `pnpm test` working says nothing about whether Python is installed.
    const note = workspaceNote({ canRunCommands: true, isGitRepo: true, runtimeGaps: [GAP] });
    assert.match(note, /Python/);
    assert.doesNotMatch(note, /You cannot run programs/);
  });
});

describe("the note joins the prompt cleanly", () => {
  for (const definition of Object.values(MODE_DEFINITIONS)) {
    test(`${definition.label} keeps its own instructions`, () => {
      const combined = definition.systemPrompt + workspaceNote({
        canRunCommands: false,
        isGitRepo: false,
        runtimeGaps: [GAP],
      });
      assert.ok(combined.startsWith(definition.systemPrompt));
      assert.match(combined, /What is not possible here/);
    });
  }
});
