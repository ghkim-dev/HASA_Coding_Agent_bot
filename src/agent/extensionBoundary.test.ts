import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The extension's side of the trust boundary, checked by reading it.
 *
 * The extension is the one place `pnpm test` cannot execute — it needs a VS
 * Code host — so the guarantees that matter there are checked statically
 * instead. The one that matters most is the oldest rule in this repository:
 * the API key reaches the extension host and stops.
 *
 * See docs/security-policy.md §1.1 and §1.3.
 */

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const EXTENSION_SRC = join(REPO, "extension", "src");
const EXTENSION_MEDIA = join(REPO, "extension", "media");

interface SourceFile {
  name: string;
  text: string;
}

async function collect(dir: string, extensions: readonly string[]): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (extensions.some((e) => entry.name.endsWith(e))) {
        out.push({ name: relative(REPO, path).split(sep).join("/"), text: await readFile(path, "utf8") });
      }
    }
  };
  await walk(dir);
  return out;
}

const hostFiles = await collect(EXTENSION_SRC, [".ts"]);
const webviewFiles = await collect(EXTENSION_MEDIA, [".js"]);

describe("the extension is present and checkable", () => {
  test("both halves have source", () => {
    assert.ok(hostFiles.length >= 4, `extension host: ${hostFiles.length} files`);
    assert.ok(webviewFiles.length >= 1, `webview: ${webviewFiles.length} files`);
  });
});

describe("the key stops at the extension host (§1.3)", () => {
  test("no webview script reads a secret", () => {
    // The webview is outside the boundary. Nothing it runs may reach storage.
    for (const file of webviewFiles) {
      for (const sink of ["secrets", "apiKey", "HASA_API_KEY", "Authorization", "Bearer"]) {
        assert.ok(!file.text.includes(sink), `${file.name} mentions ${sink}`);
      }
    }
  });

  test("no webview script talks to a network", () => {
    // Everything reaches the gateway through the extension host, which is what
    // keeps the key out of a context the user's page scripts share.
    for (const file of webviewFiles) {
      for (const sink of ["fetch(", "XMLHttpRequest", "WebSocket", "EventSource", "import("]) {
        assert.ok(!file.text.includes(sink), `${file.name} uses ${sink}`);
      }
    }
  });

  test("no webview script uses browser storage", () => {
    for (const file of webviewFiles) {
      for (const sink of ["localStorage", "sessionStorage", "indexedDB", "document.cookie"]) {
        assert.ok(!file.text.includes(sink), `${file.name} uses ${sink}`);
      }
    }
  });

  test("only the host reads the secret, and only from SecretStorage", () => {
    const readers = hostFiles.filter((f) => f.text.includes("secrets.get"));
    assert.ok(readers.length > 0, "something must read the key");
    for (const file of readers) {
      assert.ok(
        file.name.endsWith("extension.ts") || file.name.includes("agentHost"),
        `${file.name} should not be reading the key`,
      );
    }
  });

  test("the key is never written anywhere a file or a sync could see it", () => {
    for (const file of hostFiles) {
      for (const sink of ["globalState.update", "workspaceState.update", "localStorage"]) {
        assert.ok(!file.text.includes(sink), `${file.name} uses ${sink}`);
      }
    }
  });

  test("no source file contains something shaped like a credential", () => {
    for (const file of [...hostFiles, ...webviewFiles]) {
      assert.doesNotMatch(file.text, /\b(sk|hasa)-[A-Za-z0-9-]{20,}\b/, file.name);
    }
  });
});

describe("the panel contract cannot carry a key", () => {
  test("no message type declares a field that could hold one", () => {
    // The type system is the first line of defence rather than a runtime
    // filter: a field that does not exist cannot be populated by mistake.
    //
    // `hasApiKey` is deliberately not caught — a boolean saying whether a key
    // exists is exactly the shape that is allowed to cross.
    const carriers = [/(?<!has)apiKey\s*\??:/i, /\btoken\s*\??:/i, /\bsecret\s*\??:/i, /\bauthorization\s*\??:/i];
    const contracts = hostFiles.filter((f) => f.name.includes("chatPanel") || f.name.endsWith("types.ts"));
    assert.ok(contracts.length > 0);
    for (const file of contracts) {
      for (const carrier of carriers) {
        assert.doesNotMatch(file.text, carrier, `${file.name} declares a field matching ${carrier}`);
      }
    }
  });

  test("the webview is told whether a key exists, not what it is", () => {
    // Both surfaces answer the same way, and it is the only thing either says
    // about the credential.
    //
    // The agent's `ConnectionState` moved from `agentHost.ts` to `chatPanel.ts`
    // — it is a thing the panel draws, and having the boundary's types reach
    // into the host made the whole extension part of the webview's type graph,
    // which is why the webview could not be type checked at all. So the shape is
    // looked for where it now lives. What is asserted is unchanged: the declared
    // contract says whether a key exists and says nothing more.
    const arena = hostFiles.find((f) => f.name.endsWith("types.ts"));
    const boundary = hostFiles.find((f) => f.name.includes("chatPanel"));
    assert.match(arena?.text ?? "", /hasApiKey:\s*boolean/);
    assert.match(boundary?.text ?? "", /hasApiKey:\s*boolean/);
  });

  test("the boundary declares the connection shape without reaching into the host", () => {
    // The rule that keeps the above checkable. A message type that imports the
    // host drags the gateway, the session and the filesystem into the type graph
    // the panel is written against, and then nothing can check the panel.
    const panel = hostFiles.find((f) => f.name.includes("chatPanel"));
    assert.ok(panel !== undefined);
    assert.match(panel.text, /export interface ConnectionState/);
    assert.ok(
      !/from\s+"\.\/agentHost\.ts"/.test(panel.text),
      "chatPanel must not import the host — it is the boundary, not a client of it",
    );
  });

  test("the state the chat panel sends is built from that boolean", () => {
    const panel = hostFiles.find((f) => f.name.includes("chatPanel"));
    assert.match(panel?.text ?? "", /connection:\s*ConnectionState/);
  });
});

describe("the webview cannot execute what it is sent", () => {
  test("nothing renders host text as markup", () => {
    // `innerHTML = ""` clears; assigning content would turn a model's output —
    // or a file's — into markup in a privileged context.
    for (const file of webviewFiles) {
      const assignments = file.text.match(/innerHTML\s*=\s*[^;]+/g) ?? [];
      for (const assignment of assignments) {
        assert.match(assignment, /innerHTML\s*=\s*""/, `${file.name}: ${assignment}`);
      }
    }
  });

  test("no webview script evaluates strings", () => {
    for (const file of webviewFiles) {
      assert.ok(!/\beval\s*\(/.test(file.text), file.name);
      assert.ok(!/new\s+Function\s*\(/.test(file.text), file.name);
    }
  });

  test("the chat panel sets a content security policy with a nonce", () => {
    const panel = hostFiles.find((f) => f.name.includes("chatPanel"));
    assert.ok(panel !== undefined);
    assert.match(panel.text, /Content-Security-Policy/);
    assert.match(panel.text, /default-src 'none'/);
    assert.match(panel.text, /nonce-/);
  });
});

describe("the extension stays thin (§ the reason src/ holds the logic)", () => {
  test("no decision about models, commands or approval is made in the extension", () => {
    // Anything here is untestable by `pnpm test`. The policies live in `src/`
    // for that reason, and this is what stops them drifting back.
    // Matched as model-id shapes rather than as bare substrings. `coder` alone
    // fires on `TextDecoder`, and a rule that cries wolf is one the next person
    // silences — after which it protects nothing. Each of these still catches
    // the real thing: the assertions below prove it.
    const MODEL_SHAPED = [/\bqwen[\w.-]*/i, /\bexaone[\w.-]*/i, /\bgpt-oss[\w.-]*/i, /-coder\b/i, /\bllama-\d/i];

    for (const file of hostFiles) {
      if (file.name.includes("orchestrator")) continue; // the Arena's own client
      for (const smell of MODEL_SHAPED) {
        const hit = smell.exec(file.text);
        assert.equal(hit, null, `${file.name} names a model: ${hit?.[0]}`);
      }
      assert.ok(!file.text.includes("npm publish"), `${file.name} decides what may run`);
    }
  });

  test("that rule still catches a model name, and still ignores ordinary code", () => {
    // Written down because the rule was loosened once to stop it firing on
    // `TextDecoder`, and a loosened rule is worth only what it still catches.
    const MODEL_SHAPED = [/\bqwen[\w.-]*/i, /\bexaone[\w.-]*/i, /\bgpt-oss[\w.-]*/i, /-coder\b/i, /\bllama-\d/i];
    const fires = (text: string): boolean => MODEL_SHAPED.some((r) => r.test(text));

    for (const named of [
      'const m = "qwen3-coder";',
      'if (id === "exaone-4.0-32b") {',
      'fallback("gpt-oss-20b")',
      'model: "qwen2.5-coder-32b"',
      '"llama-3.3-70b"',
    ]) {
      assert.ok(fires(named), `should have caught: ${named}`);
    }

    for (const ordinary of [
      'new TextDecoder("utf-8")',
      "const decoder = new TextDecoder();",
      "encoder.encode(text)",
      "// the coder writes the code",
      "transcoderOptions",
    ]) {
      assert.ok(!fires(ordinary), `should have ignored: ${ordinary}`);
    }
  });

  test("the Arena's commands still exist alongside the agent's", () => {
    // §3 of the brief: the Arena is kept, not replaced.
    const entry = hostFiles.find((f) => f.name.endsWith("extension.ts"));
    assert.ok(entry !== undefined);
    for (const command of ["hasa.chat", "hasaArena.compare", "hasaArena.setApiKey"]) {
      assert.ok(entry.text.includes(command), `${command} is not registered`);
    }
  });
});

/**
 * Configuration that belongs in one place stays in one place (§8).
 *
 * The gateway address had been written a second time in `agentHost.ts` while
 * the rule enforcing it only scanned `src/provider` — so the rule existed, the
 * violation was in the one directory it could not see, and everything passed.
 * The extension is where that mistake is easiest to make, because it is the
 * layer that reads user settings and needs a fallback.
 */
describe("the extension does not re-declare provider configuration (§8)", () => {
  test("the gateway host is not written in the extension", () => {
    for (const file of hostFiles) {
      assert.ok(
        !file.text.includes("open.hasa.re.kr"),
        `${file.name} hardcodes the gateway host; import it from src/provider/hasa/defaults.ts`,
      );
    }
  });

  test("no webview file knows the gateway at all", () => {
    // The webview is outside the trust boundary and has no business holding an
    // address it could be persuaded to send something to.
    for (const file of webviewFiles) {
      assert.ok(!file.text.includes("open.hasa.re.kr"), `${file.name} names the gateway`);
    }
  });

  test("the extension does not invent generation endpoints", () => {
    // The paths live in hasaMedia.ts, verified against the live service. A
    // second spelling here is how a working client and a broken one coexist.
    for (const file of [...hostFiles, ...webviewFiles]) {
      for (const path of ["/images/generations", "/videos/generations", "/v1/jobs/"]) {
        assert.ok(!file.text.includes(path), `${file.name} spells out "${path}"`);
      }
    }
  });
});

/**
 * The panel does not pay for the same list twice.
 *
 * Opening the chat panel made two `GET /v1/models` calls about 200ms apart: the
 * first frame loaded the catalogue, and `validate()` — which must bypass the
 * cache, because a list served from disk is not evidence the gateway answered —
 * fetched it again immediately. The second answer replaced the first, so the
 * cost bought nothing, and the first frame waited on a round trip to show a list
 * that was about to be thrown away.
 *
 * Checked by reading, for the reason at the top of this file. The ordering is
 * the whole fix, and an edit that restores the eager frame would otherwise cost
 * a request per panel open and be invisible until someone read a gateway log.
 */
describe("opening the panel fetches the model list once", () => {
  const controller = hostFiles.find((f) => f.name.includes("agent/controller"));

  /** `open()` alone — the rule is about its ordering, not the whole file. */
  function openBody(): string {
    assert.ok(controller !== undefined, "the controller should be present");
    const start = controller.text.indexOf("async open(");
    assert.notEqual(start, -1, "controller should still have an open()");
    const end = controller.text.indexOf("dispose()", start);
    assert.notEqual(end, -1, "dispose() should still follow open()");
    return controller.text.slice(start, end);
  }

  test("the frame drawn before validation skips the catalogue", () => {
    assert.match(
      openBody(),
      /push\(\s*["']without-catalogue["']\s*\)/,
      "open() must draw its first authenticated frame without loading the catalogue",
    );
  });

  test("it skips it before validating, not after", () => {
    // Backwards, this is not an optimisation but a blank model picker: the
    // catalogue-free frame would be the last thing the panel is told.
    const body = openBody();
    const skipped = body.search(/push\(\s*["']without-catalogue["']\s*\)/);
    const validated = body.indexOf("host.validate()");
    assert.notEqual(validated, -1, "open() should still validate the key");
    assert.ok(skipped < validated, "the catalogue-free frame belongs before validate(), not after");
  });
});

/**
 * Auto and the picker agree about what this key can talk to.
 *
 * They did not. The picker consults the catalogue and hides models with an
 * endpoint of their own; Auto ranked whatever `/v1/models` returned, and an
 * unmeasured model is deliberately a candidate rather than a disqualification —
 * so `Qwen-Image`, `whisper-large-v3` and `bge-m3` were all selectable. Picking
 * one meant every turn answering 404 before the agent ran, which is one of the
 * ways "sometimes it works" happens.
 *
 * `chooseModel` cannot fix this itself: it ranks measured capability and has no
 * notion of modality, which is the right shape for it. So the guarantee is that
 * its caller hands it the filtered list, and that is what is checked here.
 */
describe("the model Auto may choose is one the picker would offer", () => {
  const host = hostFiles.find((f) => f.name.includes("agentHost"));

  /** `resolveModel` alone — the rule is about what it feeds `chooseModel`. */
  function resolveBody(): string {
    assert.ok(host !== undefined, "agentHost should be present");
    const start = host.text.indexOf("private async resolveModel(");
    assert.notEqual(start, -1, "agentHost should still have resolveModel");
    const end = host.text.indexOf("async send(", start);
    assert.notEqual(end, -1, "send() should still follow resolveModel");
    return host.text.slice(start, end);
  }

  test("it is given the conversation models, not the raw catalogue", () => {
    const body = resolveBody();
    assert.match(
      body,
      /conversationModels\(\)/,
      "resolveModel must rank the list the picker offers, not everything /v1/models returned",
    );
  });

  test("the filtered list is what reaches chooseModel", () => {
    // A `conversationModels()` call that the ranking then ignores would pass the
    // test above and none of the point of it.
    const body = resolveBody();
    const filtered = body.indexOf("conversationModels()");
    const ranked = body.indexOf("chooseModel(");
    assert.notEqual(ranked, -1, "resolveModel should still call chooseModel");
    assert.ok(filtered < ranked, "the list must be filtered before it is ranked");
  });
});

/**
 * Model output cannot become markup.
 *
 * The panel gained the ability to display images. The rule that keeps that from
 * becoming an injection surface is that the only `<img>` in the webview is
 * built from a structured `artifact` message minted by the extension host —
 * never from anything the model wrote.
 */
describe("the panel renders model text as text (§1.3)", () => {
  test("innerHTML is only ever used to clear an element", () => {
    // Stated as "only the empty string" rather than "no variables" because it
    // is the version that cannot be argued with: clearing is safe, and every
    // other assignment — literal markup included — should be createElement, so
    // that no future edit can slip an interpolation into an existing template.
    for (const file of webviewFiles) {
      for (const [, assigned] of file.text.matchAll(/\.innerHTML\s*=\s*([^;\n]*)/g)) {
        assert.match(
          (assigned ?? "").trim(),
          /^(""|''|``)$/,
          `${file.name} assigns innerHTML something other than an empty string`,
        );
      }
    }
  });

  test("the markdown renderer emits no image, media or link element", () => {
    const chat = webviewFiles.find((f) => f.name.endsWith("media/chat.js"));
    assert.ok(chat !== undefined, "chat.js should be present");
    // Everything between the renderer and the element map is model-driven.
    const renderer = chat.text.slice(0, chat.text.indexOf("const el = {"));
    for (const tag of ['"img"', '"video"', '"a"', '"iframe"', '"source"']) {
      assert.ok(
        !renderer.includes(`createElement(${tag})`),
        `the markdown renderer creates ${tag}; model text must not become an element that loads or navigates`,
      );
    }
  });

  test("an image is only ever built from a host message", () => {
    const chat = webviewFiles.find((f) => f.name.endsWith("media/chat.js"));
    assert.ok(chat !== undefined);
    const imageSites = chat.text.split("\n").filter((line) => /createElement\(\s*message\.kind/.test(line));
    assert.equal(imageSites.length, 1, "exactly one place should build media, and from `message`");
  });
});
