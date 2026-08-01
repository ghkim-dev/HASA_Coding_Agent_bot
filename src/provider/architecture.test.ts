import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Rules the design depends on, enforced by reading the source.
 *
 * Each of these is a decision from docs/hasa-coding-agent-architecture.md that
 * a reviewer would otherwise have to police by hand, forever. A hardcoded model
 * id or a stray `vscode` import does not fail a behavioural test — it fails
 * six months later, in someone else's environment, as a bug nobody can place.
 */

const PROVIDER_DIR = fileURLToPath(new URL(".", import.meta.url));

interface SourceFile {
  path: string;
  /** Relative to `src/provider`, with forward slashes. */
  name: string;
  /** Comments removed. These rules are about what the code does, not what it explains. */
  text: string;
}

/**
 * Removes comments so that prose can discuss what the code may not do.
 *
 * Without this the rules below are unusable: the comment explaining why model
 * names are not evidence has to name a model, and the comment explaining that
 * `choices[0].delta` must not escape has to spell it out.
 *
 * The line-comment pattern requires the `//` not to be preceded by a colon, so
 * a URL inside a string survives.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

async function collectSources(): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.name.endsWith(".ts")) {
        out.push({
          path,
          name: relative(PROVIDER_DIR, path).split(sep).join("/"),
          text: stripComments(await readFile(path, "utf8")),
        });
      }
    }
  };
  await walk(PROVIDER_DIR);
  return out;
}

// This file names every forbidden token by definition, so it scans everything
// but itself.
const sources = (await collectSources()).filter((f) => f.name !== "architecture.test.ts");
const production = sources.filter((f) => !f.name.includes(".test."));

describe("the provider layer is complete and readable", () => {
  test("there is source to check", () => {
    assert.ok(production.length >= 12, `expected the provider layer, found ${production.length} files`);
  });
});

describe("model ids are never written down (§10)", () => {
  // Every id HASA's catalogue was observed to carry, plus the vendor prefixes
  // a future one is likely to use.
  const FORBIDDEN = [
    "exaone",
    "qwen",
    "gpt-oss",
    "llama",
    "kanana",
    "hyperclovax",
    "midm",
    "solar-pro",
    "granite",
    "bge-m3",
    "bge-reranker",
    "whisper",
    "deepseek",
    "mistral",
    "gemma",
    "claude-",
    "gpt-4",
  ];

  for (const file of production) {
    test(`${file.name} names no model`, () => {
      const lower = file.text.toLowerCase();
      for (const id of FORBIDDEN) {
        assert.ok(
          !lower.includes(id),
          `${file.name} mentions "${id}". Model ids come from GET /v1/models at runtime so that a ` +
            `model added or withdrawn on the gateway needs no extension release.`,
        );
      }
    });
  }
});

describe("the provider does not depend on VS Code (§8, rule 4)", () => {
  for (const file of sources) {
    test(`${file.name} imports no vscode module`, () => {
      // A single `import "vscode"` makes the whole layer unloadable outside an
      // extension host: no pnpm test, no CLI, no orchestrator. The dependency
      // is expressed structurally instead, as SecretStorageLike.
      assert.doesNotMatch(file.text, /from\s+["']vscode["']/, file.name);
      assert.doesNotMatch(file.text, /require\(\s*["']vscode["']\s*\)/, file.name);
    });
  }
});

describe("the provider does not depend on the Arena (§8, rule 1)", () => {
  for (const file of sources) {
    test(`${file.name} imports nothing from core, server, cli or runtime`, () => {
      // Arena may use the provider. The reverse would make the Coding Agent
      // inherit the comparison engine it exists to sit above.
      for (const forbidden of ["/core/", "/server/", "/cli/", "/runtime/"]) {
        assert.ok(
          !file.text.includes(`..${forbidden}`),
          `${file.name} reaches into ${forbidden}`,
        );
      }
    });
  }
});

describe("OpenAI wire shapes stay inside the translation layer (§27)", () => {
  // The whole point of the provider contract: an agent loop written against it
  // must not be able to see a gateway's response format, so that a HASA
  // response-shape change stays a one-file change.
  const WIRE_TOKENS = [
    "choices",
    "finish_reason",
    "tool_calls",
    "max_tokens",
    "top_p",
    "response_format",
    "image_url",
    "prompt_tokens",
    "completion_tokens",
    "owned_by",
  ];

  /** The translation layer itself, and the one adapter that feeds it. */
  const ALLOWED = new Set(["openai-compatible/wire.ts", "hasa/hasaTransport.ts"]);

  /**
   * Matches a token used as a *field* — read off an object, declared as a
   * member, or looked up by key.
   *
   * A bare occurrence is not enough: `"tool_calls"` is also the normalised
   * FinishReason value, and it keeps that spelling because it is the natural
   * name for the thing. Reading `delta.tool_calls` is the leak; naming a
   * finish reason is not.
   */
  const asField = (token: string): RegExp =>
    new RegExp(`\\.${token}\\b|\\b${token}\\s*\\??:|\\[\\s*["']${token}["']\\s*\\]`);

  for (const file of production) {
    if (ALLOWED.has(file.name)) continue;
    test(`${file.name} speaks the normalised contract only`, () => {
      for (const token of WIRE_TOKENS) {
        assert.doesNotMatch(
          file.text,
          asField(token),
          `${file.name} reads the wire field "${token}". Translation belongs in ` +
            `openai-compatible/wire.ts so that everything above it is provider-agnostic.`,
        );
      }
    });
  }

  test("the translation layer does exist and does the work", () => {
    const wire = production.find((f) => f.name === "openai-compatible/wire.ts");
    assert.ok(wire !== undefined);
    for (const token of ["choices", "finish_reason", "tool_calls"]) {
      assert.ok(wire.text.includes(token), `wire.ts should handle ${token}`);
    }
  });
});

describe("credentials have exactly one home (§9)", () => {
  test("nothing writes a key to settings, workspace state or web storage", () => {
    const FORBIDDEN = [
      "workspaceState",
      "globalState",
      "localStorage",
      "sessionStorage",
      "getConfiguration",
      "settings.json",
    ];
    for (const file of sources) {
      for (const sink of FORBIDDEN) {
        assert.ok(!file.text.includes(sink), `${file.name} touches ${sink}`);
      }
    }
  });

  test("only the credential store reads the key out of the environment", () => {
    // `credentials.ts` holds EnvCredentialStore; `hasaCredentialStore.ts` names
    // the variable once, as that store's default. Nowhere else needs it.
    const OWNERS = new Set(["credentials.ts", "hasa/hasaCredentialStore.ts"]);
    for (const file of production) {
      if (OWNERS.has(file.name)) continue;
      assert.ok(
        !file.text.includes("HASA_API_KEY"),
        `${file.name} reads the key from the environment; that belongs to EnvCredentialStore`,
      );
    }
  });

  test("no file contains something shaped like a real credential", () => {
    // A literal that survives review once survives forever.
    for (const file of sources) {
      const suspicious = file.text.match(/\b(sk|hasa)-[A-Za-z0-9]{20,}\b/g) ?? [];
      const allowed = suspicious.filter((s) => s.includes("0123456789") || s.includes("abcdef"));
      assert.deepEqual(
        suspicious.filter((s) => !allowed.includes(s)),
        [],
        `${file.name} may contain a credential literal`,
      );
    }
  });
});

describe("endpoints are configuration, not scattered strings (§8)", () => {
  test("the HASA host appears only where the defaults live", () => {
    for (const file of production) {
      if (file.name === "hasa/defaults.ts") continue;
      assert.ok(
        !file.text.includes("open.hasa.re.kr"),
        `${file.name} hardcodes the gateway host; it belongs in hasa/defaults.ts`,
      );
    }
  });

  test("no file invents an endpoint path", () => {
    // The transport owns the paths. A second spelling of /chat/completions is
    // how a working client and a broken one end up in the same codebase.
    for (const file of production) {
      for (const path of ["/chat/completions", "/v1/models", "/embeddings", "/rerank"]) {
        assert.ok(!file.text.includes(`"${path}`), `${file.name} spells out ${path}`);
      }
    }
  });
});

describe("capabilities are measured, never assumed (§11)", () => {
  test("nothing decides a capability by matching a model name", () => {
    for (const file of production) {
      for (const pattern of [/modelId\.includes\(/, /\.startsWith\(["']qwen/i, /name\.match\(.*coder/i]) {
        assert.doesNotMatch(file.text, pattern, `${file.name} appears to infer capability from a name`);
      }
    }
  });

  test("the tristate is used, so unknown cannot be typed away", () => {
    const types = production.find((f) => f.name === "types.ts");
    assert.ok(types !== undefined);
    assert.match(types.text, /Tristate\s*=\s*boolean\s*\|\s*"unknown"/);
  });
});
