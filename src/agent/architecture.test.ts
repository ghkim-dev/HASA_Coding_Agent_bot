import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Rules the agent layer depends on, enforced by reading the source.
 *
 * The dependency direction is the one that matters. `src/agent` sits above the
 * provider and must not reach around it: a loop that imports `hasa-client`
 * acquires a gateway's error taxonomy, its retry policy and its wire format,
 * and the provider stops being the seam it was built to be.
 *
 * See docs/hasa-coding-agent-architecture.md §8.
 */

const AGENT_DIR = fileURLToPath(new URL(".", import.meta.url));

interface SourceFile {
  name: string;
  text: string;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

async function collect(): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".ts")) {
        out.push({
          name: relative(AGENT_DIR, path).split(sep).join("/"),
          text: stripComments(await readFile(path, "utf8")),
        });
      }
    }
  };
  await walk(AGENT_DIR);
  return out;
}

const sources = (await collect()).filter((f) => f.name !== "architecture.test.ts");
const production = sources.filter((f) => !f.name.includes(".test."));

describe("the agent layer exists and is checkable", () => {
  test("there is source to check", () => {
    assert.ok(production.length >= 8, `expected the agent layer, found ${production.length} files`);
  });
});

describe("the agent talks to the provider, never around it (§8, rule 2)", () => {
  for (const file of production) {
    test(`${file.name} does not import the HASA transport`, () => {
      // The provider is the seam. Reaching past it drags a gateway's retry
      // policy and wire format into a file whose job is deciding what to do.
      assert.ok(!file.text.includes("hasa-client/client"), file.name);
      assert.ok(!file.text.includes("HasaClient"), file.name);
      assert.ok(!file.text.includes("hasa-client/sse"), file.name);
      assert.ok(!file.text.includes("hasa-client/errors"), file.name);
    });
  }

  test("nothing reaches into the Arena's run machinery", () => {
    // `core/git`, `core/sandbox` and `core/commands` are shared infrastructure
    // and are meant to be used. The comparison engine is not.
    for (const file of production) {
      for (const forbidden of ["core/runManager", "core/codeRunManager", "core/judge", "core/decide", "core/refine"]) {
        assert.ok(!file.text.includes(forbidden), `${file.name} imports ${forbidden}`);
      }
    }
  });

  test("nothing imports the Arena's own agent runner", () => {
    for (const file of production) {
      assert.ok(!file.text.includes("runtime/agentRunner"), file.name);
    }
  });
});

describe("no OpenAI wire shape reaches the agent (§27)", () => {
  // `delta` is deliberately absent: it is also the normalised name for a
  // streaming increment (`{ type: "text"; delta }`), and the OpenAI-specific
  // thing is `choices[].delta`, which `choices` already catches.
  const WIRE_TOKENS = ["choices", "finish_reason", "tool_calls", "max_tokens", "top_p"];

  for (const file of production) {
    test(`${file.name} speaks the normalised contract`, () => {
      for (const token of WIRE_TOKENS) {
        const asField = new RegExp(`\\.${token}\\b|\\b${token}\\s*\\??:`);
        assert.doesNotMatch(file.text, asField, `${file.name} reads the wire field "${token}"`);
      }
    });
  }
});

describe("the agent does not depend on VS Code", () => {
  for (const file of sources) {
    test(`${file.name} imports no vscode module`, () => {
      assert.doesNotMatch(file.text, /from\s+["']vscode["']/, file.name);
    });
  }
});

describe("safety cannot be edited away by accident", () => {
  test("file access goes through the sandbox, never through node:fs directly", () => {
    // `readdir` and `stat` are used to walk; reading a file's *contents* is the
    // sandbox's job, because that is where the symlink and credential checks
    // live.
    // The lookbehind is the point: `sandbox.readFile` is the approved route and
    // a bare `readFile` is the one that skips the symlink and credential
    // checks. Matching the bare call only is what makes the rule mean anything.
    const bareRead = /(?<!sandbox\.)\breadFile\s*\(/;
    const bareWrite = /(?<!sandbox\.)\bwriteFile\s*\(/;
    for (const file of production) {
      if (file.name === "checkpoint.ts") continue; // git only
      assert.doesNotMatch(file.text, bareRead, `${file.name} reads a file without the sandbox`);
      assert.doesNotMatch(file.text, bareWrite, `${file.name} writes a file without the sandbox`);
    }
  });

  test("commands are spawned only through the allowlisted runner", () => {
    for (const file of production) {
      assert.ok(!file.text.includes("child_process"), `${file.name} spawns a process directly`);
      assert.ok(!/\bexecSync\b|\bspawnSync\b/.test(file.text), file.name);
    }
  });

  test("no tool is registered above the risk a mode can permit", async () => {
    const { MODE_DEFINITIONS } = await import("./modes.ts");
    const { RISK_ORDER } = await import("./types.ts");
    for (const definition of Object.values(MODE_DEFINITIONS)) {
      assert.ok(
        RISK_ORDER[definition.maxRisk] < RISK_ORDER.dangerous,
        `${definition.mode} would admit a dangerous tool`,
      );
    }
  });

  test("the approval port is required, not optional", () => {
    // An agent that can be constructed without one is an agent that will be.
    const session = production.find((f) => f.name === "session.ts");
    assert.ok(session !== undefined);
    assert.match(session.text, /approvalPort:\s*ApprovalPort;/, "approvalPort must not be optional");
  });
});

describe("what the user is shown is written for the user", () => {
  test("every user-facing summary is in Korean", async () => {
    // The brief is explicit that the product is not AI-centric and not English.
    // A summary the user cannot read is a decision they cannot make.
    const { MODE_DEFINITIONS } = await import("./modes.ts");
    for (const definition of Object.values(MODE_DEFINITIONS)) {
      assert.match(definition.description, /[가-힣]/, definition.mode);
    }
  });

  test("no user-facing string leaks internal vocabulary", () => {
    const forbidden = /토큰 예산|max_steps|maxSteps|tool_call|LLM/;
    for (const file of production) {
      const korean = file.text.match(/"[^"]*[가-힣][^"]*"/g) ?? [];
      for (const line of korean) {
        assert.doesNotMatch(line, forbidden, `${file.name}: ${line}`);
      }
    }
  });
});
