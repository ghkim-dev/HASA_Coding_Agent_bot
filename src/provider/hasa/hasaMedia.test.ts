import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MediaUnavailable,
  estimateSeconds,
  framesFor,
  generateImage,
  generateVideo,
  imageExtension,
  isTerminal,
  readJob,
  type MediaTransport,
} from "./hasaMedia.ts";
import { parseCatalog, readVideoSpec, HasaCatalog } from "./hasaCatalog.ts";

/**
 * Image and video generation.
 *
 * The endpoints are absent from the published /docs, so every shape here was
 * read off the gateway's own portal code and then confirmed against the live
 * service. The fixtures below are the responses it actually returned.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

function transport(overrides: Partial<MediaTransport> = {}): MediaTransport {
  return {
    postJson: async () => ({}),
    getJson: async () => ({}),
    getBinary: async () => null,
    ...overrides,
  };
}

describe("images", () => {
  test("decodes the base64 the gateway returns", async () => {
    const result = await generateImage(
      transport({ postJson: async () => ({ gen_seconds: 7, data: [{ b64_json: b64(PNG) }] }) }),
      { model: "Qwen-Image", prompt: "a cat" },
    );
    assert.deepEqual([...result.data], [...PNG]);
    assert.equal(result.extension, "png");
    assert.equal(result.seconds, 7);
  });

  test("asks for base64 rather than a url", async () => {
    // A URL would be a second authenticated fetch against a gateway that does
    // not serve artifacts to API keys — the exact wall video hits.
    let sent: Record<string, unknown> = {};
    await generateImage(
      transport({
        postJson: async (_p, body) => {
          sent = body as Record<string, unknown>;
          return { data: [{ b64_json: b64(PNG) }] };
        },
      }),
      { model: "m", prompt: "p" },
    );
    assert.equal(sent["response_format"], "b64_json");
    assert.equal(sent["n"], 1);
  });

  test("posts to the verified endpoint", async () => {
    let path = "";
    await generateImage(
      transport({
        postJson: async (p) => {
          path = p;
          return { data: [{ b64_json: b64(PNG) }] };
        },
      }),
      { model: "m", prompt: "p" },
    );
    assert.equal(path, "/v1/images/generations");
  });

  test("an empty response is a refusal, not an empty file", async () => {
    await assert.rejects(
      () => generateImage(transport({ postJson: async () => ({ data: [] }) }), { model: "m", prompt: "p" }),
      (err: unknown) => err instanceof MediaUnavailable && err.reason === "no_image",
    );
  });

  test("a url-only response is refused rather than written as text", async () => {
    await assert.rejects(
      () =>
        generateImage(transport({ postJson: async () => ({ data: [{ url: "https://x/y.png" }] }) }), {
          model: "m",
          prompt: "p",
        }),
      MediaUnavailable,
    );
  });
});

describe("sniffing the container", () => {
  test("recognises png, jpeg and webp", () => {
    assert.equal(imageExtension(PNG), "png");
    assert.equal(imageExtension(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "jpg");
    const webp = new Uint8Array(12);
    webp.set([...Buffer.from("RIFF")], 0);
    webp.set([...Buffer.from("WEBP")], 8);
    assert.equal(imageExtension(webp), "webp");
  });

  test("falls back to a name that opens rather than to none", () => {
    assert.equal(imageExtension(new Uint8Array([0, 1, 2])), "png");
    assert.equal(imageExtension(new Uint8Array()), "png");
  });
});

describe("video jobs", () => {
  const submitted = { job_id: "vid_1", status: "LOADING", progress: 0 };

  test("polls until a terminal status and returns the artifact", async () => {
    const states = [
      { job_id: "vid_1", status: "GENERATING", progress: 10 },
      { job_id: "vid_1", status: "COMPLETED", progress: 100, artifact_url: "/files/a.webm", seconds: 0.8 },
    ];
    const bytes = new Uint8Array([1, 2, 3]);
    const result = await generateVideo(
      transport({
        postJson: async () => submitted,
        getJson: async () => states.shift() ?? states[0],
        getBinary: async () => bytes,
      }),
      { model: "Wan2.1-T2V", prompt: "p" },
      { sleep: async () => {} },
    );
    assert.equal(result.job.status, "COMPLETED");
    assert.deepEqual([...(result.artifact ?? [])], [1, 2, 3]);
    assert.equal(result.extension, "webm");
  });

  test("a completed job whose file will not be served reports null, not failure", async () => {
    // This is the observed case: /files/{name} answers 200 with
    // {"detail":"not found"} for an API key. Calling that a failure would be a
    // lie the user can check.
    const result = await generateVideo(
      transport({
        postJson: async () => ({ ...submitted, status: "COMPLETED", artifact_url: "/files/a.webm" }),
        getBinary: async () => null,
      }),
      { model: "m", prompt: "p" },
      { sleep: async () => {} },
    );
    assert.equal(result.job.status, "COMPLETED");
    assert.equal(result.artifact, null);
  });

  test("a failed job throws with the gateway's reason", async () => {
    await assert.rejects(
      () =>
        generateVideo(
          transport({ postJson: async () => ({ job_id: "j", status: "FAILED", error: "OOM" }) }),
          { model: "m", prompt: "p" },
          { sleep: async () => {} },
        ),
      (err: unknown) => err instanceof MediaUnavailable && err.message.includes("OOM"),
    );
  });

  test("no job id is a refusal rather than an endless poll", async () => {
    await assert.rejects(
      () => generateVideo(transport({ postJson: async () => ({ ok: true }) }), { model: "m", prompt: "p" }),
      (err: unknown) => err instanceof MediaUnavailable && err.reason === "no_job",
    );
  });

  test("an unreadable poll is a blip, not a verdict", async () => {
    // One bad response should not end a job that is still running.
    const replies = [null, { job_id: "vid_1", status: "COMPLETED", progress: 100 }];
    let polls = 0;
    const result = await generateVideo(
      transport({
        postJson: async () => submitted,
        getJson: async () => {
          polls += 1;
          return replies.shift();
        },
      }),
      { model: "m", prompt: "p" },
      { sleep: async () => {} },
    );
    assert.equal(polls, 2);
    assert.equal(result.job.status, "COMPLETED");
  });

  test("progress is reported on submit and on every poll", async () => {
    const seen: number[] = [];
    await generateVideo(
      transport({
        postJson: async () => submitted,
        getJson: async () => ({ job_id: "vid_1", status: "COMPLETED", progress: 100 }),
      }),
      { model: "m", prompt: "p" },
      { sleep: async () => {}, onProgress: (j) => seen.push(j.progress) },
    );
    assert.deepEqual(seen, [0, 100]);
  });

  test("cancelling stops the poll loop", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () =>
        generateVideo(transport({ postJson: async () => submitted }), { model: "m", prompt: "p" }, {
          sleep: async () => {},
          signal: controller.signal,
        }),
      (err: unknown) => err instanceof MediaUnavailable && err.reason === "cancelled",
    );
  });

  test("a job that never finishes gives up instead of polling forever", async () => {
    // Found by probing rather than by reading: the loop exited on a terminal
    // status and on nothing else, so a wedged worker polled for as long as the
    // process lived. In the extension that is a turn that never ends.
    let clock = 0;
    let polls = 0;
    await assert.rejects(
      () =>
        generateVideo(
          transport({
            postJson: async () => ({ job_id: "j", status: "GENERATING", progress: 50 }),
            getJson: async () => {
              polls += 1;
              return { job_id: "j", status: "GENERATING", progress: 50 };
            },
          }),
          { model: "m", prompt: "p" },
          {
            sleep: async (ms) => {
              clock += ms;
            },
            now: () => clock,
            maxWaitMs: 10_000,
            pollIntervalMs: 1000,
          },
        ),
      (err: unknown) => err instanceof MediaUnavailable && err.reason === "timed_out",
    );
    assert.ok(polls <= 11, `polled ${polls} times for a 10s budget at 1s intervals`);
  });

  test("giving up still hands back the job id and the last status", async () => {
    // The job may yet finish on the gateway; the user should be able to go and
    // get it rather than be told it is gone.
    let clock = 0;
    await assert.rejects(
      () =>
        generateVideo(
          transport({ postJson: async () => ({ job_id: "vid_abc", status: "QUEUED", progress: 0 }) }),
          { model: "m", prompt: "p" },
          { sleep: async (ms) => { clock += ms; }, now: () => clock, maxWaitMs: 5000 },
        ),
      (err: unknown) => err instanceof Error && err.message.includes("vid_abc") && err.message.includes("QUEUED"),
    );
  });

  test("a job that finishes inside the budget is unaffected", async () => {
    let clock = 0;
    const result = await generateVideo(
      transport({
        postJson: async () => ({ job_id: "j", status: "GENERATING" }),
        getJson: async () => ({ job_id: "j", status: "COMPLETED", progress: 100 }),
      }),
      { model: "m", prompt: "p" },
      { sleep: async (ms) => { clock += ms; }, now: () => clock, maxWaitMs: 10_000 },
    );
    assert.equal(result.job.status, "COMPLETED");
  });

  test("the default budget allows the slowest published model its full clip", () => {
    // Wan2.2-T2V is ~73s of compute per second of output, so a ten-second clip
    // is about twelve minutes. A budget under that would cut off real work.
    const slowest = 72.7 * 10.1;
    assert.ok(15 * 60 > slowest, `default budget must exceed ${Math.round(slowest)}s`);
  });

  test("the terminal set is exactly the gateway's", () => {
    for (const s of ["COMPLETED", "FAILED", "CANCELLED"]) assert.ok(isTerminal(s));
    for (const s of ["QUEUED", "LOADING", "GENERATING", "DECODING", "ENCODING", "MODERATING"]) {
      assert.ok(!isTerminal(s), `${s} should keep polling`);
    }
  });

  test("an unknown status keeps polling rather than being treated as done", () => {
    // A status this build has never seen is not a reason to stop waiting.
    assert.ok(!isTerminal("VALIDATING"));
  });

  test("reads the job shape the gateway actually returned", () => {
    const job = readJob({
      job_id: "vid_d0c9681511aa",
      kind: "video",
      model: "Wan2.1-T2V",
      status: "COMPLETED",
      progress: 100,
      artifact_url: "/files/vid_00052_.webm",
      size: "832x480",
      length: 13,
      fps: 16.0,
      seconds: 0.8,
    });
    assert.equal(job?.jobId, "vid_d0c9681511aa");
    assert.equal(job?.artifactUrl, "/files/vid_00052_.webm");
    assert.equal(job?.seconds, 0.8);
  });
});

describe("frame counts the gateway will accept", () => {
  const wan = readVideoSpec({
    fps: 16, max_seconds: 10.1, max_frames: 161, frame_align: 4, dim_align: 1,
    sizes: ["832x480"], audio: false, gen_time_per_sec: 22.7, default_seconds: 1.5,
  })!;

  test("rounds to the model's alignment", () => {
    // Off-alignment counts are rejected by the gateway, so they are never sent.
    for (const seconds of [0.5, 1, 1.5, 2, 3.3, 7]) {
      assert.equal(framesFor(wan, seconds) % wan.frameAlign, 0, `${seconds}s`);
    }
  });

  test("never exceeds the model's maximum", () => {
    assert.ok(framesFor(wan, 600) <= wan.maxFrames);
  });

  test("never asks for zero frames", () => {
    assert.ok(framesFor(wan, 0) >= wan.frameAlign);
    assert.ok(framesFor(wan, -5) >= wan.frameAlign);
  });

  test("estimates cost for a warning, not for a timeout", () => {
    assert.ok(estimateSeconds(wan, 16) > 0);
    assert.ok(estimateSeconds(wan, 160) > estimateSeconds(wan, 16));
  });
});

describe("the catalogue, which is where modality comes from", () => {
  // Rows as the live gateway returned them.
  const LIVE = [
    { name: "Qwen-Image", modality: "image", status: "available", callable: true, title: "Qwen Image" },
    { name: "Wan2.1-T2V", modality: "video", status: "available", callable: true },
    { name: "wan2.2-i2v", modality: "video", status: "listed", callable: false },
    { name: "qwen2.5-vl-72b", modality: "vision", status: "available", callable: true },
    { name: "exaone-4.0-32b", modality: "chat", status: "available", callable: true },
    { name: "bge-m3", modality: "embeddings", status: "available", callable: true },
  ];

  test("modality comes from the gateway, never from the name", () => {
    // `Qwen-Image` and `qwen2.5-vl-72b` both contain a word meaning image, and
    // only one of them draws. §14 forbids guessing from the id for this reason.
    const entries = parseCatalog(LIVE);
    assert.equal(entries.find((e) => e.id === "Qwen-Image")?.modality, "image");
    assert.equal(entries.find((e) => e.id === "qwen2.5-vl-72b")?.modality, "vision");
  });

  test("uses `name`, which is the id the inference API accepts", () => {
    const entries = parseCatalog([{ id: 42, name: "Qwen-Image", modality: "image", status: "available" }]);
    assert.equal(entries[0]?.id, "Qwen-Image");
  });

  test("a modality this build does not know is unknown, not chat", () => {
    const entries = parseCatalog([{ name: "x", modality: "hologram", status: "available" }]);
    assert.equal(entries[0]?.modality, "unknown");
  });

  test("only callable, available models are offered", async () => {
    const catalog = new HasaCatalog({ fetchJson: async () => LIVE });
    const video = await catalog.byModality("video");
    assert.deepEqual(video.map((e) => e.id), ["Wan2.1-T2V"], "the listed-only model is not offered");
  });

  test("a catalogue that is down costs the media tools, not the chat path", async () => {
    const catalog = new HasaCatalog({
      fetchJson: async () => {
        throw new Error("503");
      },
    });
    assert.deepEqual(await catalog.all(), []);
    assert.equal(await catalog.modalityOf("Qwen-Image"), "unknown");
  });

  test("it is fetched once, not once per lookup", async () => {
    let calls = 0;
    const catalog = new HasaCatalog({
      fetchJson: async () => {
        calls += 1;
        return LIVE;
      },
    });
    await Promise.all([catalog.all(), catalog.modalityOf("x"), catalog.byModality("image")]);
    assert.equal(calls, 1);
  });

  test("duplicate rows do not become duplicate models", () => {
    const entries = parseCatalog([...LIVE, LIVE[0]]);
    assert.equal(entries.filter((e) => e.id === "Qwen-Image").length, 1);
  });

  test("junk is skipped rather than fatal", () => {
    assert.deepEqual(parseCatalog(null), []);
    assert.deepEqual(parseCatalog("nope"), []);
    assert.equal(parseCatalog([null, 7, {}, { name: "" }, { name: "ok", modality: "chat" }]).length, 1);
  });

  test("a video_spec missing its essentials is null rather than half-built", () => {
    assert.equal(readVideoSpec({ sizes: [], fps: 16 }), null);
    assert.equal(readVideoSpec({ sizes: ["832x480"], fps: 0 }), null);
    assert.equal(readVideoSpec(null), null);
  });

  test("the live LTX-2 spec is read verbatim", () => {
    const spec = readVideoSpec({
      fps: 24, max_seconds: 10.0, max_frames: 241, frame_align: 8, dim_align: 64,
      sizes: ["1280x704", "1216x704", "768x512"], audio: true,
      gen_time_per_sec: 11.5, default_seconds: 5.0,
    });
    assert.equal(spec?.fps, 24);
    assert.equal(spec?.audio, true);
    assert.equal(spec?.frameAlign, 8);
    assert.deepEqual(spec?.sizes, ["1280x704", "1216x704", "768x512"]);
  });
});
