import type { ModelCapabilities, ProviderModel, Tristate } from "../provider/types.ts";
import type { AgentMode } from "./types.ts";
import { modeCanWrite } from "./modes.ts";

/**
 * What "✨ Auto" means.
 *
 * The product's promise is that a user enters one API key and starts working.
 * That only holds if something picks the model for them, and picking it badly
 * is worse than asking: a model without tool calling will accept a CODE request
 * and then talk about the change instead of making it, which looks like the
 * agent being broken.
 *
 * So the rule is the same as everywhere else in this codebase — decide from
 * what was measured, never from what a name suggests — with one addition: an
 * unmeasured model is a *candidate*, not a disqualification, because a fresh
 * install has measured nothing at all.
 *
 * See §24 of the product brief.
 */

export type ModelConfidence =
  /** Its capabilities were probed. */
  | "measured"
  /** Nothing is known about it; it is a guess that has not been ruled out. */
  | "unverified";

export interface AutoModelChoice {
  modelId: string;
  confidence: ModelConfidence;
  /**
   * How this model will be asked to call tools.
   *
   * `text` is not a lesser model — it is a model whose *deployment* refuses
   * tool calls. `qwen2.5-coder-32b` is the strongest coding model on the
   * measured key and its gateway was started without `--tool-call-parser`.
   */
  toolProtocol: "native" | "text";
  /** One sentence, in the user's language, for the model picker's subtitle. */
  reason: string;
}

/** What a mode needs of a model before it can be used for that mode at all. */
export function requirementFor(mode: AgentMode): "coding" | "chat" {
  // Writing means calling tools. A model that cannot will narrate the change it
  // would have made, which reads to the user as the agent quietly failing.
  return modeCanWrite(mode) ? "coding" : "chat";
}

function stateFor(capabilities: ModelCapabilities, requirement: "coding" | "chat"): Tristate {
  return requirement === "coding" ? capabilities.coding : capabilities.chat;
}

/**
 * Whether a model can drive the loop at all, and how.
 *
 * A model that chats can be given tools in the prompt and have its calls read
 * back out of the text, so "cannot call tools" stops meaning "cannot code".
 * What still rules a model out is being unable to hold a conversation — an
 * embedding model has nothing to talk to.
 */
export function protocolFor(capabilities: ModelCapabilities): "native" | "text" | null {
  if (capabilities.coding === true) return "native";
  if (capabilities.chat === false) return null;
  return "text";
}

/**
 * Ranks a catalogue for a mode. Best first; models ruled out are absent.
 *
 * Ordering, in priority order:
 *   1. measured capable, before anything unmeasured
 *   2. larger measured output ceiling — a 4096-token cap truncates real edits
 *   3. the gateway's own order, which is at least stable
 *
 * A model measured as *incapable* is dropped rather than ranked last: offering
 * it would mean offering something known not to work.
 */
export function rankModels(models: readonly ProviderModel[], mode: AgentMode): ProviderModel[] {
  const requirement = requirementFor(mode);
  const position = new Map(models.map((m, i) => [m.id, i]));

  return models
    .filter((model) =>
      // Native tool calling is preferred, never required: a model whose
      // deployment blocks it is still driven through the text protocol. Only a
      // model that cannot chat is out, because there is nothing to talk to.
      requirement === "chat"
        ? model.capabilities.chat !== false
        : protocolFor(model.capabilities) !== null,
    )
    .sort((a, b) => {
      const rank = (m: ProviderModel): number => (stateFor(m.capabilities, requirement) === true ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      const ceiling = (m: ProviderModel): number => m.limits.maxOutputTokens ?? 0;
      if (ceiling(a) !== ceiling(b)) return ceiling(b) - ceiling(a);
      return (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0);
    });
}

export interface ChooseModelOptions {
  models: readonly ProviderModel[];
  mode: AgentMode;
  /**
   * Measures one model. Called for at most `maxProbes` candidates, and only
   * when nothing in the catalogue is already known to fit.
   */
  measure?: (modelId: string) => Promise<ModelCapabilities>;
  /**
   * How many models may be measured live. Each is a real inference request
   * against shared GPUs, so this is small on purpose.
   */
  maxProbes?: number;
  /** A model the credential probe already proved callable. Tried first. */
  knownUsableModelId?: string | null;
  signal?: AbortSignal;
}

const DEFAULT_MAX_PROBES = 3;

/**
 * Picks a model, measuring a few candidates only if it has to.
 *
 * The order of preference is the honest one: something already known to fit,
 * then something we can cheaply find out about, then the best guess left. It
 * returns null rather than a bad answer — a picker showing "no usable model"
 * with a reason is better than one that silently selects a reranker.
 */
export async function chooseModel(opts: ChooseModelOptions): Promise<AutoModelChoice | null> {
  const requirement = requirementFor(opts.mode);
  const ranked = rankModels(opts.models, opts.mode);
  if (ranked.length === 0) return null;

  const alreadyFits = ranked.find((m) => stateFor(m.capabilities, requirement) === true);
  if (alreadyFits !== undefined) {
    return decided(alreadyFits.id, "measured", requirement, "native");
  }

  // A model measured as chatting but not calling tools is a settled answer, not
  // an open question: the text protocol works and there is nothing left to
  // probe. Reaching for it before spending requests is the point.
  if (requirement === "coding") {
    const viaText = ranked.find(
      (m) => m.capabilities.chat === true && m.capabilities.toolCalling === false,
    );
    if (viaText !== undefined) return decided(viaText.id, "measured", requirement, "text");
  }

  if (opts.measure !== undefined) {
    // A model the credential check already called successfully is the cheapest
    // thing to measure: we know the key can reach it.
    const preferred = opts.knownUsableModelId ?? null;
    const order =
      preferred === null
        ? ranked
        : [...ranked].sort((a, b) => (a.id === preferred ? -1 : b.id === preferred ? 1 : 0));

    const budget = opts.maxProbes ?? DEFAULT_MAX_PROBES;
    for (const model of order.slice(0, budget)) {
      if (opts.signal?.aborted === true) break;
      let capabilities: ModelCapabilities;
      try {
        capabilities = await opts.measure(model.id);
      } catch {
        // A model that cannot be measured is not a model that failed; the next
        // candidate may answer.
        continue;
      }
      if (stateFor(capabilities, requirement) === true) {
        return decided(model.id, "measured", requirement, "native");
      }
      if (requirement === "coding" && capabilities.chat === true && capabilities.toolCalling === false) {
        return decided(model.id, "measured", requirement, "text");
      }
    }
  }

  // Nothing proved out. The best-ranked survivor is still the best guess, and
  // saying so is more useful than refusing to start.
  const fallback = ranked[0];
  if (fallback === undefined) return null;
  return decided(
    fallback.id,
    "unverified",
    requirement,
    protocolFor(fallback.capabilities) ?? "text",
  );
}

function decided(
  modelId: string,
  confidence: ModelConfidence,
  requirement: "coding" | "chat",
  toolProtocol: "native" | "text",
): AutoModelChoice {
  return { modelId, confidence, toolProtocol, reason: reasonFor(requirement, confidence, toolProtocol) };
}

function reasonFor(
  requirement: "coding" | "chat",
  confidence: ModelConfidence,
  toolProtocol: "native" | "text",
): string {
  if (confidence === "unverified") {
    return requirement === "coding"
      ? "아직 확인되지 않은 모델입니다. 코드 수정이 예상대로 되지 않으면 다른 모델을 선택해 주세요."
      : "아직 확인되지 않은 모델입니다.";
  }
  if (requirement !== "coding") return "질문에 답할 수 있는 것으로 확인된 모델입니다.";
  // The distinction is worth surfacing: the text path is slightly slower and
  // occasionally needs a second attempt, and a user who sees that once
  // understands it rather than wondering.
  return toolProtocol === "native"
    ? "코드를 직접 수정할 수 있는 것으로 확인된 모델입니다."
    : "코드를 수정할 수 있습니다. 이 모델은 서버 설정상 도구 호출이 막혀 있어 호환 방식으로 동작합니다.";
}
