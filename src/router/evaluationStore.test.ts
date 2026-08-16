import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVIDENCE_FORMAT,
  EVIDENCE_TTL_MS,
  buildEvidenceFile,
  loadEvidence,
  saveEvidence,
  quarantineEvidence,
} from "./evaluationStore.ts";
import { fingerprint } from "./conversability.ts";
import type { EvaluationSummary } from "./modelRegistry.ts";

/**
 * The file between a sweep and a recommendation.
 *
 * Two properties carry the weight. Evidence is about the deployment that
 * produced it, so it must not survive a change of gateway; and every rejection
 * has to be a sentence somebody can read, because "no evidence" and "evidence
 * silently discarded" produce identical rankings and very different bugs.
 */

const BASE = "https://gateway.example/v1";
const OTHER = "https://elsewhere.example/v1";
const NOW = Date.parse("2026-08-16T00:00:00.000Z");

const SUMMARY: EvaluationSummary = {
  modelId: "worker-a",
  sampleCount: 20,
  sampleCounts: { requirementRecall: 20, recoveryRate: 2 },
  metrics: { requirementRecall: 0.8, recoveryRate: 0.5 },
};

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "evidence-store-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fileAt(measuredAt: string, baseUrl = BASE) {
  return buildEvidenceFile({
    measuredAt,
    baseUrl,
    scenarioIds: ["S01"],
    runsPerCell: 1,
    summaries: [SUMMARY],
  }).file;
}

describe("a round trip preserves what the registry needs", () => {
  test("summaries and their per-metric counts survive the file", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "e.json");
      await saveEvidence(fileAt(new Date(NOW).toISOString()), path);

      const loaded = await loadEvidence({ baseUrl: BASE, now: NOW, path });
      assert.equal(loaded.unusable, null);
      assert.equal(loaded.summaries.length, 1);
      assert.equal(loaded.summaries[0]?.sampleCounts?.recoveryRate, 2);
      assert.equal(loaded.summaries[0]?.metrics.requirementRecall, 0.8);
    });
  });

  test("the file records a fingerprint and never the URL itself", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "e.json");
      await saveEvidence(fileAt(new Date(NOW).toISOString()), path);
      const raw = await (await import("node:fs/promises")).readFile(path, "utf8");
      assert.ok(!raw.includes("gateway.example"), "the base URL must not be in the file");
      assert.ok(raw.includes(fingerprint(BASE)));
    });
  });
});

describe("evidence does not travel between deployments", () => {
  test("a different gateway is refused, with a reason", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "e.json");
      await saveEvidence(fileAt(new Date(NOW).toISOString(), BASE), path);

      const loaded = await loadEvidence({ baseUrl: OTHER, now: NOW, path });
      assert.equal(loaded.summaries.length, 0);
      assert.match(loaded.unusable ?? "", /different gateway/);
    });
  });

  test("evidence past the time limit is refused", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "e.json");
      const old = new Date(NOW - EVIDENCE_TTL_MS - 1).toISOString();
      await saveEvidence(fileAt(old), path);

      const loaded = await loadEvidence({ baseUrl: BASE, now: NOW, path });
      assert.equal(loaded.summaries.length, 0);
      assert.match(loaded.unusable ?? "", /days old/);
    });
  });

  test("evidence exactly at the limit is still usable", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "e.json");
      await saveEvidence(fileAt(new Date(NOW - EVIDENCE_TTL_MS).toISOString()), path);
      const loaded = await loadEvidence({ baseUrl: BASE, now: NOW, path });
      assert.equal(loaded.unusable, null);
    });
  });
});

describe("every refusal is explained rather than silent", () => {
  test("a missing file names the path it looked at", async () => {
    const loaded = await loadEvidence({ baseUrl: BASE, now: NOW, path: join(tmpdir(), "nope-xyz.json") });
    assert.equal(loaded.summaries.length, 0);
    assert.match(loaded.unusable ?? "", /nope-xyz\.json/);
    assert.match(loaded.unusable ?? "", /eligibility only/);
  });

  test("unreadable JSON is a reason, not a crash", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "e.json");
      await writeFile(path, "{ not json", "utf8");
      const loaded = await loadEvidence({ baseUrl: BASE, now: NOW, path });
      assert.match(loaded.unusable ?? "", /not readable JSON/);
    });
  });

  test("a future format is refused rather than half-read", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "e.json");
      const file = { ...fileAt(new Date(NOW).toISOString()), format: "evaluation-evidence-v9" };
      await writeFile(path, JSON.stringify(file), "utf8");
      const loaded = await loadEvidence({ baseUrl: BASE, now: NOW, path });
      assert.match(loaded.unusable ?? "", new RegExp(EVIDENCE_FORMAT));
    });
  });

  test("an empty summary list is reported as empty, not as evidence", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "e.json");
      const { file } = buildEvidenceFile({
        measuredAt: new Date(NOW).toISOString(),
        baseUrl: BASE,
        scenarioIds: [],
        runsPerCell: 1,
        summaries: [],
      });
      await saveEvidence(file, path);
      const loaded = await loadEvidence({ baseUrl: BASE, now: NOW, path });
      assert.match(loaded.unusable ?? "", /no model summaries/);
    });
  });
});

describe("the write refuses what the sweep should not have scored", () => {
  test("a model verified not to converse never reaches the file", () => {
    const { file, refused } = buildEvidenceFile({
      measuredAt: new Date(NOW).toISOString(),
      baseUrl: BASE,
      scenarioIds: ["S01"],
      runsPerCell: 1,
      summaries: [SUMMARY, { ...SUMMARY, modelId: "video-model" }],
      conversability: new Map([["video-model", false]]),
    });
    assert.deepEqual(
      file.summaries.map((s) => s.modelId),
      ["worker-a"],
    );
    assert.equal(refused.length, 1);
    assert.equal(refused[0]?.modelId, "video-model");
    assert.match(refused[0]?.reason ?? "", /not to serve chat/);
  });

  test("unknown conversability is not a refusal", () => {
    const { file, refused } = buildEvidenceFile({
      measuredAt: new Date(NOW).toISOString(),
      baseUrl: BASE,
      scenarioIds: ["S01"],
      runsPerCell: 1,
      summaries: [SUMMARY],
      conversability: new Map(),
    });
    assert.equal(file.summaries.length, 1);
    assert.equal(refused.length, 0);
  });

  test("a model known to converse is kept", () => {
    const { file } = buildEvidenceFile({
      measuredAt: new Date(NOW).toISOString(),
      baseUrl: BASE,
      scenarioIds: ["S01"],
      runsPerCell: 1,
      summaries: [SUMMARY],
      conversability: new Map([["worker-a", true]]),
    });
    assert.equal(file.summaries.length, 1);
  });
});

describe("a dataset can be preserved and stripped of authority", () => {
  test("quarantined summaries load, and load somewhere production cannot reach", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "e.json");
      await saveEvidence(fileAt(new Date(NOW).toISOString()), path);

      const before = await loadEvidence({ baseUrl: BASE, now: NOW, path });
      assert.equal(before.summaries.length, 1, "usable before quarantine");

      await quarantineEvidence(
        "quarantined_completion_integrity_v1",
        "17 false completion escapes; survivor bias in the harness-failure exclusion",
        new Date(NOW).toISOString(),
        path,
      );

      const after = await loadEvidence({ baseUrl: BASE, now: NOW, path });
      assert.equal(after.summaries.length, 0, "production sees nothing");
      assert.equal(after.quarantined.length, 1, "the measurement is still there");
      assert.match(after.quarantine ?? "", /survivor bias/);
      assert.equal(after.unusable, null, "quarantine is not an error");
    });
  });

  test("quarantine changes no measurement", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "e.json");
      await saveEvidence(fileAt(new Date(NOW).toISOString()), path);
      const before = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));

      await quarantineEvidence("quarantined_completion_integrity_v1", "why", new Date(NOW).toISOString(), path);
      const after = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));

      assert.deepEqual(after.summaries, before.summaries);
      assert.equal(after.measuredAt, before.measuredAt);
      assert.deepEqual(after.scenarioIds, before.scenarioIds);
    });
  });

  test("a file written before quarantine existed still counts as usable", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "e.json");
      const file = fileAt(new Date(NOW).toISOString());
      assert.equal(file.datasetStatus, undefined, "the field is genuinely absent");
      await saveEvidence(file, path);
      const loaded = await loadEvidence({ baseUrl: BASE, now: NOW, path });
      assert.equal(loaded.summaries.length, 1);
      assert.equal(loaded.quarantine, null);
    });
  });

  test("an explicitly usable dataset is not quarantined", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "e.json");
      await saveEvidence({ ...fileAt(new Date(NOW).toISOString()), datasetStatus: "usable" }, path);
      const loaded = await loadEvidence({ baseUrl: BASE, now: NOW, path });
      assert.equal(loaded.summaries.length, 1);
      assert.equal(loaded.quarantined.length, 0);
    });
  });
});
