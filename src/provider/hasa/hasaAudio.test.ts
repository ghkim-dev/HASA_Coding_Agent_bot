import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  AUDIO_EXTENSIONS,
  DEFAULT_MAX_AUDIO_MB,
  TranscriptionUnavailable,
  isAudioFile,
  needsConversion,
  transcribeAudio,
  type AudioTransport,
} from "./hasaAudio.ts";

/**
 * Listening.
 *
 * Every response shape below was taken from the live gateway on 2026-08-03,
 * including the one that matters most: this deployment normalises audio with
 * ffmpeg and does not have ffmpeg, so anything that is not already a 16 kHz mono
 * WAV comes back 503. A 503 reads as "try again later" and trying again later
 * will fail identically until somebody installs a binary on the server, which is
 * why that case is separated from the others rather than folded into them.
 */

function transport(reply: { status: number; body: unknown }): AudioTransport & { sent: FormData[] } {
  const sent: FormData[] = [];
  return {
    sent,
    async postForm(_path, form) {
      sent.push(form);
      return reply;
    },
  };
}

const OK = {
  status: 200,
  body: {
    text: " 회의를 시작하겠습니다. ",
    gitc_stt: { tier: "base", max_file_mb: 25, duration_sec: 12.5, chunked: false },
  },
};

const NEEDS_FFMPEG = {
  status: 503,
  body: {
    detail: {
      error: "stt_ffmpeg_required",
      message: "오디오 정규화(16kHz mono)에 ffmpeg가 필요합니다.",
      hint: "WAV로 변환해 업로드하거나 게이트웨이에 ffmpeg를 설치하세요",
    },
  },
};

const bytes = (n: number): Uint8Array => new Uint8Array(n);

describe("what counts as audio", () => {
  test("the containers a picker should offer", () => {
    for (const extension of AUDIO_EXTENSIONS) assert.equal(isAudioFile(`clip.${extension}`), true, extension);
    assert.equal(isAudioFile("notes.txt"), false);
    assert.equal(isAudioFile("deck.pptx"), false);
  });

  test("case in the extension does not decide it", () => {
    assert.equal(isAudioFile("RECORDING.WAV"), true);
  });

  test("only WAV goes through untouched", () => {
    // Not a claim about WAV being better — a claim about what this gateway can
    // read when the converter it depends on is missing.
    assert.equal(needsConversion("a.wav"), false);
    for (const extension of ["mp3", "m4a", "flac", "ogg", "webm"]) {
      assert.equal(needsConversion(`a.${extension}`), true, extension);
    }
  });
});

describe("transcribing", () => {
  test("returns the text, trimmed, with the duration the gateway reported", async () => {
    const result = await transcribeAudio(transport(OK), { model: "m", name: "회의.wav", bytes: bytes(1000) });
    assert.equal(result.text, "회의를 시작하겠습니다.");
    assert.equal(result.seconds, 12.5);
  });

  test("the model and the file both reach the request", async () => {
    const t = transport(OK);
    await transcribeAudio(t, { model: "speech-model", name: "회의.wav", bytes: bytes(10) });
    assert.equal(t.sent[0]?.get("model"), "speech-model");
    assert.ok(t.sent[0]?.get("file") instanceof Blob);
  });

  test("a language hint is sent only when given", async () => {
    const without = transport(OK);
    await transcribeAudio(without, { model: "m", name: "a.wav", bytes: bytes(10) });
    assert.equal(without.sent[0]?.get("language"), null);

    const with_ = transport(OK);
    await transcribeAudio(with_, { model: "m", name: "a.wav", bytes: bytes(10), language: "ko" });
    assert.equal(with_.sent[0]?.get("language"), "ko");
  });

  test("a file over the limit is refused before it is uploaded", async () => {
    // The upload is the expensive part and the answer is already known.
    const t = transport(OK);
    const err = await refusal(() =>
      transcribeAudio(t, { model: "m", name: "long.wav", bytes: bytes(3), maxBytes: 2 }),
    );
    assert.equal(err.reason, "too_large");
    assert.equal(t.sent.length, 0, "nothing should have been sent");
  });

  test("the default ceiling is the gateway's own", () => {
    assert.equal(DEFAULT_MAX_AUDIO_MB, 25);
  });
});

describe("refusals name whoever can fix them", () => {
  test("a missing ffmpeg is an operator action, not a retry", async () => {
    // The whole reason this class carries a flag. Reported as "try again" it
    // would be tried again forever.
    const err = await refusal(() =>
      transcribeAudio(transport(NEEDS_FFMPEG), { model: "m", name: "회의.mp3", bytes: bytes(10) }),
    );
    assert.equal(err.reason, "needs_ffmpeg");
    assert.equal(err.operatorAction, true);
    assert.match(err.userMessage, /ffmpeg/);
    assert.match(err.userMessage, /WAV/, "the user needs the workaround, not just the diagnosis");
  });

  test("a 403 is about the key, and is not an operator action", async () => {
    const err = await refusal(() =>
      transcribeAudio(transport({ status: 403, body: { detail: "no" } }), {
        model: "m",
        name: "a.wav",
        bytes: bytes(10),
      }),
    );
    assert.equal(err.reason, "forbidden");
    assert.equal(err.operatorAction, false);
  });

  test("a 200 with no speech in it is not reported as success", async () => {
    // "The model read your recording and it said nothing" and "your recording
    // was never read" lead somewhere different, and an empty string looks like
    // the first while being the second.
    const err = await refusal(() =>
      transcribeAudio(transport({ status: 200, body: { text: "   " } }), {
        model: "m",
        name: "silence.wav",
        bytes: bytes(10),
      }),
    );
    assert.equal(err.reason, "failed");
    assert.match(err.userMessage, /말소리를 찾지 못했습니다/);
  });

  test("an unexpected status still says which file and what happened", async () => {
    const err = await refusal(() =>
      transcribeAudio(transport({ status: 500, body: { detail: "boom" } }), {
        model: "m",
        name: "회의.wav",
        bytes: bytes(10),
      }),
    );
    assert.match(err.userMessage, /회의\.wav/);
    assert.match(err.userMessage, /500/);
  });

  test("a body that is not JSON does not become a crash", async () => {
    const err = await refusal(() =>
      transcribeAudio(transport({ status: 502, body: { detail: "<html>bad gateway</html>" } }), {
        model: "m",
        name: "a.wav",
        bytes: bytes(10),
      }),
    );
    assert.equal(err.reason, "failed");
  });
});

/** The refusal itself, so a test can assert what the user would be told. */
async function refusal(fn: () => Promise<unknown>): Promise<TranscriptionUnavailable> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof TranscriptionUnavailable, `expected a refusal, got ${String(err)}`);
    return err;
  }
  return assert.fail("expected the transcription to be refused");
}
