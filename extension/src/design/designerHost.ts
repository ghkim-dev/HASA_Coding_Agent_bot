import * as vscode from "vscode";
import { designHarness, describeDesign, type HarnessDesign } from "../../../src/design/harnessDesign.ts";
import { buildRegistry } from "../../../src/router/modelRegistry.ts";
import type { ModelProfile } from "../../../src/router/modelProfile.ts";
import { DesignerPanel, type DesignerMessage } from "./designerPanel.ts";

/**
 * The designer, wired to a window.
 *
 * Holds no session, no conversation and no checkpoint: a design is a pure
 * function of one request and the model list, so there is nothing to keep
 * between two of them. The only state here is the panel.
 *
 * The model list is the one thing that needs the gateway, and it is optional by
 * construction. Without a key the designer still reads the request, still shows
 * what the work demands, and says plainly that it has nothing to rank — which
 * is a different sentence from "no model is suitable", and the panel prints the
 * one that is true.
 */

/** What the panel is given. Flat on purpose — the webview decides no policy. */
interface DesignPayload {
  summary: string;
  requirements: Array<{
    text: string;
    grounded: boolean;
    baseline: boolean;
    forbidden: boolean;
  }>;
  confidence: HarnessDesign["confidence"];
  demands: Record<string, number>;
  intents: string[];
  prohibitions: string[];
  understood: boolean;
  recommendation: {
    selected: {
      modelId: string;
      score: number;
      /** The four terms, so a user can see which one carried the pick. */
      breakdown: Record<string, number>;
      /** How much of what this task needs was ever measured on this model. */
      confidence: { known: number; total: number; coldStart: boolean };
    } | null;
    alternatives: Array<{ modelId: string; score: number; coldStart: boolean }>;
    /** Kept with their codes: "good at what you need" and "bad at it" are different. */
    reasons: Array<{ code: string; detail: string }>;
    /** The human sentence, not only the enum. */
    filteredOut: Array<{ modelId: string; code: string; detail: string }>;
    /** How many were dropped in total, when the list above is truncated. */
    filteredOutTotal: number;
    /** Candidates the score cannot separate from the winner. */
    tiedWith: string[];
    unavailableReason?: string;
  } | null;
  questions: Array<{ about: string; options: string[] }>;
}

export interface DesignerHostOptions {
  extensionUri: vscode.Uri;
  /**
   * The models to rank, when a gateway is reachable.
   *
   * Supplied as a callback rather than a list so the panel can be opened before
   * a key exists, and so a later design picks up a key added in between. Returns
   * null when there is no list — never an empty array standing in for one.
   */
  models: () => Promise<readonly ModelProfile[] | null>;
  log?: (line: string) => void;
}

export class DesignerHost {
  private readonly opts: DesignerHostOptions;
  private panel: DesignerPanel | null = null;
  /** The design in flight, so a second request supersedes the first. */
  private running: AbortController | null = null;

  constructor(opts: DesignerHostOptions) {
    this.opts = opts;
  }

  /** Opens the designer, or reveals the one already open. */
  open(): void {
    this.panel = DesignerPanel.show(this.opts.extensionUri, (m) => void this.handle(m));
    void this.announceModels();
  }

  dispose(): void {
    this.running?.abort();
    this.panel?.dispose();
    this.panel = null;
  }

  private async announceModels(): Promise<void> {
    const models = await this.opts.models().catch(() => null);
    this.panel?.post(
      models === null || models.length === 0
        ? {
            type: "models",
            count: 0,
            source: "none",
            detail:
              "모델 목록이 없어 추천은 건너뜁니다. 요구사항 분석은 그대로 동작합니다. " +
              "API Key를 설정하면 실제 모델을 대상으로 비교합니다.",
          }
        : { type: "models", count: models.length, source: "gateway", detail: "" },
    );
  }

  private async handle(message: DesignerMessage): Promise<void> {
    if (message.type === "cancel") {
      this.running?.abort();
      return;
    }
    if (message.type === "openSettings") {
      await vscode.commands.executeCommand("hasa.setApiKey");
      void this.announceModels();
      return;
    }
    if (message.type !== "design") return;

    // A second request supersedes the first rather than queueing behind it.
    this.running?.abort();
    const controller = new AbortController();
    this.running = controller;
    this.panel?.post({ type: "designing" });

    try {
      const models = await this.opts.models().catch(() => null);
      if (controller.signal.aborted) return;
      const design = await designHarness({
        text: message.text,
        ...(models === null || models.length === 0 ? {} : { models }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      this.opts.log?.(`[hasa] designed: ${describeDesign(design)}`);
      this.panel?.post({ type: "design", design: toPayload(design) });
    } catch (err) {
      if (controller.signal.aborted) return;
      const detail = err instanceof Error ? err.message : String(err);
      this.opts.log?.(`[hasa] design failed: ${detail}`);
      this.panel?.post({
        type: "error",
        message: `요구사항을 읽지 못했습니다: ${detail}`,
      });
    } finally {
      if (this.running === controller) this.running = null;
    }
  }
}

/**
 * Flattens a design for the webview.
 *
 * Every judgement is made here, where it can be tested, and none in the view.
 * A `RequirementSpec` carries more than a panel should have to interpret —
 * `span`, `status`, `polarity`, `provenance` — and the three booleans below are
 * the whole of what the layout depends on.
 */
function toPayload(design: HarnessDesign): DesignPayload {
  const rec = design.recommendation;
  return {
    summary: describeDesign(design),
    understood: design.understood,
    requirements: design.requirements.map((r) => ({
      text: r.text,
      // The runtime can point at the words this came from.
      grounded: r.span !== undefined,
      // The harness's own rule, not something the user said.
      baseline: r.status === "system_added",
      forbidden: r.polarity === "forbidden",
    })),
    confidence: design.confidence,
    demands: Object.fromEntries(
      Object.entries(design.profile.demands).filter(([, v]) => typeof v === "number"),
    ) as Record<string, number>,
    intents: design.intents,
    prohibitions: design.prohibitions.map((c) => c.kind),
    recommendation:
      rec === null
        ? null
        : {
            selected:
              rec.selected === null
                ? null
                : {
                    modelId: rec.selected.modelId,
                    score: rec.selected.score,
                    // The breakdown is the whole reason a score is trustworthy,
                    // and it was computed and then dropped here — leaving a
                    // number on screen with nothing behind it.
                    breakdown: { ...rec.selected.breakdown },
                    confidence: {
                      known: rec.selected.confidence.known,
                      total: rec.selected.confidence.total,
                      coldStart: rec.selected.confidence.coldStart,
                    },
                  },
            alternatives: rec.alternatives.slice(0, 4).map((a) => ({
              modelId: a.modelId,
              score: a.score,
              coldStart: a.confidence.coldStart,
            })),
            // Code *and* sentence. Rendering only the detail lost the
            // difference between "strong at what you need" and "weak at it";
            // rendering only the code showed the user an enum.
            reasons: rec.reasons.map((r) => ({ code: r.code, detail: r.detail })),
            filteredOut: rec.filteredOut.slice(0, 6).map((f) => ({
              modelId: f.modelId,
              code: f.code,
              detail: f.detail,
            })),
            filteredOutTotal: rec.filteredOut.length,
            tiedWith: rec.tiedWith ?? [],
            ...(rec.unavailableReason === undefined
              ? {}
              : { unavailableReason: rec.unavailableReason }),
          },
    questions: design.questions.map((q) => ({ about: q.about, options: q.options })),
  };
}

/**
 * Builds model profiles from a gateway listing.
 *
 * Separate from the host so a caller without a listing — a test, a first run
 * before any key exists — supplies null and gets the offline design rather than
 * an error.
 */
export function profilesFrom(models: readonly unknown[] | null): readonly ModelProfile[] | null {
  if (models === null || models.length === 0) return null;
  return buildRegistry(models as never);
}
