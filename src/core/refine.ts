import type { ChatMessage, RefineConfig, TaskSpec } from "../protocol/index.ts";
import type { HasaClient } from "../hasa-client/client.ts";
import { nullLogger, type Logger } from "../hasa-client/logger.ts";

/**
 * The refinement loop.
 *
 * Best-of-N picks the largest of N independent draws. That is selection, not
 * optimisation, and calling its output "the best answer" overstates what was
 * done: no alternative to the winner was ever constructed, so nothing was shown
 * to be unimprovable. This module constructs the alternatives.
 *
 * Two rules make the loop safe to run:
 *
 *   1. **The critic is not the judge.** If the model that says what to fix is
 *      also the model that scores the fix, rounds converge on that model's
 *      preferences rather than on quality — the optimiser learns the metric.
 *      `assertDistinctRoles` refuses such a run before it starts.
 *
 *   2. **The incumbent is only replaced by a win.** A neighbour must beat the
 *      current champion in a blind pairwise comparison; ties and undecidable
 *      verdicts leave the champion standing. Refinement loops routinely make
 *      things worse, and without this the run would ship the last attempt
 *      rather than the best one. With it, the output cannot be worse than the
 *      best round-0 sample, by construction.
 *
 * See docs/redesign-plan.md §2.2.
 */

export const CRITIC_SYSTEM_PROMPT = `너는 초안을 검토해 결함을 찾는 비평가다. 개선안을 쓰지 마라 — 결함만 지목한다.

규칙:
- 각 결함은 **검증 가능**해야 한다. "더 명확하게 쓰라"가 아니라 "3절의 주장에 근거가 제시되지 않았다" 수준이어야 한다.
- 사실과 다르거나, 요구사항을 빠뜨렸거나, 근거 없이 단정한 부분을 우선한다.
- 문체 취향은 결함이 아니다. 정말 고칠 것이 없으면 빈 목록을 반환하라. 억지로 채우지 마라.
- 아래 스키마의 JSON 객체 하나만 출력한다. 다른 텍스트를 덧붙이지 마라.

출력 스키마:
{"defects": ["...", "..."]}
결함은 최대 5개, 각 200자 이내.`;

export class RoleCollision extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleCollision";
  }
}

/**
 * The critic must not be the judge and must not be in the field.
 *
 * Critic-as-judge optimises the scorer. Critic-as-candidate is subtler and just
 * as bad: a model asked to fault a draft it is competing against has an
 * interest in the answer, and a model asked to fault its own draft is being
 * asked to review itself.
 */
export function assertDistinctRoles(
  criticModelId: string,
  judgeModelId: string,
  candidateModelIds: string[],
): void {
  if (criticModelId === judgeModelId) {
    throw new RoleCollision(
      `critic(${criticModelId})와 judge가 같은 모델이다 — 개선이 judge의 취향에 최적화된다`,
    );
  }
  if (candidateModelIds.includes(criticModelId)) {
    throw new RoleCollision(
      `critic(${criticModelId})이 후보에도 포함되어 있다 — 자기 답안을 비평하게 된다`,
    );
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
}

function parseDefects(raw: string): string[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const open = raw.indexOf("{");
  const close = raw.lastIndexOf("}");
  const attempts = [fenced?.[1], raw, open !== -1 && close > open ? raw.slice(open, close + 1) : undefined];
  for (const attempt of attempts) {
    if (attempt === undefined) continue;
    try {
      const parsed: unknown = JSON.parse(attempt.trim());
      if (parsed === null || typeof parsed !== "object") continue;
      const defects = (parsed as { defects?: unknown }).defects;
      if (!Array.isArray(defects)) continue;
      return defects
        .filter((d): d is string => typeof d === "string" && d.trim().length > 0)
        .slice(0, 5)
        .map((d) => (d.length > 200 ? `${d.slice(0, 199)}…` : d));
    } catch {
      continue;
    }
  }
  return null;
}

export interface CritiqueOptions {
  logger?: Logger;
  signal?: AbortSignal;
  dispatch?: <T>(modelId: string, fn: () => Promise<T>) => Promise<T>;
}

export interface CritiqueResult {
  defects: string[];
  /** True when the critic could not be read; the caller must not treat that as "no defects". */
  failed: boolean;
}

/**
 * Asks the critic what is wrong with the incumbent.
 *
 * An empty list is a real answer — it means the critic found nothing worth
 * fixing, which is a reason to stop. A critic that could not be parsed is not
 * the same thing, and is reported separately so that a broken critic never
 * masquerades as a converged one.
 */
export async function critique(
  client: HasaClient,
  config: RefineConfig,
  taskSpec: TaskSpec,
  draft: string,
  opts: CritiqueOptions = {},
): Promise<CritiqueResult> {
  const log = opts.logger ?? nullLogger;
  const messages: ChatMessage[] = [
    { role: "system", content: CRITIC_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        "## 과제",
        taskSpec.prompt,
        "",
        "## 초안",
        "<<<DRAFT>>>",
        draft,
        "<<<END_DRAFT>>>",
        "",
        "위 초안의 검증 가능한 결함만 JSON 으로 출력하라.",
      ].join("\n"),
    },
  ];

  const dispatch = opts.dispatch ?? (<T,>(_model: string, fn: () => Promise<T>) => fn());
  const response = await dispatch(config.criticModelId, () =>
    client.chat(
      {
        model: config.criticModelId,
        messages,
        temperature: config.temperature,
        max_tokens: config.maxOutputTokens,
      },
      opts.signal ? { signal: opts.signal } : {},
    ),
  );

  const defects = parseDefects(textOf(response.choices[0]?.message?.content));
  if (defects === null) {
    log.warn("critic output could not be parsed; treating the round as unproductive", {
      model: config.criticModelId,
    });
    return { defects: [], failed: true };
  }
  return { defects, failed: false };
}

/**
 * The neighbour's prompt: the original task, the previous attempt, and what to
 * fix. The task is restated in full rather than referenced, so the neighbour is
 * answering the same question and not merely editing text.
 */
export function neighbourMessages(taskSpec: TaskSpec, draft: string, defects: string[]): ChatMessage[] {
  const user = [
    taskSpec.prompt,
    "",
    "## 이전 답안",
    draft,
    "",
    "## 검토에서 지적된 결함",
    ...defects.map((d, i) => `${i + 1}. ${d}`),
    "",
    "위 결함을 고쳐 과제에 대한 답을 다시 작성하라. 지적되지 않은 부분까지 바꾸지 마라. 답만 출력하고 수정 내역을 설명하지 마라.",
  ].join("\n");

  return [
    ...(taskSpec.systemPrompt ? [{ role: "system" as const, content: taskSpec.systemPrompt }] : []),
    { role: "user" as const, content: user },
  ];
}

/** Why a candidate's refinement stopped. Each value is a distinct, checkable state. */
export type ConvergenceReason =
  | "no_defects_found"
  | "neighbour_not_better"
  | "round_budget"
  | "critic_unavailable"
  | "neighbour_failed";

export interface RoundRecord {
  round: number;
  neighbourLabel: string;
  defects: string[];
  /** True when the neighbour beat the incumbent and replaced it. */
  replaced: boolean;
  detail: string;
}
