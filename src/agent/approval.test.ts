import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_POLICIES,
  ApprovalManager,
  allowingApprovalPort,
  denyingApprovalPort,
  recordingApprovalPort,
} from "./approval.ts";
import { RISK_ORDER, type ApprovalMode, type ApprovalRequest, type ToolRisk } from "./types.ts";

const RISKS: ToolRisk[] = ["read", "write", "execute", "dangerous"];
const MODES: ApprovalMode[] = ["safe", "balanced", "auto"];

function request(risk: ToolRisk): ApprovalRequest {
  return { toolName: `tool_${risk}`, risk, summary: `${risk} 작업을 수행합니다`, preview: null };
}

describe("the policy table", () => {
  test("dangerous is never permitted, in any mode", () => {
    // Not "asked about". A prompt the user can say yes to is a prompt they will
    // eventually say yes to at the wrong moment.
    for (const mode of MODES) {
      assert.ok(
        RISK_ORDER[APPROVAL_POLICIES[mode].askUpTo] < RISK_ORDER.dangerous,
        `${mode} would ask about a dangerous action`,
      );
    }
  });

  test("safe is the strictest and auto the loosest", () => {
    assert.equal(APPROVAL_POLICIES.safe.autoUpTo, "read");
    assert.equal(APPROVAL_POLICIES.balanced.autoUpTo, "write");
    assert.equal(APPROVAL_POLICIES.auto.autoUpTo, "execute");
  });

  test("nothing is auto-approved above what may be asked", () => {
    for (const mode of MODES) {
      const { autoUpTo, askUpTo } = APPROVAL_POLICIES[mode];
      if (autoUpTo === null) continue;
      assert.ok(RISK_ORDER[autoUpTo] <= RISK_ORDER[askUpTo], mode);
    }
  });
});

describe("ApprovalManager", () => {
  test("defaults to safe", () => {
    const manager = new ApprovalManager({ port: denyingApprovalPort });
    assert.equal(manager.currentMode, "safe");
  });

  test("safe: reads run, writes and commands are asked", async () => {
    const { port, requests } = recordingApprovalPort(() => true);
    const manager = new ApprovalManager({ mode: "safe", port });

    assert.equal(await manager.decide(request("read")), "auto");
    assert.equal(await manager.decide(request("write")), "granted");
    assert.equal(await manager.decide(request("execute")), "granted");
    assert.deepEqual(requests.map((r) => r.risk), ["write", "execute"]);
  });

  test("balanced: edits flow, commands still stop", async () => {
    const { port, requests } = recordingApprovalPort(() => true);
    const manager = new ApprovalManager({ mode: "balanced", port });

    assert.equal(await manager.decide(request("write")), "auto");
    assert.equal(await manager.decide(request("execute")), "granted");
    assert.deepEqual(requests.map((r) => r.risk), ["execute"]);
  });

  test("auto asks nothing below dangerous", async () => {
    const { port, requests } = recordingApprovalPort(() => true);
    const manager = new ApprovalManager({ mode: "auto", port });

    for (const risk of ["read", "write", "execute"] as const) {
      assert.equal(await manager.decide(request(risk)), "auto");
    }
    assert.deepEqual(requests, []);
  });

  test("dangerous is blocked without asking, in every mode", async () => {
    for (const mode of MODES) {
      const { port, requests } = recordingApprovalPort(() => true);
      const manager = new ApprovalManager({ mode, port });
      assert.equal(await manager.decide(request("dangerous")), "blocked", mode);
      assert.deepEqual(requests, [], `${mode} asked about a dangerous action`);
    }
  });

  test("a refusal is reported as denied, not as an error", async () => {
    const manager = new ApprovalManager({ mode: "safe", port: denyingApprovalPort });
    assert.equal(await manager.decide(request("write")), "denied");
  });

  test("the request carries a sentence, not arguments", async () => {
    const { port, requests } = recordingApprovalPort(() => true);
    const manager = new ApprovalManager({ mode: "safe", port });
    await manager.decide({ ...request("write"), summary: "src/auth.ts 파일을 작성합니다 (41줄)" });

    const asked = requests[0];
    assert.ok(asked !== undefined);
    assert.match(asked.summary, /[가-힣]/, "the user is asked in their own language");
    assert.doesNotMatch(asked.summary, /[{}]/, "the user is not shown a JSON blob");
  });

  test("isAutomatic agrees with decide", async () => {
    for (const mode of MODES) {
      const manager = new ApprovalManager({ mode, port: allowingApprovalPort });
      for (const risk of RISKS) {
        const automatic = manager.isAutomatic(risk);
        const outcome = await manager.decide(request(risk));
        assert.equal(automatic, outcome === "auto", `${mode}/${risk}`);
      }
    }
  });
});

describe("remembered grants", () => {
  test("off by default: every write is asked again", async () => {
    const { port, requests } = recordingApprovalPort(() => true);
    const manager = new ApprovalManager({ mode: "safe", port });
    await manager.decide(request("write"));
    await manager.decide(request("write"));
    assert.equal(requests.length, 2);
  });

  test("when on, a granted tool is not asked twice", async () => {
    const { port, requests } = recordingApprovalPort(() => true);
    const manager = new ApprovalManager({ mode: "safe", port, rememberGrants: true });
    assert.equal(await manager.decide(request("write")), "granted");
    assert.equal(await manager.decide(request("write")), "granted");
    assert.equal(requests.length, 1);
  });

  test("a denial is never remembered", async () => {
    // Remembering a "no" would silently refuse a later request the user might
    // well have approved.
    let answer = false;
    const { port } = recordingApprovalPort(() => answer);
    const manager = new ApprovalManager({ mode: "safe", port, rememberGrants: true });

    assert.equal(await manager.decide(request("write")), "denied");
    answer = true;
    assert.equal(await manager.decide(request("write")), "granted");
  });

  test("changing mode forgets what was granted under the old one", async () => {
    const { port, requests } = recordingApprovalPort(() => true);
    const manager = new ApprovalManager({ mode: "safe", port, rememberGrants: true });
    await manager.decide(request("execute"));

    manager.setMode("balanced");
    await manager.decide(request("execute"));
    assert.equal(requests.length, 2, "a grant given under another policy must not carry");
  });

  test("grants are per tool and risk, not global", async () => {
    const { port, requests } = recordingApprovalPort(() => true);
    const manager = new ApprovalManager({ mode: "safe", port, rememberGrants: true });
    await manager.decide({ ...request("write"), toolName: "create_file" });
    await manager.decide({ ...request("write"), toolName: "apply_patch" });
    assert.equal(requests.length, 2);
  });

  test("reset forgets everything", async () => {
    const { port, requests } = recordingApprovalPort(() => true);
    const manager = new ApprovalManager({ mode: "safe", port, rememberGrants: true });
    await manager.decide(request("write"));
    manager.reset();
    await manager.decide(request("write"));
    assert.equal(requests.length, 2);
  });
});

describe("switching modes", () => {
  test("setMode changes what runs without asking", async () => {
    const { port } = recordingApprovalPort(() => true);
    const manager = new ApprovalManager({ mode: "safe", port });
    assert.equal(await manager.decide(request("write")), "granted");

    manager.setMode("auto");
    assert.equal(await manager.decide(request("write")), "auto");

    manager.setMode("safe");
    assert.equal(await manager.decide(request("write")), "granted");
  });

  test("no mode can be talked into permitting dangerous", async () => {
    const manager = new ApprovalManager({ mode: "safe", port: allowingApprovalPort });
    for (const mode of MODES) {
      manager.setMode(mode);
      assert.equal(await manager.decide(request("dangerous")), "blocked", mode);
    }
  });
});
