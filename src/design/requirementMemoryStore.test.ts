import { strict as assert } from "node:assert";
import { describe, it, beforeEach, after } from "node:test";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_ROWS,
  MEMORY_FORMAT,
  VECTOR_DECIMALS,
  capRows,
  loadMemory,
  mergeRows,
  saveMemory,
} from "./requirementMemoryStore.ts";
import type { RememberedRequirement } from "./requirementMemory.ts";
import { fingerprint } from "../router/conversability.ts";

/**
 * The store, against a real temporary directory.
 *
 * A fake filesystem would not have caught the thing this file is most about —
 * that a corrupt file must survive a failed load — because the interesting
 * behaviour is what is left on disk afterwards.
 */

const BASE = "https://example.invalid/v1";
const OTHER_BASE = "https://elsewhere.invalid/v1";

let dir: string;
const made: string[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "reqmem-"));
  made.push(dir);
});

after(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const path = (): string => join(dir, "memory.json");

const row = (over: Partial<RememberedRequirement> & { id: string }): RememberedRequirement => ({
  turnId: "t1",
  sourceText: "시스템 아키텍처를 분석해",
  proposedBy: "llama-3.3-70b",
  budget: 6000,
  outcome: "accepted",
  at: 1000,
  ...over,
});

describe("loadMemory", () => {
  it("파일이 없으면 빈 기억이다 — 오류가 아니라 첫 실행이다", async () => {
    const got = await loadMemory({ path: path(), baseUrl: BASE });
    assert.equal(got.kind, "empty");
  });

  it("JSON 이 아니면 거부하고 파일은 그대로 둔다", async () => {
    await writeFile(path(), "이건 JSON 이 아니다", "utf8");
    const got = await loadMemory({ path: path(), baseUrl: BASE });
    assert.equal(got.kind, "refused");
    assert.equal(
      await readFile(path(), "utf8"),
      "이건 JSON 이 아니다",
      "거부는 초기화가 아니다 — 유일한 사본을 지우면 안 된다",
    );
  });

  it("파일 자체를 못 읽으면 거부한다 — '없음' 과 '못 읽음' 은 다르다", async () => {
    // 앞의 시험들은 전부 '파일은 열리는데 내용이 이상한' 경우다. readFile 이
    // 직접 던지는 경로는 그것들이 밟지 않아서, ENOENT 검사를 통째로 지우고
    // 언제나 빈 기억을 돌려주는 변이가 물리지 않았다. 디렉터리를 가리키면
    // EISDIR 로 던진다.
    const asDirectory = join(dir, "디렉터리인경로");
    await mkdir(asDirectory, { recursive: true });
    const got = await loadMemory({ path: asDirectory, baseUrl: BASE });
    assert.equal(got.kind, "refused", "못 읽은 것을 첫 실행으로 착각하면 기억이 조용히 사라진다");
  });

  it("최상위가 배열이면 거부한다 — 객체가 아닌 것도 JSON 이다", async () => {
    // 자동 변이 감사가 찾았다. `typeof parsed !== "object" || parsed === null`
    // 을 `&&` 로 바꿔도 통과했는데, JSON 이면서 객체가 아닌 입력을 아무 시험도
    // 주지 않았기 때문이다. 배열은 typeof 가 "object" 라 앞 조건만으로는 안 걸린다.
    await writeFile(path(), "[]", "utf8");
    assert.equal((await loadMemory({ path: path(), baseUrl: BASE })).kind, "refused");
  });

  it("시각이 숫자가 아닌 행을 거부한다", async () => {
    const file = {
      format: MEMORY_FORMAT,
      baseUrlFingerprint: fingerprint(BASE),
      savedAt: "",
      rows: [{ ...row({ id: "a" }), at: "어제" }],
    };
    await writeFile(path(), JSON.stringify(file), "utf8");
    assert.equal((await loadMemory({ path: path(), baseUrl: BASE })).kind, "refused");
  });

  it("최상위가 null 이면 거부한다", async () => {
    await writeFile(path(), "null", "utf8");
    assert.equal((await loadMemory({ path: path(), baseUrl: BASE })).kind, "refused");
  });

  it("형식 문자열이 다르면 거부한다", async () => {
    await writeFile(path(), JSON.stringify({ format: "옛날형식", rows: [] }), "utf8");
    const got = await loadMemory({ path: path(), baseUrl: BASE });
    assert.equal(got.kind, "refused");
    assert.match(got.kind === "refused" ? got.reason : "", /형식/);
  });

  it("다른 게이트웨이에서 모은 기억은 거부한다", async () => {
    await saveMemory({ path: path(), baseUrl: OTHER_BASE, rows: [row({ id: "a" })], now: () => 0 });
    const got = await loadMemory({ path: path(), baseUrl: BASE });
    assert.equal(got.kind, "refused");
    assert.match(got.kind === "refused" ? got.reason : "", /다른 게이트웨이/);
  });

  it("행 하나라도 형식에 안 맞으면 통째로 거부한다", async () => {
    // 일부만 걸러 조용히 쓰면, 남은 것이 온전하다는 잘못된 인상을 준다.
    await saveMemory({ path: path(), baseUrl: BASE, rows: [row({ id: "a" })], now: () => 0 });
    const file = JSON.parse(await readFile(path(), "utf8"));
    file.rows.push({ id: "깨진행" });
    await writeFile(path(), JSON.stringify(file), "utf8");
    const got = await loadMemory({ path: path(), baseUrl: BASE });
    assert.equal(got.kind, "refused");
    assert.match(got.kind === "refused" ? got.reason : "", /1개 행/);
  });

  it("벡터만 있고 공간이 없는 행은 형식 위반이다", async () => {
    const file = {
      format: MEMORY_FORMAT,
      // 실제 지문이어야 한다. 아무 값이나 넣으면 게이트웨이 불일치로 먼저
      // 거부돼서, 이 시험이 재려던 행 검사에는 닿지도 않는다 — 변이가 그 사실을
      // 잡아냈다.
      baseUrlFingerprint: fingerprint(BASE),
      savedAt: "",
      rows: [{ ...row({ id: "a" }), vector: [1, 0] }],
    };
    await writeFile(path(), JSON.stringify(file), "utf8");
    const got = await loadMemory({ path: path(), baseUrl: BASE });
    assert.equal(got.kind, "refused", "비교할 수 없는 벡터는 담긴 적이 없어야 한다");
  });

  it("공간만 있고 벡터가 없는 행도 형식 위반이다", async () => {
    // 위 시험의 반대 방향이고, 위 것만으로는 짝 검사가 검사되지 않았다 —
    // 벡터가 있는 쪽은 안쪽의 space 타입 검사에도 걸려서, 짝 검사를 통째로
    // 지워도 여전히 거부됐다. 아무것도 가리키지 않는 공간은 이쪽에서만 걸린다.
    const { spaceKey } = await import("../router/embedding.ts");
    const file = {
      format: MEMORY_FORMAT,
      // 실제 지문이어야 한다. 아무 값이나 넣으면 게이트웨이 불일치로 먼저
      // 거부돼서, 이 시험이 재려던 행 검사에는 닿지도 않는다 — 변이가 그 사실을
      // 잡아냈다.
      baseUrlFingerprint: fingerprint(BASE),
      savedAt: "",
      rows: [
        {
          ...row({ id: "a" }),
          space: spaceKey({ provider: "hasa", modelId: "bge-m3", dimension: 3 }),
        },
      ],
    };
    await writeFile(path(), JSON.stringify(file), "utf8");
    const got = await loadMemory({ path: path(), baseUrl: BASE });
    assert.equal(got.kind, "refused");
  });

  it("쓴 것을 그대로 읽는다", async () => {
    const rows = [row({ id: "a" }), row({ id: "b", outcome: "superseded" })];
    await saveMemory({ path: path(), baseUrl: BASE, rows, now: () => 0 });
    const got = await loadMemory({ path: path(), baseUrl: BASE });
    assert.equal(got.kind, "loaded");
    assert.deepEqual(
      got.kind === "loaded" ? got.rows.map((r) => r.id).sort() : [],
      ["a", "b"],
    );
  });
});

describe("saveMemory", () => {
  it("읽지 못한 파일 위에는 쓰지 않는다", async () => {
    await writeFile(path(), "망가진 파일", "utf8");
    const got = await saveMemory({ path: path(), baseUrl: BASE, rows: [row({ id: "a" })], now: () => 0 });
    assert.ok("refused" in got);
    assert.equal(
      await readFile(path(), "utf8"),
      "망가진 파일",
      "망가진 파일을 새 파일로 덮는 것이 바로 이 모듈이 막으려는 조용한 초기화다",
    );
  });

  it("디렉터리가 없으면 만든다", async () => {
    const nested = join(dir, "깊은", "곳", "memory.json");
    const got = await saveMemory({ path: nested, baseUrl: BASE, rows: [row({ id: "a" })], now: () => 0 });
    assert.ok(!("refused" in got));
    assert.equal((await loadMemory({ path: nested, baseUrl: BASE })).kind, "loaded");
  });

  it("두 번 저장하면 합쳐진다 — 덮어쓰지 않는다", async () => {
    await saveMemory({ path: path(), baseUrl: BASE, rows: [row({ id: "a" })], now: () => 0 });
    await saveMemory({ path: path(), baseUrl: BASE, rows: [row({ id: "b" })], now: () => 1 });
    const got = await loadMemory({ path: path(), baseUrl: BASE });
    assert.equal(got.kind === "loaded" ? got.rows.length : 0, 2);
  });

  it("URL 을 파일에 적지 않는다", async () => {
    await saveMemory({ path: path(), baseUrl: BASE, rows: [row({ id: "a" })], now: () => 0 });
    const text = await readFile(path(), "utf8");
    assert.equal(text.includes("example.invalid"), false, "지문만 적는다");
  });

  it("벡터를 정해진 자리수로 줄여 적는다", async () => {
    const long = [0.123456789012345, 0.987654321098765];
    await saveMemory({
      path: path(),
      baseUrl: BASE,
      rows: [row({ id: "a", vector: long, space: "sp" })],
      now: () => 0,
    });
    const file = JSON.parse(await readFile(path(), "utf8"));
    const stored = file.rows[0].vector as number[];
    for (const value of stored) {
      const digits = String(value).split(".")[1] ?? "";
      assert.ok(digits.length <= VECTOR_DECIMALS, `${value} 의 소수 자리가 너무 길다`);
    }
    assert.ok(Math.abs((stored[0] ?? 0) - (long[0] ?? 0)) < 1e-6, "줄여도 값은 거의 같아야 한다");
  });

  it("몇 개를 쓰고 몇 개를 버렸는지 알려준다", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ id: `r${i}`, at: i }));
    const got = await saveMemory({ path: path(), baseUrl: BASE, rows, now: () => 0, maxRows: 3 });
    assert.deepEqual(got, { written: 3, dropped: 2 });
  });
});

describe("mergeRows — 두 번째 목격이 정정을 세탁하지 못한다", () => {
  it("같은 아이디는 하나로 합쳐진다", () => {
    const merged = mergeRows([row({ id: "a" })], [row({ id: "a", sourceText: "고쳐 쓴 말" })]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.sourceText, "고쳐 쓴 말", "새 내용이 이긴다");
  });

  it("정정된 행을 나중에 accepted 로 다시 봐도 정정으로 남는다", () => {
    const merged = mergeRows(
      [row({ id: "a", outcome: "superseded" })],
      [row({ id: "a", outcome: "accepted" })],
    );
    assert.equal(merged[0]?.outcome, "superseded");
  });

  it("accepted 였던 것이 정정되면 정정으로 바뀐다", () => {
    const merged = mergeRows(
      [row({ id: "a", outcome: "accepted" })],
      [row({ id: "a", outcome: "superseded" })],
    );
    assert.equal(merged[0]?.outcome, "superseded");
  });

  it("처음 본 시각을 지킨다", () => {
    const merged = mergeRows([row({ id: "a", at: 100 })], [row({ id: "a", at: 900 })]);
    assert.equal(merged[0]?.at, 100, "나이는 처음 본 때다 — 다시 봤다고 젊어지지 않는다");
  });

  it("새 아이디는 그냥 더해진다", () => {
    const merged = mergeRows([row({ id: "a" })], [row({ id: "b" })]);
    assert.deepEqual(merged.map((r) => r.id).sort(), ["a", "b"]);
  });
});

describe("capRows — 잊더라도 신호부터 잊지는 않는다", () => {
  it("한도 안이면 아무것도 버리지 않는다", () => {
    const rows = [row({ id: "a" }), row({ id: "b" })];
    assert.equal(capRows(rows, 5).length, 2);
  });

  it("정정된 행이 받아들여진 행보다 오래돼도 살아남는다", () => {
    const rows = [
      row({ id: "오래된정정", outcome: "superseded", at: 1 }),
      row({ id: "새로운수용", outcome: "accepted", at: 100 }),
    ];
    assert.deepEqual(capRows(rows, 1).map((r) => r.id), ["오래된정정"]);
  });

  it("거부도 수용보다 먼저 지킨다", () => {
    const rows = [
      row({ id: "거부", outcome: "rejected", at: 1 }),
      row({ id: "수용", outcome: "accepted", at: 100 }),
    ];
    assert.deepEqual(capRows(rows, 1).map((r) => r.id), ["거부"]);
  });

  it("같은 등급이면 최근 것을 지킨다", () => {
    const rows = [row({ id: "옛것", at: 1 }), row({ id: "새것", at: 100 })];
    assert.deepEqual(capRows(rows, 1).map((r) => r.id), ["새것"]);
  });

  it("결과 없는 행이 가장 먼저 버려진다", () => {
    const rows = [
      row({ id: "모름", outcome: "unconfirmed", at: 900 }),
      row({ id: "수용", outcome: "accepted", at: 1 }),
    ];
    assert.deepEqual(capRows(rows, 1).map((r) => r.id), ["수용"]);
  });

  it("준 순서를 지켜서 돌려준다", () => {
    const rows = [row({ id: "b", at: 2 }), row({ id: "a", at: 3 }), row({ id: "c", at: 1 })];
    assert.deepEqual(capRows(rows, 2).map((r) => r.id), ["b", "a"]);
  });

  it("한도가 0 이면 전부 버린다", () => {
    assert.equal(capRows([row({ id: "a" })], 0).length, 0);
  });

  it("행 수가 한도와 정확히 같으면 아무것도 버리지 않는다", () => {
    // `rows.length <= maxRows` 를 `<` 로 바꿔도 통과했다 — 딱 맞는 경우를
    // 아무 시험도 주지 않아서, 한도에 정확히 찬 기억이 조용히 잘려도 몰랐다.
    const rows = [row({ id: "a", at: 1 }), row({ id: "b", at: 2 })];
    assert.deepEqual(capRows(rows, 2).map((r) => r.id), ["a", "b"]);
  });

  it("같은 등급·같은 나이면 아이디순으로 갈라 결과가 흔들리지 않는다", () => {
    // 정렬의 마지막 갈래(`|| a.id.localeCompare(b.id)`)를 지워도 통과했다.
    // 등급도 나이도 같은 두 행이 없었기 때문이다.
    const rows = [row({ id: "b", at: 5 }), row({ id: "a", at: 5 })];
    assert.deepEqual(capRows(rows, 1).map((r) => r.id), ["a"]);
  });

  it("기본 한도는 양수다", () => {
    assert.ok(DEFAULT_MAX_ROWS > 0);
  });
});

describe("왕복", () => {
  it("저장하고 읽은 행으로 이웃을 찾을 수 있다", async () => {
    const { nearest } = await import("./requirementMemory.ts");
    const { spaceKey } = await import("../router/embedding.ts");
    const space = { provider: "hasa", modelId: "bge-m3", dimension: 3 };
    await saveMemory({
      path: path(),
      baseUrl: BASE,
      rows: [
        row({ id: "가까움", vector: [1, 0, 0], space: spaceKey(space) }),
        row({ id: "멂", vector: [0, 0, 1], space: spaceKey(space) }),
      ],
      now: () => 0,
    });
    const got = await loadMemory({ path: path(), baseUrl: BASE });
    assert.equal(got.kind, "loaded");
    const neighbours = nearest({
      vector: [1, 0, 0],
      space,
      rows: got.kind === "loaded" ? got.rows : [],
      k: 1,
    });
    assert.equal(neighbours[0]?.row.id, "가까움");
  });

  it("빈 디렉터리에 저장했다 읽으면 개수가 같다", async () => {
    const nested = join(dir, "새폴더");
    await mkdir(nested, { recursive: true });
    const rows = Array.from({ length: 12 }, (_, i) => row({ id: `r${i}`, at: i }));
    await saveMemory({ path: join(nested, "m.json"), baseUrl: BASE, rows, now: () => 0 });
    const got = await loadMemory({ path: join(nested, "m.json"), baseUrl: BASE });
    assert.equal(got.kind === "loaded" ? got.rows.length : 0, 12);
  });
});
