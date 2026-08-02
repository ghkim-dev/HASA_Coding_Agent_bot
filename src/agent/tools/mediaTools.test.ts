import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox } from "../../core/sandbox.ts";
import type { CatalogEntry } from "../../provider/hasa/hasaCatalog.ts";
import type { MediaTransport } from "../../provider/hasa/hasaMedia.ts";
import { createMediaTools, fileNameFor, parseSavedArtifact } from "./mediaTools.ts";
import type { ToolContext } from "../types.ts";

/**
 * The image and video tools.
 *
 * What these hold onto: the file must be written as bytes, the tool must not
 * exist when the gateway has no such model, approval must happen before the GPU
 * time is spent, and a completed video whose file the gateway withholds must
 * not be reported as a failure.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef]);
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

const ctx = { signal: new AbortController().signal } as ToolContext;

const IMAGE_MODEL: CatalogEntry = {
  id: "Qwen-Image", modality: "image", title: null, available: true, callable: true, videoSpec: null,
};
const VIDEO_MODEL: CatalogEntry = {
  id: "Wan2.1-T2V", modality: "video", title: null, available: true, callable: true, videoSpec: null,
};
const SPEC = {
  fps: 16, maxSeconds: 10.1, maxFrames: 161, frameAlign: 4,
  sizes: ["832x480"], audio: false, genTimePerSecond: 22.7, defaultSeconds: 1.5,
};

async function workspace(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "hasa-media-"));
  return new Sandbox({ root });
}

function tools(sandbox: Sandbox, transport: Partial<MediaTransport>, opts: { image?: CatalogEntry[]; video?: CatalogEntry[] } = {}) {
  return createMediaTools({
    sandbox,
    transport: { postJson: async () => ({}), getJson: async () => ({}), getBinary: async () => null, ...transport },
    imageModels: opts.image ?? [IMAGE_MODEL],
    videoModels: opts.video ?? [],
    videoSpecFor: async () => SPEC,
  });
}

describe("which tools exist", () => {
  test("no image model in the catalogue means no image tool", async () => {
    // The rule createShellTools states: an offered tool that always refuses
    // costs a turn every time the model reaches for it.
    const made = tools(await workspace(), {}, { image: [], video: [] });
    assert.deepEqual(made.map((t) => t.name), []);
  });

  test("each modality brings its own tool", async () => {
    const made = tools(await workspace(), {}, { image: [IMAGE_MODEL], video: [VIDEO_MODEL] });
    assert.deepEqual(made.map((t) => t.name).sort(), ["generate_image", "generate_video"]);
  });

  test("both are write risk, so approval precedes the GPU time", async () => {
    const made = tools(await workspace(), {}, { image: [IMAGE_MODEL], video: [VIDEO_MODEL] });
    for (const tool of made) assert.equal(tool.risk, "write", tool.name);
  });

  test("the model list is offered as an enum, never invented by the model", async () => {
    const made = tools(await workspace(), {}, { image: [IMAGE_MODEL] });
    const schema = made[0]!.parameters as { properties: { model: { enum: string[] } } };
    assert.deepEqual(schema.properties.model.enum, ["Qwen-Image"]);
  });

  test("no model id is hardcoded in the tool source", async () => {
    // §14: the catalogue decides, so a model added next month needs no release.
    // Comments are stripped first — naming today's models while explaining why
    // they are not named in the code is documentation, not a routing decision.
    const raw = await readFile(new URL("./mediaTools.ts", import.meta.url), "utf8");
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const id of ["Qwen-Image", "Wan2.1-T2V", "Wan2.2-T2V", "LTX-2"]) {
      assert.ok(!source.includes(id), `${id} is hardcoded`);
    }
  });
});

describe("generating an image", () => {
  test("writes the bytes to the workspace, undamaged", async () => {
    const sandbox = await workspace();
    const [image] = tools(sandbox, { postJson: async () => ({ data: [{ b64_json: b64(PNG) }] }) });

    const result = await image!.execute({ prompt: "a red apple" }, ctx);
    assert.ok(result.ok, result.content);

    const path = /Saved (\S+)/.exec(result.content)?.[1] ?? "";
    const written = await readFile(join(sandbox.root, path));
    // Byte-for-byte: routing binary through writeFile would UTF-8 encode it and
    // corrupt everything above 0x7f, which 0xde 0xad 0xbe 0xef catches.
    assert.deepEqual([...written], [...PNG]);
  });

  test("the file is named after the prompt, not numbered", async () => {
    const sandbox = await workspace();
    const [image] = tools(sandbox, { postJson: async () => ({ data: [{ b64_json: b64(PNG) }] }) });
    const result = await image!.execute({ prompt: "a red apple on a table" }, ctx);
    assert.match(result.content, /a-red-apple-on-a-table\.png/);
  });

  test("a second image with the same prompt does not overwrite the first", async () => {
    const sandbox = await workspace();
    const [image] = tools(sandbox, { postJson: async () => ({ data: [{ b64_json: b64(PNG) }] }) });
    const first = await image!.execute({ prompt: "apple" }, ctx);
    const second = await image!.execute({ prompt: "apple" }, ctx);
    assert.notEqual(
      /Saved (\S+)/.exec(first.content)?.[1],
      /Saved (\S+)/.exec(second.content)?.[1],
    );
  });

  test("it tells the model not to describe what it cannot see", async () => {
    // Otherwise the summary confidently describes an image nobody looked at.
    const sandbox = await workspace();
    const [image] = tools(sandbox, { postJson: async () => ({ data: [{ b64_json: b64(PNG) }] }) });
    const result = await image!.execute({ prompt: "x" }, ctx);
    assert.match(result.content, /you have not seen it/i);
  });

  test("an empty prompt is refused before a request is made", async () => {
    let requested = false;
    const [image] = tools(await workspace(), {
      postJson: async () => {
        requested = true;
        return {};
      },
    });
    const result = await image!.execute({ prompt: "   " }, ctx);
    assert.equal(result.ok, false);
    assert.equal(requested, false);
  });

  test("a gateway failure is a result the model can act on, not a throw", async () => {
    const [image] = tools(await workspace(), {
      postJson: async () => {
        throw new Error("503 Service Unavailable");
      },
    });
    const result = await image!.execute({ prompt: "x" }, ctx);
    assert.equal(result.ok, false);
    assert.match(result.content, /503/);
  });

  test("an unknown model is refused with the list of real ones", async () => {
    const [image] = tools(await workspace(), {});
    const result = await image!.execute({ prompt: "x", model: "dall-e-3" }, ctx);
    assert.equal(result.ok, false);
    assert.match(result.content, /Qwen-Image/);
  });

  test("the file lands under the generated-assets directory", async () => {
    const sandbox = await workspace();
    const [image] = tools(sandbox, { postJson: async () => ({ data: [{ b64_json: b64(PNG) }] }) });
    const result = await image!.execute({ prompt: "x" }, ctx);
    assert.match(result.content, /assets\/generated\//);
  });

  test("the approval sentence says what will happen, in Korean", async () => {
    const [image] = tools(await workspace(), {});
    const sentence = image!.summarize({ prompt: "a red apple" });
    assert.match(sentence, /이미지/);
    assert.match(sentence, /a red apple/);
  });
});

describe("generating a video", () => {
  const videoTools = async (transport: Partial<MediaTransport>) =>
    tools(await workspace(), transport, { image: [], video: [VIDEO_MODEL] });

  test("a completed job whose file is withheld is not reported as a failure", async () => {
    // The observed case. The user can check whether the job ran, and telling
    // them it failed when it did not is the one answer that loses their trust.
    const [video] = await videoTools({
      postJson: async () => ({ job_id: "vid_1", status: "COMPLETED", artifact_url: "/files/a.webm", seconds: 0.8 }),
      getBinary: async () => null,
    });
    const result = await video!.execute({ prompt: "a cat" }, ctx);
    assert.match(result.content, /was generated/);
    assert.match(result.content, /vid_1/, "the job id is passed on");
    assert.doesNotMatch(result.content, /failed to generate/i);
  });

  test("it tells the model not to burn the same GPU time twice", async () => {
    const [video] = await videoTools({
      postJson: async () => ({ job_id: "j", status: "COMPLETED", artifact_url: "/f.webm" }),
      getBinary: async () => null,
    });
    const result = await video!.execute({ prompt: "x" }, ctx);
    assert.match(result.content, /Do not retry/i);
  });

  test("the file is written when the gateway does serve it", async () => {
    const sandbox = await workspace();
    const made = createMediaTools({
      sandbox,
      transport: {
        postJson: async () => ({ job_id: "j", status: "COMPLETED", artifact_url: "/files/a.webm" }),
        getJson: async () => ({}),
        getBinary: async () => new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
      },
      imageModels: [],
      videoModels: [VIDEO_MODEL],
      videoSpecFor: async () => SPEC,
    });
    const result = await made[0]!.execute({ prompt: "a cat" }, ctx);
    assert.ok(result.ok, result.content);
    assert.match(result.content, /\.webm/);
  });

  test("the requested length is aligned to what the model accepts", async () => {
    let sent: Record<string, unknown> = {};
    const [video] = await videoTools({
      postJson: async (_p, body) => {
        sent = body as Record<string, unknown>;
        return { job_id: "j", status: "COMPLETED" };
      },
    });
    await video!.execute({ prompt: "x", seconds: 1.1 }, ctx);
    assert.equal((sent["length"] as number) % SPEC.frameAlign, 0);
    assert.equal(sent["size"], "832x480", "a size the model publishes");
  });

  test("the approval sentence warns about the cost", async () => {
    const [video] = await videoTools({});
    assert.match(video!.summarize({ prompt: "x", seconds: 2 }), /GPU 시간/);
  });
});

describe("naming files", () => {
  test("a Korean prompt does not become `generated`", () => {
    assert.equal(fileNameFor("빨간 사과 그림", "png", () => false), "빨간-사과-그림.png");
  });

  test("punctuation and spacing collapse to single hyphens", () => {
    assert.equal(fileNameFor("a  red,  apple!!", "png", () => false), "a-red-apple.png");
  });

  test("a prompt with nothing usable still yields a filename", () => {
    assert.equal(fileNameFor("!!! ???", "png", () => false), "generated.png");
    assert.equal(fileNameFor("", "png", () => false), "generated.png");
  });

  test("long prompts are cut without leaving a trailing hyphen", () => {
    const name = fileNameFor("a ".repeat(200), "png", () => false);
    assert.ok(name.length <= 53, name);
    assert.ok(!name.includes("-."), name);
  });

  test("collisions are resolved rather than overwritten", () => {
    const taken = new Set(["apple.png", "apple-2.png"]);
    assert.equal(fileNameFor("apple", "png", (n) => taken.has(n)), "apple-3.png");
  });
});

describe("the sandbox still bounds it", () => {
  test("a generated file cannot escape the workspace", async () => {
    const sandbox = await workspace();
    await assert.rejects(() => sandbox.writeBytes("../escaped.png", PNG));
  });

  test("bytes survive a round trip through the sandbox", async () => {
    const sandbox = await workspace();
    const bytes = new Uint8Array(256).map((_, i) => i);
    await sandbox.writeBytes("deep/nested/x.bin", bytes);
    assert.deepEqual([...(await readFile(join(sandbox.root, "deep/nested/x.bin")))], [...bytes]);
  });

  test("an existing file is not silently replaced by a generated one", async () => {
    const sandbox = await workspace();
    await mkdir(join(sandbox.root, "assets/generated"), { recursive: true });
    await writeFile(join(sandbox.root, "assets/generated/apple.png"), "original");
    const [image] = tools(sandbox, { postJson: async () => ({ data: [{ b64_json: b64(PNG) }] }) });
    await image!.execute({ prompt: "apple" }, ctx);
    assert.equal(await readFile(join(sandbox.root, "assets/generated/apple.png"), "utf8"), "original");
  });
});

/**
 * The contract between the tool and the panel.
 *
 * The result string is the only channel a tool has to the UI, so its format is
 * an interface. It had been a regex in the extension and a template string
 * here, with nothing connecting them — a change to either would have stopped
 * images appearing while every test still passed and the generation still
 * worked. That is the kind of bug that survives for months.
 */
describe("reading back where a file was saved", () => {
  test("the round trip works on a real tool result", async () => {
    const sandbox = await workspace();
    const [image] = tools(sandbox, { postJson: async () => ({ data: [{ b64_json: b64(PNG) }] }) });
    const result = await image!.execute({ prompt: "a red apple" }, ctx);

    const saved = parseSavedArtifact(result.content);
    assert.equal(saved?.kind, "image");
    assert.equal(saved?.path, "assets/generated/a-red-apple.png");
    // The path the panel will build a URI from must be the file that exists.
    await readFile(join(sandbox.root, saved!.path));
  });

  test("a video result round trips too", async () => {
    const sandbox = await workspace();
    const made = createMediaTools({
      sandbox,
      transport: {
        postJson: async () => ({ job_id: "j", status: "COMPLETED", artifact_url: "/files/a.webm" }),
        getJson: async () => ({}),
        getBinary: async () => new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
      },
      imageModels: [], videoModels: [VIDEO_MODEL], videoSpecFor: async () => SPEC,
    });
    const result = await made[0]!.execute({ prompt: "a cat" }, ctx);
    assert.equal(parseSavedArtifact(result.content)?.kind, "video");
  });

  test("a failed result yields nothing to show", () => {
    assert.equal(parseSavedArtifact("generation failed: 503"), null);
    assert.equal(parseSavedArtifact(""), null);
  });

  test("the withheld-video message is not mistaken for a saved file", () => {
    // It says "was generated", not "Saved" — the panel must not try to render
    // a file that was never written.
    const message =
      "The video was generated (job vid_1, 0.8s of footage) but the gateway would not serve the file";
    assert.equal(parseSavedArtifact(message), null);
  });

  test("a path that escapes the workspace is refused", () => {
    // Nothing should be able to talk the panel into building a URI for an
    // arbitrary file, whatever ends up in a tool result.
    for (const path of ["../secrets.png", "/etc/passwd.png", "C:\\Windows\\x.png", "a/../../b.png"]) {
      assert.equal(parseSavedArtifact(`Saved ${path} (1 KB, m).`), null, path);
    }
  });

  test("a file that is not media is refused", () => {
    for (const path of ["notes.txt", "script.js", "archive.zip", "noextension"]) {
      assert.equal(parseSavedArtifact(`Saved ${path} (1 KB, m).`), null, path);
    }
  });

  test("every media extension the tools can produce is recognised", () => {
    // imageExtension returns one of these, and a video artifact url yields the
    // rest; an unrecognised one silently stops the picture from appearing.
    for (const ext of ["png", "jpg", "webp", "webm", "mp4"]) {
      assert.ok(parseSavedArtifact(`Saved assets/generated/x.${ext} (1 KB, m).`), ext);
    }
  });
});
