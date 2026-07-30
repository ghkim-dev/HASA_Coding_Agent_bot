import type { Check, CheckResult } from "../protocol/index.ts";

/**
 * Objective checks for response mode — the S0 rung of the decision ladder.
 *
 * Everything here is a pure function of (response text, declared check). No
 * network, no filesystem, no model. That is the point: a rung that depends on a
 * language model cannot corroborate a language model's verdict, and response
 * mode's whole problem was having nothing but the judge to go on.
 *
 * Failing a check does not eliminate a candidate. The checks a user can write
 * are cheap and blunt — `must_include` cannot tell a mention from an argument —
 * so treating one as disqualifying would hand the run to whoever guessed the
 * phrasing, not to whoever answered better. They contribute a count, and a
 * count only settles a pair when the two differ.
 *
 * See docs/evaluation-protocol.md §3.3.
 */

const FENCE = /```(?:[a-z]*)\s*([\s\S]*?)```/i;

function words(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function jsonParses(text: string): boolean {
  const fenced = FENCE.exec(text);
  for (const candidate of [fenced?.[1], text]) {
    if (candidate === undefined) continue;
    try {
      JSON.parse(candidate.trim());
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

function evaluate(text: string, check: Check): { passed: boolean; detail: string } {
  switch (check.kind) {
    case "must_include": {
      const haystack = text.toLowerCase();
      const missing = check.items.filter((item) => !haystack.includes(item.toLowerCase()));
      return {
        passed: missing.length === 0,
        detail: missing.length === 0 ? `${check.items.length}개 항목 모두 언급` : `누락: ${missing.join(", ")}`,
      };
    }
    case "must_not": {
      const haystack = text.toLowerCase();
      const present = check.items.filter((item) => haystack.includes(item.toLowerCase()));
      return {
        passed: present.length === 0,
        detail: present.length === 0 ? "금지 항목 없음" : `포함됨: ${present.join(", ")}`,
      };
    }
    case "json_parses": {
      const passed = jsonParses(text);
      return { passed, detail: passed ? "JSON 파싱 성공" : "JSON 으로 파싱되지 않음" };
    }
    case "max_words": {
      const count = words(text);
      return { passed: count <= check.limit, detail: `${count} 단어 (상한 ${check.limit})` };
    }
    case "min_words": {
      const count = words(text);
      return { passed: count >= check.limit, detail: `${count} 단어 (하한 ${check.limit})` };
    }
    case "regex": {
      // A user-supplied pattern that does not compile is the check's failure,
      // not the candidate's — every candidate would fail it identically, which
      // would silently remove the axis instead of reporting it broken.
      let matched: boolean;
      try {
        matched = new RegExp(check.pattern, check.flags).test(text);
      } catch (err) {
        return {
          passed: false,
          detail: `정규식이 잘못되었다: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return {
        passed: matched === check.expect,
        detail: `${check.expect ? "일치해야 함" : "일치하지 않아야 함"} — ${matched ? "일치" : "불일치"}`,
      };
    }
  }
}

export function runChecks(text: string, checks: Check[]): CheckResult[] {
  return checks.map((check, index) => {
    const { passed, detail } = evaluate(text, check);
    return { index, kind: check.kind, passed, detail };
  });
}

export function passedCount(results: CheckResult[]): number {
  return results.filter((r) => r.passed).length;
}
