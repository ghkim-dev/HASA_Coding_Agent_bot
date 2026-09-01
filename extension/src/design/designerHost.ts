import * as vscode from "vscode";
import { designHarness, describeDesign, type HarnessDesign } from "../../../src/design/harnessDesign.ts";
import { handoffFor } from "../../../src/design/harnessHandoff.ts";
// The panel payload is decided in `src/design/` so it can be loaded by the
// test runner. Every judgement in it — grounded, baseline, forbidden, how many
// models were really dropped — used to live here, where nothing could reach it.
import { toPayload } from "../../../src/design/designerPayload.ts";
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
  /**
   * Opens the coding agent on a request, with a model already chosen.
   *
   * Injected rather than reached for, so this module keeps knowing nothing
   * about the agent beyond "there is one and it can be started".
   */
  startAgent?: (seed: { prompt: string; modelId: string | null }) => Promise<void>;
  log?: (line: string) => void;
}

export class DesignerHost {
  private readonly opts: DesignerHostOptions;
  private panel: DesignerPanel | null = null;
  /** The design in flight, so a second request supersedes the first. */
  private running: AbortController | null = null;
  /**
   * The design on screen and the words it was read from.
   *
   * Both, together, because a handoff needs the text the user typed and the
   * design's one conclusion that is not in that text. Cleared when a new design
   * starts, so a handoff can never carry the previous request's answer.
   */
  private shown: { design: HarnessDesign; text: string } | null = null;

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
    if (message.type === "handoff") {
      await this.handoff();
      return;
    }
    if (message.type !== "design") return;

    // A second request supersedes the first rather than queueing behind it.
    this.running?.abort();
    const controller = new AbortController();
    this.running = controller;
    // Dropped before the new one starts, not after it finishes. A design that
    // is cancelled or fails would otherwise leave the previous one on offer
    // under a screen showing something else.
    this.shown = null;
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
      this.shown = { design, text: message.text };
      this.panel?.post({ type: "design", design: toPayload(design, message.text) });
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

  /**
   * Hands the design on screen to the coding agent.
   *
   * Asks first when the design left something open. `handoffFor` decides what
   * counts as open and this decides nothing — the list it shows is the design's
   * own account of what it could not settle, so a person is choosing to skip
   * something the runtime named rather than something a dialog invented.
   *
   * Nothing runs at the end of this. The agent opens with the request in its
   * composer and the recommended model selected, and the send button is still
   * the user's.
   */
  private async handoff(): Promise<void> {
    const start = this.opts.startAgent;
    if (start === undefined || this.shown === null) return;

    const handoff = handoffFor(this.shown.design, this.shown.text);
    if (handoff.blockers.length > 0) {
      const answer = await vscode.window.showWarningMessage(
        "설계에 아직 정해지지 않은 것이 있습니다. 그대로 넘길까요?",
        { modal: true, detail: handoff.blockers.join("\n") },
        "그대로 넘기기",
      );
      if (answer !== "그대로 넘기기") return;
    }

    this.opts.log?.(`[hasa] handoff: ${handoff.why}`);
    await start({ prompt: handoff.prompt, modelId: handoff.modelId });
  }
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
