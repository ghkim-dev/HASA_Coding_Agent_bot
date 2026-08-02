import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  composeUserMessage,
  describeAttachmentProblems,
  imageTypeFor,
  looksSensitive,
  type Attachment,
} from "./attachments.ts";

/**
 * Files the user attaches to a message.
 *
 * The rule these hold to is that an attachment is never silently dropped. A
 * user who attaches a screenshot and gets an answer that ignores it has been
 * misled twice — by the answer, and by the interface that took the file. So
 * anything unsendable comes back as a reason, and the reason reaches the panel.
 */

const text = (name: string, body: string): Attachment => ({ kind: "text", name, text: body });
const image = (name = "shot.png", base64 = "AAAA"): Attachment => ({
  kind: "image",
  name,
  mediaType: "image/png",
  base64,
});

const contentOf = (message: { content: string | unknown[] }): string =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);

describe("text attachments", () => {
  test("the file is inlined and the question comes last", () => {
    // Last is what the model read most recently, and the question is the part
    // it must actually answer.
    const { message } = composeUserMessage("이 함수 고쳐줘", [text("a.py", "def f(): pass")]);
    const body = contentOf(message);
    assert.ok(body.indexOf("def f(): pass") < body.indexOf("이 함수 고쳐줘"));
  });

  test("the file is named, so the model can refer to it", () => {
    const { message } = composeUserMessage("설명해줘", [text("src/main.py", "x = 1")]);
    assert.match(contentOf(message), /src\/main\.py/);
  });

  test("a file containing a fence does not break out of its own block", () => {
    // A Markdown file with ``` in it would end the block early, and everything
    // after it would read as instructions rather than as content.
    const { message } = composeUserMessage("q", [text("README.md", "```\ncode\n```")]);
    const body = contentOf(message);
    assert.match(body, /````/, "the rail should be longer than the content's own fence");
  });

  test("several files are all included", () => {
    const { message } = composeUserMessage("q", [text("a.ts", "AAA"), text("b.ts", "BBB")]);
    const body = contentOf(message);
    assert.match(body, /AAA/);
    assert.match(body, /BBB/);
  });

  test("a long file is cut with a marker, not silently", () => {
    // The model must know it is reading part of a file, or it reasons about
    // code that is not there.
    const long = "x".repeat(5000);
    const result = composeUserMessage("q", [text("big.ts", long)], { limits: { maxTextChars: 1000 } });
    assert.deepEqual(result.truncated, ["big.ts"]);
    assert.match(contentOf(result.message), /truncated at 1000 of 5000/);
  });

  test("the total budget stops one file from crowding out the rest", () => {
    const result = composeUserMessage(
      "q",
      [text("a.ts", "x".repeat(900)), text("b.ts", "y".repeat(900))],
      { limits: { maxTotalChars: 1000, maxTextChars: 1000 } },
    );
    // Whatever was left out is reported rather than dropped.
    assert.ok(result.truncated.length + result.rejected.length > 0);
  });

  test("no attachments leaves the prompt exactly as typed", () => {
    const { message, rejected, truncated } = composeUserMessage("그냥 질문", []);
    assert.equal(message.content, "그냥 질문");
    assert.deepEqual(rejected, []);
    assert.deepEqual(truncated, []);
  });

  test("text-only messages stay a plain string on the wire", () => {
    // The array form is valid but a second shape is a second thing that can go
    // wrong at a gateway.
    const { message } = composeUserMessage("q", [text("a.ts", "x")]);
    assert.equal(typeof message.content, "string");
  });
});

describe("image attachments", () => {
  test("an image becomes a normalised image part, not a wire one", () => {
    // `image`, not `image_url` — the wire spelling belongs in wire.ts, and the
    // architecture test enforces it.
    const { message } = composeUserMessage("이거 뭐야", [image()], { vision: true });
    assert.ok(Array.isArray(message.content));
    const parts = message.content as Array<{ type: string; url?: string }>;
    assert.equal(parts[0]?.type, "image");
    assert.match(parts[0]?.url ?? "", /^data:image\/png;base64,/);
  });

  test("the typed question travels with the image", () => {
    const { message } = composeUserMessage("이거 뭐야", [image()], { vision: true });
    const parts = message.content as Array<{ type: string; text?: string }>;
    assert.equal(parts.at(-1)?.type, "text");
    assert.equal(parts.at(-1)?.text, "이거 뭐야");
  });

  test("a model measured as having no vision refuses the image rather than ignoring it", () => {
    const result = composeUserMessage("이거 뭐야", [image()], { vision: false });
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0]?.reason ?? "", /이미지를 읽지 못합니다/);
    assert.equal(typeof result.message.content, "string", "no image part was sent");
  });

  test("an unmeasured model is given the benefit of the doubt", () => {
    // §14's tristate: `unknown` is not `false`. Refusing on unknown would block
    // every model nobody has probed yet.
    const result = composeUserMessage("q", [image()], { vision: "unknown" });
    assert.deepEqual(result.rejected, []);
    assert.ok(Array.isArray(result.message.content));
  });

  test("an oversized image is refused with its size", () => {
    const big = "A".repeat(4 * 1024 * 1024);
    const result = composeUserMessage("q", [{ kind: "image", name: "big.png", mediaType: "image/png", base64: big }], {
      vision: true,
      limits: { maxImageBytes: 1024 * 1024 },
    });
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0]?.reason ?? "", /MB/);
  });

  test("a format the gateway will not take is refused here rather than there", () => {
    const result = composeUserMessage("q", [
      { kind: "image", name: "x.bmp", mediaType: "image/bmp", base64: "AAAA" },
    ], { vision: true });
    assert.equal(result.rejected.length, 1);
  });

  test("images and text can travel together", () => {
    const { message } = composeUserMessage("비교해줘", [image(), text("a.ts", "AAA")], { vision: true });
    const parts = message.content as Array<{ type: string; text?: string }>;
    assert.equal(parts.filter((p) => p.type === "image").length, 1);
    assert.match(parts.at(-1)?.text ?? "", /AAA/);
  });
});

describe("recognising an image", () => {
  test("by extension, case-insensitively", () => {
    assert.equal(imageTypeFor("a.PNG"), "image/png");
    assert.equal(imageTypeFor("a.jpg"), "image/jpeg");
    assert.equal(imageTypeFor("a.jpeg"), "image/jpeg");
    assert.equal(imageTypeFor("a.webp"), "image/webp");
    assert.equal(imageTypeFor("a.gif"), "image/gif");
  });

  test("anything else is not an image", () => {
    for (const name of ["a.ts", "a.bmp", "a.svg", "a", "a.png.txt"]) {
      assert.equal(imageTypeFor(name), null, name);
    }
  });
});

describe("files that are credentials rather than documents", () => {
  test("the obvious ones are flagged", () => {
    // The workspace picker cannot reach these — the sandbox forbids them. This
    // is for the other door: uploading any file from disk.
    for (const path of [
      ".env", ".env.local", "app/.env.production", "id_rsa", "server.pem",
      "cert.key", ".npmrc", ".netrc", "credentials.json", ".git-credentials",
      "C:\\Users\\me\\.aws\\config",
    ]) {
      assert.ok(looksSensitive(path), path);
    }
  });

  test("ordinary files are not", () => {
    for (const path of [
      "src/env.ts", "environment.md", "keyboard.ts", "monkey.py",
      "README.md", "package.json", "src/credentialStore.ts",
    ]) {
      assert.ok(!looksSensitive(path), path);
    }
  });
});

describe("what the user is told", () => {
  test("nothing, when nothing went wrong", () => {
    assert.equal(describeAttachmentProblems(composeUserMessage("q", [text("a.ts", "x")])), null);
  });

  test("the file and the reason, when something did", () => {
    const result = composeUserMessage("q", [image("shot.png")], { vision: false });
    const message = describeAttachmentProblems(result) ?? "";
    assert.match(message, /shot\.png/);
    assert.match(message, /[가-힣]/, "written for the user");
  });

  test("truncation is mentioned too, since it changes the answer", () => {
    const result = composeUserMessage("q", [text("big.ts", "x".repeat(500))], {
      limits: { maxTextChars: 100 },
    });
    assert.match(describeAttachmentProblems(result) ?? "", /big\.ts/);
  });
});
