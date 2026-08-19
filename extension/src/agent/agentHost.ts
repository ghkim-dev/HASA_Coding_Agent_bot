import * as vscode from "vscode";
import { AgentSession } from "../../../src/agent/session.ts";
import { createModelFor } from "../../../src/agent/hasaModel.ts";
import { chooseModel, protocolFor, type AutoModelChoice } from "../../../src/agent/autoModel.ts";
import { modeCanWrite } from "../../../src/agent/modes.ts";
import type {
  AgentEvent,
  AgentMode,
  AgentTurnResult,
  ApprovalAnswer,
  ApprovalMode,
  ApprovalRequest,
} from "../../../src/agent/types.ts";
import type { HasaProvider } from "../../../src/provider/hasa/hasaProvider.ts";
import { createHasaProvider } from "../../../src/provider/hasa/createProvider.ts";
import { describeVerification, verifyModels } from "../../../src/provider/hasa/verifyModels.ts";
import { FileModelCache } from "../../../src/provider/modelCache.ts";
import { ProviderError } from "../../../src/provider/errors.ts";
import type { ModelListing, ProviderMessage, ProviderValidation } from "../../../src/provider/types.ts";
import type { CommandSpec } from "../../../src/protocol/index.ts";
import type { RuntimeGap } from "../../../src/agent/discoverCommands.ts";
import { HasaCatalog, canConverse, offerForConversation } from "../../../src/provider/hasa/hasaCatalog.ts";
import { createMediaTransport } from "../../../src/provider/hasa/hasaMediaTransport.ts";
import { HASA_DEFAULT_BASE_URL } from "../../../src/provider/hasa/defaults.ts";
import type { AgentSessionOptions } from "../../../src/agent/session.ts";
import { discoverCommands } from "./commands.ts";
import { createConversationPort } from "./conversations.ts";
import {
  ConversationStore,
  newConversationId,
  titleFrom,
  type ConversationSummary,
  type StoredConversation,
} from "../../../src/agent/conversationStore.ts";
import type { Attachment, AttachmentOutcome } from "../../../src/agent/attachments.ts";
import type { SessionEvent } from "../../../src/agent/sessionEvents.ts";
import { completedTurn, type ConversationCheckpoint } from "../../../src/agent/conversationGraph.ts";
import { reduceTask } from "../../../src/agent/taskReducer.ts";
import { describeTask } from "../../../src/agent/taskState.ts";
import { requirementsView, type RequirementsView } from "../../../src/agent/requirementsView.ts";
import { progressView, type AgentProgress } from "../../../src/agent/progressView.ts";
import { interpretRequest, describeBootstrapFailure } from "../../../src/router/bootstrap.ts";
import { buildRegistry } from "../../../src/router/modelRegistry.ts";
import {
  previousProfileFrom,
  routeTurn as decideWorker,
  routingEvent,
  selectedWorkerFor,
  unroutedEvent,
  type WorkerDecision,
} from "../../../src/router/routing.ts";
import { emptyContract, reduceContract } from "../../../src/agent/turnContract.ts";
import { projectTaskSemanticProfile } from "../../../src/router/semanticProfile.ts";
import { ShadowRunner } from "../../../src/router/shadowRunner.ts";
import type { SemanticShadowEvaluation } from "../../../src/router/shadow.ts";
import {
  describeViolations,
  safeFallback,
  taskDisposition,
  validateFinalClaims,
} from "../../../src/agent/finalClaims.ts";
import { TurnRecorder } from "../../../src/agent/sessionRecorder.ts";
import { reduceSession } from "../../../src/agent/sessionView.ts";
import { transcribeAudio, TranscriptionUnavailable } from "../../../src/provider/hasa/hasaAudio.ts";
import type { Logger } from "../../../src/hasa-client/logger.ts";
import type { ConnectionState } from "./chatPanel.ts";
import { canonicalizeRoot } from "../../../src/agent/workspaceIdentity.ts";
import {
  describeAmbiguity,
  resolveWorkspaceContext,
  type WorkspaceContext,
} from "../../../src/agent/workspaceContext.ts";

// Re-exported: it started here, and callers outside the panel still ask the
// host for it. The shape now lives at the boundary that draws it.
export type { ConnectionState };

type MediaConfig = NonNullable<AgentSessionOptions["media"]>;

/**
 * What can be run here, and what is missing.
 *
 * Logged because a beginner who is told "Python is not installed" will
 * reasonably ask how the agent knows, and the output channel is where that
 * answer lives.
 */
async function workspaceCommands(
  root: string,
  log: vscode.OutputChannel,
): Promise<{ commands: CommandSpec[]; runtimeGaps: RuntimeGap[] }> {
  const { commands, gaps } = await discoverCommands(root);
  const names = commands.map((c) => [c.cmd, ...c.args].join(" "));
  log.appendLine(`[hasa] runnable: ${names.length > 0 ? names.join(", ") : "(none)"}`);
  for (const gap of gaps) log.appendLine(`[hasa] ${gap.language} files present, no interpreter found`);
  return { commands, runtimeGaps: gaps };
}

/**
 * Everything the agent needs, assembled once and held in the extension host.
 *
 * The key is read from `SecretStorage` here and never leaves this process. The
 * webview receives `{ hasApiKey }` and nothing else, which is the same boundary
 * the Arena already keeps — see docs/security-policy.md §1.3.
 *
 * Running in process rather than behind an orchestrator is a deliberate choice
 * and the reason is approval: the loop stops, asks, and waits. Over HTTP that
 * needs a correlation protocol with its own stuck-loop failure mode. Here it is
 * an `await` on a modal.
 */

export const HASA_SECRET_KEY = "hasaArena.apiKey";

/**
 * How long Auto may spend measuring before it stops and guesses.
 *
 * Short on purpose. Measuring a model is eleven live inference requests and
 * there are up to three candidates, so the honest worst case is tens of
 * minutes — and it is work the user did not ask for, in front of a request they
 * did. `chooseModel` already falls back to its best-ranked candidate, so the
 * cost of stopping early is an unverified pick that answers rather than a
 * measured one nobody waited for.
 */
const MODEL_CHOICE_BUDGET_MS = 45_000;

/**
 * The longest a turn may take, setup included.
 *
 * The loop already stops itself after ten minutes. Everything before it —
 * choosing a model, measuring one, reading the catalogue — sat outside that
 * ceiling, so a turn could run for as long as the slowest thing in it. One ran
 * for twenty-four minutes and was still going.
 */
const TURN_CEILING_MS = 12 * 60_000;

/**
 * The provider's log, in the window the user can actually open.
 *
 * `src/` logs through a `Logger`; the extension has an `OutputChannel`. Nothing
 * joined them, so every warning the client produced — retries, cache failures,
 * a catalogue that would not parse — was written to `nullLogger` and lost. The
 * cost of that showed up as a question nobody could answer: what was the agent
 * doing for six minutes?
 */
function outputChannelLogger(channel: vscode.OutputChannel, scope = "hasa"): Logger {
  const write = (level: string, msg: string, fields?: Record<string, unknown>): void => {
    const detail = fields === undefined ? "" : ` ${JSON.stringify(fields)}`;
    channel.appendLine(`[${scope}] ${level}: ${msg}${detail}`);
  };
  return {
    // Debug is dropped rather than written: this channel is something a user
    // reads, and per-request noise would bury the lines that matter.
    debug: () => {},
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    child: (name) => outputChannelLogger(channel, `${scope}:${name}`),
  };
}

/** Modality names as a Korean-speaking user would recognise them. */
const MODALITY_KO: Readonly<Record<string, string>> = {
  image: "이미지",
  video: "동영상",
  audio: "음성",
  embeddings: "임베딩",
  rerank: "리랭킹",
};



export class AgentHost {
  private readonly context: vscode.ExtensionContext;
  private readonly log: vscode.OutputChannel;
  private provider: HasaProvider | null = null;
  private session: AgentSession | null = null;
  private validation: ProviderValidation | null = null;
  private selectedModelId: string | null = null;
  private autoChoice: AutoModelChoice | null = null;
  /** The choice the live session was built on. Fixed until it is rebuilt. */
  private sessionChoice: AutoModelChoice | null = null;
  /** The mode the live session was built for. See `modelNeedsRevisiting`. */
  private modeAtSession: AgentMode | null = null;
  private catalog: HasaCatalog | null = null;
  /** Why the last turn could not start, when the reason is worth showing. */
  private modelProblem: string | null = null;
  private conversations: ConversationStore | null = null;
  /** The workspace the store above was built for. See `ensureConversations`. */
  private conversationsFor: string | null = null;
  /**
   * The folder this conversation settled on.
   *
   * Set on the first turn and kept, so the same relative path means the same
   * file for the whole conversation. Cleared with the conversation.
   */
  private boundRoot: string | null = null;
  /** A folder the user picked, when the window has several. */
  private chosenRoot: string | null = null;
  /** The conversation being written to, so a turn appends rather than forks. */
  private conversationId: string | null = null;
  /**
   * The conversation's semantic events, in order.
   *
   * Held alongside the model's messages rather than derived from them: a
   * `ProviderMessage` array has no room for a plan, a reasoning summary, a file
   * change or the reason a run stopped, which is exactly what reopening a
   * conversation used to lose.
   */
  private recorded: SessionEvent[] = [];
  /**
   * How the last turn ended.
   *
   * The final-claim gate needs it to tell `no_progress` from `finished`. A run
   * that stopped because nothing was changing has not completed the task, and
   * "완료했습니다" in that turn is exactly the sentence to refuse.
   */
  private lastTermination: string | undefined;
  /**
   * Events from a turn that could not be written to one.
   *
   * A turn that dies before its session exists has no delta to pair with, and a
   * turn on disk owns both halves or neither. Rather than write half a turn or
   * throw the user's own message away, its events wait here and join the next
   * turn that does land.
   */
  private pendingEvents: SessionEvent[] = [];
  /** Its other half. The two are held and released together or not at all. */
  private pendingDelta: ProviderMessage[] = [];
  /**
   * A reopened conversation's model history, waiting for a session to put it in.
   *
   * Reading your own history is a local operation — the file is on this machine
   * — but continuing it needs a model, and a model needs the gateway. Those were
   * the same step, so a gateway that was down made saved conversations
   * unopenable: the list showed them and clicking one said "대화를 열지
   * 못했습니다."
   *
   * Splitting them means the transcript is drawn from disk immediately and this
   * holds the other half until `ensureSession` has somewhere to put it. The two
   * still arrive together at the only moment it matters — before a turn runs.
   */
  private pendingRestore: ProviderMessage[] | null = null;
  /** Turn counter, so event ids are unique and ordered within a conversation. */
  private turnOrdinal = 0;
  /** Distinguishes several routing events within one turn's id space. */
  private routingOrdinal = 0;
  /**
   * Built once, not per turn.
   *
   * It holds the embedding cache, and a cache rebuilt every turn never hits —
   * which is the same as having none while looking as though it has one.
   */
  private shadowRunner: ShadowRunner | null = null;
  /** The registry the last routed turn ranked, for the shadow to read. */
  private lastRegistry: import("../../../src/router/modelProfile.ts").ModelProfile[] = [];
  private mode: AgentMode = "code";
  private running: AbortController | null = null;
  /**
   * Where to report what is happening before the loop starts.
   *
   * Set for the duration of a turn. Everything `ensureSession` does — choosing a
   * model, measuring one, reading the catalogue, discovering commands — used to
   * happen with nothing to say about it, so the panel showed "생각하는 중" and a
   * climbing clock for work the loop had not begun.
   */
  private phase: ((label: string) => void) | null = null;

  constructor(context: vscode.ExtensionContext, log: vscode.OutputChannel) {
    this.context = context;
    this.log = log;
  }

  get currentMode(): AgentMode {
    return this.mode;
  }

  setMode(mode: AgentMode): void {
    this.mode = mode;
    this.session?.setMode(mode);
    // The chosen model may not suit the new mode — ASK can use a chat-only
    // model that CODE must not.
    this.autoChoice = null;
  }

  get modelLabel(): string {
    if (this.selectedModelId !== null) return this.selectedModelId;
    // The running model wins over the next candidate. A session keeps the model
    // it opened with, so after a mode change `autoChoice` held a fresh pick that
    // nothing was using — and the label named a model that was not answering.
    const running = this.sessionChoice ?? this.autoChoice;
    return running === null ? "✨ Auto" : `✨ Auto · ${running.modelId}`;
  }

  selectModel(modelId: string | null): void {
    this.selectedModelId = modelId;
    this.modelProblem = null;
  }

  /** Taken, not read: the reason is shown once and then it is stale. */
  takeModelProblem(): string | null {
    const problem = this.modelProblem;
    this.modelProblem = null;
    return problem;
  }

  /**
   * How much runs without asking.
   *
   * Held here rather than read from settings on every turn, because it is now a
   * control in the panel: a user who has watched the agent work for ten minutes
   * changes it mid-conversation, and having to open settings.json to do that is
   * the reason nobody did.
   */
  private approval: ApprovalMode | null = null;

  get approvalMode(): ApprovalMode {
    this.approval ??= vscode.workspace
      .getConfiguration("hasaAgent")
      .get<ApprovalMode>("approvalMode", "safe");
    return this.approval;
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.approval = mode;
    // Standing grants were given under the old policy and do not carry — the
    // manager clears them itself, and this is the call that tells it to.
    this.session?.setApprovalMode(mode);
    this.log.appendLine(`[hasa] approval mode: ${mode}`);
  }

  /** Tools the user has said "항상 허용" to, so the panel can show and revoke them. */
  standingGrants(): string[] {
    return this.session?.grantedTools() ?? [];
  }

  revokeGrants(): void {
    this.session?.revokeGrants();
    this.log.appendLine("[hasa] standing approvals revoked");
  }

  get busy(): boolean {
    return this.running !== null;
  }

  cancel(): void {
    this.running?.abort();
  }

  // -------------------------------------------------------------------------
  // Credentials
  // -------------------------------------------------------------------------

  private async apiKey(): Promise<string | null> {
    const stored = await this.context.secrets.get(HASA_SECRET_KEY);
    const key = stored?.trim() ?? "";
    return key.length > 0 ? key : null;
  }

  async promptForApiKey(): Promise<boolean> {
    const value = await vscode.window.showInputBox({
      title: "HASA API Key",
      prompt: "키는 VS Code SecretStorage에 저장되며 화면이나 설정 파일에는 노출되지 않습니다.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (input) => (input.trim().length < 8 ? "키가 너무 짧습니다." : null),
    });
    if (value === undefined) return false;
    await this.context.secrets.store(HASA_SECRET_KEY, value.trim());
    this.reset();
    return true;
  }

  async clearApiKey(): Promise<void> {
    await this.context.secrets.delete(HASA_SECRET_KEY);
    this.reset();
  }

  /** A new key may have different permissions, so nothing built under the old one survives. */
  private reset(): void {
    this.provider = null;
    this.session = null;
    this.validation = null;
    this.autoChoice = null;
    this.sessionChoice = null;
    this.modeAtSession = null;
    // A different key is a different history. Dropping the store rather than
    // reusing it is what keeps one key's conversations out of another's.
    this.conversations = null;
    this.conversationId = null;
    this.recorded = [];
    // Held events belong to the old key's history and must not be written into
    // the new one's. The same goes for a conversation waiting to be restored:
    // it was read under the old key's scope.
    this.pendingEvents = [];
    this.pendingDelta = [];
    this.pendingRestore = null;
    // A new conversation may settle on a different folder than the last one did.
    this.boundRoot = null;
    this.turnOrdinal = 0;
    // The catalogue is public and key-independent, but a new key may reach a
    // different gateway, so it is re-read rather than carried across.
    this.catalog = null;
  }

  // -------------------------------------------------------------------------
  // Provider
  // -------------------------------------------------------------------------

  private async ensureProvider(): Promise<HasaProvider | null> {
    if (this.provider !== null) return this.provider;
    const key = await this.apiKey();
    if (key === null) return null;

    const home = this.context.globalStorageUri;
    const baseUrl = vscode.workspace.getConfiguration("hasaAgent").get<string>("baseUrl", "").trim();

    // Both caches live in the extension's own storage rather than the user's
    // repository: they are per-machine, per-key state, not project files.
    this.provider = createHasaProvider({
      apiKey: key,
      ...(baseUrl.length > 0 ? { baseUrl } : {}),
      cache: new FileModelCache(vscode.Uri.joinPath(home, "model-cache").fsPath),
      matrixPath: vscode.Uri.joinPath(home, "capability-matrix.json").fsPath,
      // Without this the provider logged to nowhere, and the client's
      // "retrying request" warning — the one line that would explain a turn
      // sitting silent for six minutes — went to a null logger. A user watching
      // it could not tell a slow model from four timed-out attempts, and
      // neither could I when asked.
      logger: outputChannelLogger(this.log),
      // Built for a person waiting, not for an unattended run. The default is
      // 120s × 4 attempts, which is eight minutes of silence; a real coding
      // request against this gateway answers in 20–35s, so a minute is already
      // generous and two attempts is enough to ride out a blip.
      timeoutMs: 60_000,
      maxRetries: 1,
    });
    return this.provider;
  }

  /**
   * Image and video generation, when the gateway offers it.
   *
   * The catalogue decides which models exist and what they are, so nothing here
   * names one. An empty catalogue — or one that cannot be reached — means the
   * tools are simply not registered, and the chat path is unaffected.
   */
  private async mediaTools(): Promise<{ media?: MediaConfig }> {
    const key = await this.apiKey();
    if (key === null) return {};

    const configured = vscode.workspace.getConfiguration("hasaAgent").get<string>("baseUrl", "").trim();
    // The default comes from the provider's own defaults rather than being
    // written again here — §8 puts the gateway address in one place, and a
    // second copy is the one that goes stale.
    // The catalogue and the media endpoints hang off the origin, not off `/v1`.
    const origin = (configured.length > 0 ? configured : HASA_DEFAULT_BASE_URL).replace(/\/v1\/?$/, "");

    const transport = createMediaTransport({ origin, apiKey: key });
    await this.ensureCatalog();
    if (this.catalog === null) return {};

    const [imageModels, videoModels] = await Promise.all([
      this.catalog.byModality("image"),
      this.catalog.byModality("video"),
    ]);
    if (imageModels.length === 0 && videoModels.length === 0) {
      this.log.appendLine("[hasa] no image or video models in the catalogue");
      return {};
    }

    this.log.appendLine(
      `[hasa] media: image=[${imageModels.map((m) => m.id).join(", ")}] ` +
        `video=[${videoModels.map((m) => m.id).join(", ")}]`,
    );
    const catalog = this.catalog;
    return {
      media: {
        transport,
        imageModels,
        videoModels,
        videoSpecFor: (id) => catalog.videoSpec(id),
      },
    };
  }

  async connectionState(): Promise<ConnectionState> {
    const hasApiKey = (await this.apiKey()) !== null;
    if (!hasApiKey) {
      return { hasApiKey: false, connected: false, detail: "API Key를 입력해 주세요.", modelCount: 0, usableModelId: null };
    }
    const validation = this.validation;
    if (validation === null) {
      return { hasApiKey: true, connected: false, detail: "연결을 확인하지 않았습니다.", modelCount: 0, usableModelId: null };
    }
    return {
      hasApiKey: true,
      connected: validation.credentialValid === true,
      detail: validation.detail,
      modelCount: validation.modelCount,
      usableModelId: validation.usableModelId,
    };
  }

  /** Checks the key against the gateway. Cheap, and never more than a few requests. */
  async validate(): Promise<ConnectionState> {
    const provider = await this.ensureProvider();
    if (provider === null) return this.connectionState();
    try {
      this.validation = await provider.validate();
      this.log.appendLine(`[hasa] validate: ${this.validation.detail}`);
    } catch (err) {
      this.log.appendLine(`[hasa] validate failed: ${describe(err)}`);
    }
    return this.connectionState();
  }

  /**
   * Measures the models this key can reach.
   *
   * Explicit rather than automatic: probing a catalogue on startup is nineteen
   * inference requests to fill a dropdown. But without a way to ask, the picker
   * says "확인되지 않음" beside every model forever, which reads as *you have no
   * permission* when it means *nobody has looked yet*.
   *
   * The allow-list from a 403 keeps it narrow — six requests instead of
   * nineteen, because the other thirteen would only answer 403 again.
   */
  async verifyModels(
    onProgress: (done: number, total: number) => void,
    signal: AbortSignal,
  ): Promise<string> {
    const provider = await this.ensureProvider();
    if (provider === null) return "먼저 API Key를 입력해 주세요.";

    if (this.validation === null) await this.validate();
    // Only models that could hold a conversation are worth measuring — the
    // probe asks for a chat completion, and an image model answers 404 to that
    // no matter how well it draws.
    const listing = (await this.conversationModels()) ?? (await provider.listModels({ refresh: true }));

    // Anything measured under the old answers is re-measured, which is the
    // point of pressing the button.
    provider.capabilities.invalidate();
    const result = await verifyModels({
      models: listing.models,
      allowedModels: this.validation?.allowedModels ?? null,
      measure: (id) => provider.capabilities.ensure(id, signal),
      onProgress: (p) => onProgress(p.done, p.total),
      signal,
    });

    // The pick was made under the old measurements and may no longer be best.
    this.autoChoice = null;
    this.log.appendLine(`[hasa] verified ${result.models.length} model(s)`);
    return describeVerification(result);
  }

  /**
   * The models that can hold the conversation.
   *
   * Not every model in the catalogue can. Selecting an image model in the
   * picker sent the turn to `/v1/chat/completions` and got a 404 before the
   * agent did anything — a user who wanted a picture had reached for the image
   * model, which is the obvious thing to do and the wrong one. Images come from
   * the generation tools; you ask for one, you do not switch model to get it.
   *
   * Which modalities those are is decided in `src/provider/hasa/hasaCatalog.ts`.
   * Nothing here knows the name of a single model, which is what keeps that
   * decision testable and this file thin.
   *
   * A catalogue that cannot be reached leaves every modality unknown, and
   * unknown converses — the picker degrades to what it listed before rather
   * than to empty.
   */
  async conversationModels(): Promise<ModelListing | null> {
    const listing = await this.listModels();
    if (listing === null) return null;

    const catalog = await this.ensureCatalog();
    if (catalog === null) return listing;

    const entries = new Map((await catalog.all()).map((e) => [e.id, e]));
    const models = listing.models.filter((m) => offerForConversation(entries.get(m.id)));

    // Named rather than counted. "2 model(s) hidden" is what the log said while
    // the picker was offering an audio model that 404s and one the catalogue had
    // already marked uncallable; knowing which two, and why, is the difference
    // between a line you can act on and a line you scroll past.
    for (const m of listing.models) {
      if (models.includes(m)) continue;
      const entry = entries.get(m.id);
      const why =
        entry === undefined
          ? "not in the catalogue"
          : !canConverse(entry.modality)
            ? `${entry.modality} models use their own endpoint`
            : !entry.available
              ? "the catalogue lists it as unavailable"
              : "this key class may not call it";
      this.log.appendLine(`[hasa] ${m.id} hidden from the picker: ${why}`);
    }
    return { ...listing, models };
  }

  /**
   * Turns an attached recording into text.
   *
   * The transcribing model is found in the catalogue by modality, so nothing
   * here names one — the same rule the chat and media paths follow. A gateway
   * with no speech model simply cannot do this, and says so rather than failing
   * against a model id invented in the extension.
   */
  async transcribe(name: string, bytes: Uint8Array, signal?: AbortSignal): Promise<AttachmentOutcome> {
    const catalog = await this.ensureCatalog();
    const key = await this.apiKey();
    if (catalog === null || key === null) {
      return { ok: false, reason: "먼저 API Key를 입력해 주세요." };
    }

    const speech = (await catalog.byModality("audio"))[0];
    if (speech === undefined) {
      return { ok: false, reason: "이 게이트웨이에는 사용할 수 있는 음성 인식 모델이 없습니다." };
    }

    const configured = vscode.workspace.getConfiguration("hasaAgent").get<string>("baseUrl", "").trim();
    const origin = (configured.length > 0 ? configured : HASA_DEFAULT_BASE_URL).replace(/\/v1\/?$/, "");

    try {
      const result = await transcribeAudio(
        createMediaTransport({ origin, apiKey: key }),
        { model: speech.id, name, bytes },
        signal,
      );
      const seconds = result.seconds;
      return {
        ok: true,
        note: `음성 · ${result.text.length}자${seconds === null ? "" : ` · ${Math.round(seconds)}초`}`,
        attachment: { kind: "audio", name, transcript: result.text, seconds },
      };
    } catch (err) {
      if (err instanceof TranscriptionUnavailable) {
        // Logged separately when only an operator can act: the same distinction
        // the probe draws for tool calling, and for the same reason — a
        // deployment problem read as a missing feature never gets fixed.
        if (err.operatorAction) {
          this.log.appendLine(`[hasa] OPERATOR ACTION — ${name}: ${err.message}`);
        }
        return { ok: false, reason: err.userMessage };
      }
      if ((err as { name?: string }).name === "AbortError") {
        return { ok: false, reason: `${name} 음성 인식을 취소했습니다.` };
      }
      return { ok: false, reason: `${name} 을(를) 전사하지 못했습니다: ${describe(err)}` };
    }
  }

  /** Whether asking for a picture or a clip will actually produce one. */
  async canGenerateMedia(): Promise<boolean> {
    const catalog = await this.ensureCatalog();
    if (catalog === null) return false;
    const [images, videos] = await Promise.all([
      catalog.byModality("image"),
      catalog.byModality("video"),
    ]);
    return images.length > 0 || videos.length > 0;
  }

  private async ensureCatalog(): Promise<HasaCatalog | null> {
    if (this.catalog !== null) return this.catalog;
    const key = await this.apiKey();
    if (key === null) return null;
    const configured = vscode.workspace.getConfiguration("hasaAgent").get<string>("baseUrl", "").trim();
    const origin = (configured.length > 0 ? configured : HASA_DEFAULT_BASE_URL).replace(/\/v1\/?$/, "");
    this.catalog = new HasaCatalog(createMediaTransport({ origin, apiKey: key }));
    return this.catalog;
  }

  async listModels(refresh = false): Promise<ModelListing | null> {
    const provider = await this.ensureProvider();
    if (provider === null) return null;
    try {
      return await provider.listModels({ refresh });
    } catch (err) {
      this.log.appendLine(`[hasa] listModels failed: ${describe(err)}`);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Running a turn
  // -------------------------------------------------------------------------

  private async ensureSession(
    onEvent: (event: AgentEvent) => void,
    routedModelId?: string | null,
  ): Promise<AgentSession | null> {
    const provider = await this.ensureProvider();
    if (provider === null) return null;

    // Resolved, never assumed. `workspaceFolders[0]` was right by accident in a
    // one-folder window and a coin toss in any other — and the user does not see
    // it being flipped, while every file read and command run lands on one side
    // of it.
    const context = await this.workspace();
    const root = context.activeRoot;
    if (root === null) {
      this.modelProblem = describeAmbiguity(context) ?? "작업할 폴더를 찾지 못했습니다.";
      this.log.appendLine(`[hasa] no working folder: ${this.modelProblem}`);
      return null;
    }
    // Bound for the rest of the conversation, so a later turn does not drift to
    // another folder because the user opened a file there to look at it.
    this.boundRoot ??= root.canonical;

    // A live session keeps the model it opened with unless the mode now needs a
    // different one. Asking first avoids re-resolving on every ordinary turn,
    // which spent live inference requests measuring candidates and then threw
    // the answer away.
    // A routed worker that differs from the one in the session is a reason to
    // revisit that `modelNeedsRevisiting` cannot see — it reasons about modes,
    // and this is about what the request asked for.
    const routedElsewhere =
      this.selectedModelId === null &&
      routedModelId != null &&
      routedModelId.length > 0 &&
      this.sessionChoice !== null &&
      this.sessionChoice.modelId !== routedModelId;

    if (this.session !== null && !this.modelNeedsRevisiting() && !routedElsewhere) {
      this.session.setMode(this.mode);
      this.applyPendingRestore(this.session);
      return this.session;
    }

    const choice = await this.resolveModel(provider, routedModelId);
    if (choice === null) return null;

    const previous = this.session;
    if (
      previous !== null &&
      this.sessionChoice?.modelId === choice.modelId &&
      this.sessionChoice.toolProtocol === choice.toolProtocol
    ) {
      // Revisiting produced the same answer. The mode changed; the model did not.
      previous.setMode(this.mode);
      this.modeAtSession = this.mode;
      return previous;
    }

    // What moves to the replacement, and nothing else does. Rebuilding without
    // these costs the user their conversation and their undo — and the undo is
    // the quiet one: the stash stays in the repository, but the ref that finds
    // it lives in the manager being discarded, so "되돌리기" would report nothing
    // to revert while the work sat there unreachable.
    const carried = previous === null ? [] : [...previous.history()];
    const checkpoint = previous?.checkpoint ?? null;
    if (previous !== null) {
      this.log.appendLine(
        `[hasa] rebuilding the session for ${this.mode} mode: ` +
          `${this.sessionChoice?.modelId ?? "?"} → ${choice.modelId}` +
          `${checkpoint === null ? "" : ", carrying the checkpoint"}` +
          `${carried.length === 0 ? "" : `, ${carried.length} message(s)`}`,
      );
      this.session = null;
    }
    this.sessionChoice = choice;
    this.modeAtSession = this.mode;

    // The measured output ceiling, when there is one. Without it the gateway
    // applies its own default, and for a model with a small context that
    // default is larger than the model can accept — a 400 before any work
    // begins, observed on granite-guardian-3.1-8b.
    const limits = await provider.capabilities.limitsOf(choice.modelId);
    // Measured, never inferred: an attached screenshot is sent when the model
    // is known to read images, refused with a reason when it is known not to,
    // and attempted when nobody has looked.
    const capabilities = await provider.capabilities.capabilitiesOf(choice.modelId);

    // Each of these reaches the network or the disk, and each was silent. The
    // rule now is that anything which can take a noticeable time says its name
    // first — a label is cheap, and the alternative is a clock counting up
    // against the word "생각".
    this.phase?.("워크스페이스에서 실행 가능한 명령을 찾는 중");
    const workspace = await workspaceCommands(root.path, this.log);
    this.phase?.("이미지·동영상 도구를 준비하는 중");
    const media = await this.mediaTools();
    this.phase?.("대화를 준비하는 중");

    this.session = await AgentSession.open({
      vision: capabilities.vision,
      workspaceRoot: root.path,
      model: createModelFor({
        provider,
        modelId: choice.modelId,
        toolProtocol: choice.toolProtocol,
        ...(limits.maxOutputTokens === null ? {} : { maxOutputTokens: limits.maxOutputTokens }),
      }),
      approvalPort: { request: (request) => askUser(request) },
      mode: this.mode,
      approvalMode: this.approvalMode,
      // Honoured for the conversation, not the turn. "Stop asking me about
      // this" is not a statement about the next four seconds.
      rememberGrants: "session",
      ...workspace,
      ...media,
      checkpoint,
      onEvent,
      // Built from the conversation's events every time it is asked, so it
      // includes the turns before this one. That is what makes a continuation
      // after a timeout resume from the unresolved work rather than from
      // nothing: the events were written as the run went, and the record is a
      // projection of them.
      taskRecord: () => {
        const task = reduceTask(this.recorded, this.conversationId ?? "task");
        return task === null || task.requirements.length + task.issues.length === 0
          ? null
          : describeTask(task);
      },
      // From the same projection, and asked a different question: not "what
      // happened" but "may this answer be sent". Every candidate, and a
      // runtime-written summary when the repairs run out — see `finalClaims.ts`.
      taskComplete: () =>
        taskDisposition(reduceTask(this.recorded, this.conversationId ?? "task"), this.lastTermination) ===
        "completed",
      finalClaims: {
        validate: (text) => {
          const task = reduceTask(this.recorded, this.conversationId ?? "task");
          const verdict = validateFinalClaims({
            task,
            disposition: taskDisposition(task, this.lastTermination),
            text,
            ...(this.lastTermination === undefined ? {} : { termination: this.lastTermination }),
          });
          return verdict.valid ? null : describeViolations(verdict.violations);
        },
        fallback: () => {
          const task = reduceTask(this.recorded, this.conversationId ?? "task");
          return safeFallback(task, taskDisposition(task, this.lastTermination), this.lastTermination);
        },
      },
    });
    if (carried.length > 0) this.session.restore(carried);
    // After `carried`, deliberately. A conversation the user reopened is what
    // they are looking at; whatever the previous session happened to hold is
    // not, and the screen must win.
    this.applyPendingRestore(this.session);
    return this.session;
  }

  /**
   * Puts a reopened conversation's messages into the session that can hold them.
   *
   * Called on both paths out of `ensureSession` — the reused session and the
   * rebuilt one — because a conversation opened while the gateway was down can
   * be waiting on either.
   */
  private applyPendingRestore(session: AgentSession): void {
    if (this.pendingRestore === null) return;
    session.restore(this.pendingRestore);
    // The third half, and it belongs here for the same reason the other two do:
    // one place moves the session onto a conversation. What the user asked for
    // is folded from the same events the screen is drawn from.
    session.restoreContract(this.recorded);
    this.log.appendLine(`[hasa] restored ${this.pendingRestore.length} message(s) into the session`);
    this.pendingRestore = null;
  }

  /**
   * Whether the model this session opened with may no longer be the right one.
   *
   * Only two things can make it so, and re-resolving is not free — it can spend
   * live inference requests measuring candidates — so it is asked rather than
   * assumed.
   *
   * A hand-picked model is the plain case: the user chose it and the running
   * session is not using it.
   *
   * A mode change matters in one direction. A model chosen for a mode that
   * writes already satisfies one that only reads, so CODE → ASK keeps what it
   * has. ASK → CODE does not: a chat-only model will accept the request and then
   * describe the change instead of making it, which is the failure `autoModel`
   * exists to prevent and which a reused session would walk straight into.
   */
  private modelNeedsRevisiting(): boolean {
    if (this.selectedModelId !== null) return this.selectedModelId !== this.sessionChoice?.modelId;
    if (this.sessionChoice === null || this.modeAtSession === null) return true;
    if (this.modeAtSession === this.mode) return false;
    return modeCanWrite(this.mode) && !modeCanWrite(this.modeAtSession);
  }

  /**
   * The model to use, and how it will be asked to call tools.
   *
   * `routedModelId` is what the requirement-aware router decided for this turn.
   * It is passed in rather than read from a field so that the two paths cannot
   * drift: a turn either routed and says so, or did not and falls through to
   * the selection that existed before — which is now the *bootstrap* selector
   * and the explicit fallback, not the way workers are normally chosen.
   */
  private async resolveModel(
    provider: HasaProvider,
    routedModelId?: string | null,
  ): Promise<AutoModelChoice | null> {
    if (this.selectedModelId === null && routedModelId != null && routedModelId.length > 0) {
      const capabilities = await provider.capabilities.capabilitiesOf(routedModelId);
      return {
        modelId: routedModelId,
        confidence: "measured",
        toolProtocol: protocolFor(capabilities) ?? "text",
        reason: "요구사항에 맞춰 고른 모델입니다.",
      };
    }
    if (this.selectedModelId !== null) {
      // The picker no longer offers these, but a selection outlives the list it
      // came from, and sending one produces a bare `404 Not Found` that says
      // nothing about what went wrong. Refusing here costs a request and buys
      // an error the user can act on.
      const catalog = await this.ensureCatalog();
      const entry = (await catalog?.entry(this.selectedModelId)) ?? null;
      if (!offerForConversation(entry)) {
        // Two reasons, and the user can act on only one of them, so they are not
        // given the same sentence. A dedicated-endpoint model is reachable —
        // through the tools, by asking for what they want. A model the gateway
        // will not serve is not reachable at all.
        const modality = entry?.modality ?? "unknown";
        this.modelProblem = !canConverse(modality)
          ? `${this.selectedModelId} 은(는) ${MODALITY_KO[modality] ?? modality} ` +
            "전용 모델이라 대화에 쓸 수 없습니다. ✨ Auto 로 두고 원하는 것을 말씀하시면 " +
            "필요할 때 알아서 사용합니다."
          : `${this.selectedModelId} 은(는) 지금 사용할 수 없습니다` +
            `${entry?.available === false ? " (게이트웨이가 중지 상태로 표시)" : " (이 API Key에 권한 없음)"}. ` +
            "✨ Auto 로 두시면 사용 가능한 모델을 고릅니다.";
        this.log.appendLine(
          `[hasa] refused ${this.selectedModelId}: modality=${modality} ` +
            `available=${String(entry?.available)} callable=${String(entry?.callable)}`,
        );
        return null;
      }
      // A hand-picked model still needs the right protocol, and the capability
      // cache usually already knows — asking it costs nothing.
      const capabilities = await provider.capabilities.capabilitiesOf(this.selectedModelId);
      return {
        modelId: this.selectedModelId,
        confidence: "unverified",
        toolProtocol: protocolFor(capabilities) ?? "text",
        reason: "",
      };
    }
    if (this.autoChoice !== null) return this.autoChoice;
    this.phase?.("사용할 모델을 고르는 중");

    // The same list the picker offers, not the raw catalogue. Auto ranked every
    // model `/v1/models` returned, and an unmeasured one is a candidate rather
    // than a disqualification — so the image, audio and embedding models were
    // all selectable, and picking one meant every turn answering 404 before the
    // agent ran. The picker had been taught to hide them; Auto had not, which is
    // how the two came to disagree about what this key can talk to.
    this.phase?.("모델 목록을 불러오는 중");
    const listing = (await this.conversationModels()) ?? (await provider.listModels());

    // Measuring is an optimisation, and it was allowed to block the request it
    // was supposed to improve. `chooseModel` takes a signal and was given none,
    // so probing ran unbounded: three candidates, eleven probes each, every one
    // able to time out and retry. A turn sat on it for twenty-four minutes.
    //
    // Bounded now, and the bound is deliberately short. Past it the ranking's
    // best guess is used instead — which is exactly what `chooseModel` falls
    // back to on its own, and an unverified model that answers beats a measured
    // one nobody waited for.
    const probing = AbortSignal.timeout(MODEL_CHOICE_BUDGET_MS);
    const choice = await chooseModel({
      models: listing.models,
      mode: this.mode,
      knownUsableModelId: this.validation?.usableModelId ?? null,
      measure: (id) => {
        this.phase?.(`${id} 모델을 확인하는 중`);
        return provider.capabilities.ensure(id, probing);
      },
      signal: probing,
    });
    if (probing.aborted) {
      this.log.appendLine(
        `[hasa] model measurement exceeded ${MODEL_CHOICE_BUDGET_MS / 1000}s; using the best unmeasured candidate`,
      );
    }
    if (choice === null) return null;
    this.autoChoice = choice;
    this.log.appendLine(
      `[hasa] auto model: ${choice.modelId} (${choice.confidence}, ${choice.toolProtocol} tools)`,
    );
    return choice;
  }

  /**
   * What the user asked for and where each part of it stands.
   *
   * Built from the same events everything else reads, so the panel shows the
   * runtime's record rather than a second account of it. Null until the model
   * has recorded a contract — see `requirementsView`.
   */
  requirements(): RequirementsView | null {
    const session = this.session;
    if (session === null) return null;
    return requirementsView(
      reduceTask(this.recorded, this.conversationId ?? "task"),
      session.taskContract,
      this.lastTermination,
    );
  }

  /**
   * Where the work stands, for the panel's progress block.
   *
   * A fold over the same events `requirements()` reads. There is no progress
   * record: the projection is derived on demand, so a reload and a live turn
   * cannot disagree, and `Date.now()` is passed in rather than read inside so a
   * replayed conversation does not look like a running one.
   *
   * Independent of `this.session`, deliberately. The panel used to infer "in
   * progress" from a session existing, which is true from the moment a
   * conversation is opened until it is closed.
   */
  progress(): AgentProgress | null {
    return progressView({
      events: this.recorded,
      contract: reduceContract([...this.recorded]),
      now: Date.now(),
      taskId: this.conversationId ?? "task",
    });
  }

  async send(
    prompt: string,
    onEvent: (event: AgentEvent) => void,
    attachments: readonly Attachment[] = [],
  ): Promise<AgentTurnResult | null> {
    if (this.running !== null) return null;

    // Claimed before the setup, not after. `ensureSession` awaits the network,
    // and until it returned `busy` was false — so the panel left the composer
    // enabled and a second message went nowhere.
    const controller = new AbortController();
    this.running = controller;
    this.phase = (label) => onEvent({ type: "phase", label });

    // The loop has a deadline; the setup before it had none, and that is where a
    // turn spent twenty-four minutes. A ceiling over the whole thing is what
    // makes "it will end" true rather than mostly true.
    const wholeTurn = setTimeout(() => controller.abort(new Error("turn timed out")), TURN_CEILING_MS);

    // Every turn is recorded as it runs, not reconstructed afterwards. The
    // recorder is the one place that decides what is worth keeping, and both
    // the live panel and a reopened conversation are projections of what it
    // wrote — which is what stops the two disagreeing.
    this.conversationId ??= newConversationId(Date.now(), Math.random);
    const turnId = `${this.conversationId}-${this.turnOrdinal++}`;
    const recorder = new TurnRecorder({ turnId });
    const startedAt = Date.now();

    // The turn's own events, kept apart from the running log. `this.recorded` is
    // what the panel draws — every turn of the conversation — while a turn on
    // disk owns only its own, so that restoring to it restores exactly the
    // screen that turn ended with.
    const turnEvents: SessionEvent[] = [];
    const keep = (events: readonly SessionEvent[]): void => {
      turnEvents.push(...events);
      this.recorded.push(...events);
    };
    keep(recorder.userMessage(prompt, attachments.map((a) => ({ name: a.name, kind: a.kind }))));

    const forward = (event: AgentEvent): void => {
      keep(recorder.record(event));
      onEvent(event);
    };

    let outcome: AgentTurnResult | null = null;
    try {
      this.phase("준비하는 중");
      // Read the request before choosing who answers it. Everything this
      // produces — the contract, the profile, the decision — is recorded, so a
      // reopened conversation can say why this model was picked rather than
      // recomputing an answer against a catalogue that has since changed.
      const routing = await this.routeTurn(turnId, prompt, keep, controller.signal);
      const session = await this.ensureSession(forward, routing.workerModelId);
      if (session === null) return null;
      // The worker inherits the contract the bootstrap pass already validated.
      // Without this it would have to call `record_request` itself, and the
      // contract the router ranked against would not be the one the worker
      // honours — two readings of one sentence.
      if (routing.contractEvents.length > 0) {
        session.restoreContract([...this.recorded]);
      }
      // Installed every turn, not only when the session is built. A session
      // reused from a previous turn — or reopened from history, which built one
      // with a no-op sink — would otherwise send this turn's events nowhere.
      session.setEventSink(forward);
      if (controller.signal.aborted) {
        onEvent({
          type: "error",
          code: "setup_timeout",
          message:
            "준비 단계가 너무 오래 걸려 중단했습니다. 게이트웨이 응답이 느린 상태일 수 있습니다. " +
            "출력 패널(HASA)에 원인이 남아 있습니다.",
        });
        return null;
      }
      this.phase("생각하는 중");
      outcome = await session.send(prompt, controller.signal, attachments);
      // Kept for the *next* turn's gate. Within this turn the loop already
      // knows how it is ending; what the gate cannot see from the record alone
      // is that a previous run stopped rather than finished.
      this.lastTermination = outcome.reason;
      return outcome;
    } finally {
      // The turn's own events are already in `this.recorded` via `forward`.
      clearTimeout(wholeTurn);
      this.running = null;
      this.phase = null;
      // Saved even when the turn failed or was cancelled: what the user typed
      // is theirs, and losing it because the gateway was down would be its own
      // small betrayal. An abnormal ending is a real turn — it is written with
      // the state it actually reached rather than dropped.
      await this.persistTurn({ id: turnId, startedAt, events: turnEvents, outcome });
    }
  }

  /**
   * Reads the request, then chooses who answers it.
   *
   * The order is the whole point of R3. Before this, the model was chosen from
   * the mode alone — four values — so "README의 오타만 고쳐줘" and "30개 파일을
   * 고치고 테스트까지 해줘" got the same worker whenever they shared a mode.
   * Now the request is interpreted first, projected into a `TaskProfile`, and
   * the profile is what the recommender ranks against.
   *
   * Three things this deliberately does not do:
   *
   * It does not run when the user picked a model. An explicit choice outranks
   * a recommendation, and computing one anyway would put a "we would have
   * chosen X" into the record beside the Y that actually ran.
   *
   * It does not silently fall back. A bootstrap failure returns a `fallback`
   * event naming the failure — routing around the requirement-aware path while
   * looking like it worked is the one outcome that would make all of this
   * unfalsifiable.
   *
   * It does not re-choose every turn. A continuation of the same task keeps its
   * worker; see `routingTriggerFor`.
   */
  private async routeTurn(
    turnId: string,
    prompt: string,
    keep: (events: readonly SessionEvent[]) => void,
    signal: AbortSignal,
  ): Promise<{ workerModelId: string | null; contractEvents: SessionEvent[] }> {
    const stamp = (): { id: string; turnId: string; at: number } => ({
      id: `${turnId}-r${this.routingOrdinal++}`,
      turnId,
      at: Date.now(),
    });

    // An explicit selection is not routed around. §45.
    if (this.selectedModelId !== null) {
      keep([
        {
          type: "worker_selected",
          ...stamp(),
          selectionOrigin: "user_manual",
          selectedModelId: this.selectedModelId,
          routerVersion: "r3.1",
        },
      ]);
      return { workerModelId: null, contractEvents: [] };
    }

    const provider = await this.ensureProvider();
    if (provider === null) return { workerModelId: null, contractEvents: [] };

    // The bootstrap interpreter is chosen the old way, on purpose: this slice
    // does not recommend the model that does the reading, and reusing the
    // mode-only selector for it is what confines that mechanism to a role it
    // is adequate for.
    this.phase?.("요청을 정리하는 중");
    const bootstrapChoice = await this.resolveModel(provider);
    if (bootstrapChoice === null) return { workerModelId: null, contractEvents: [] };

    const bootstrapModel = createModelFor({
      provider,
      modelId: bootstrapChoice.modelId,
      toolProtocol: bootstrapChoice.toolProtocol,
    });

    const interpreted = await interpretRequest({
      model: bootstrapModel,
      prompt,
      turnId,
      signal,
    });

    if (!interpreted.ok) {
      this.log.appendLine(`[hasa] bootstrap failed: ${interpreted.failure} — ${interpreted.detail}`);
      keep([
        unroutedEvent({
          ...stamp(),
          modelId: null,
          reason: `${interpreted.failure}: ${interpreted.detail}`,
          bootstrapModelId: interpreted.bootstrapModelId,
        }),
        {
          type: "notice",
          ...stamp(),
          level: "warning",
          text: describeBootstrapFailure(interpreted),
        },
      ]);
      // No profile means no recommendation. The turn still runs, on the
      // selection that existed before — and the record says so. §42.
      return { workerModelId: null, contractEvents: [] };
    }

    const contractEvent: SessionEvent = {
      type: "turn_contract",
      ...stamp(),
      contract: interpreted.contract,
    };

    const listing = (await this.conversationModels()) ?? (await provider.listModels());
    const profiles = buildRegistry(listing.models);
    this.lastRegistry = profiles;
    const previous = reduceContract([...this.recorded]);
    const currentWorker = selectedWorkerFor(this.recorded)?.modelId ?? null;
    // Derived from the persisted contract events rather than held in a field.
    // Held in a field it did not survive the process exiting, so the first turn
    // after a reload saw no previous profile and re-recommended for a task that
    // had not changed and already had a worker.
    const previousProfile = previousProfileFrom(this.recorded);
    // No live session yet but a worker on the record means this conversation
    // was reopened. Only changes what the decision is called.
    const restored = this.session === null && currentWorker !== null;

    let decision: WorkerDecision;
    try {
      decision = await decideWorker({
        turn: interpreted.contract,
        previous,
        currentWorker,
        currentWorkerRestored: restored,
        profiles,
        ...(previousProfile === undefined ? {} : { previousProfile }),
      });
    } catch (err) {
      this.log.appendLine(`[hasa] routing failed: ${(err as Error).message}`);
      keep([
        contractEvent,
        unroutedEvent({
          ...stamp(),
          modelId: null,
          reason: `ROUTER_ERROR: ${(err as Error).message}`,
          bootstrapModelId: interpreted.bootstrapModelId,
        }),
      ]);
      return { workerModelId: null, contractEvents: [contractEvent] };
    }

    // The shadow runs *beside* the decision, never inside it. `decision` is
    // already settled by the time this is called, and nothing below is allowed
    // to look at it except to read which candidates production ranked — see
    // `shadow.ts` for why a zero weight would have been the wrong shape.
    const shadow =
      decision.recommendation === undefined
        ? null
        : await this.observeShadow(decision, signal);

    keep([
      contractEvent,
      routingEvent({
        ...stamp(),
        decision,
        bootstrapModelId: interpreted.bootstrapModelId,
        bootstrapModelCalls: interpreted.attempts,
        ...(shadow === null ? {} : { shadow }),
      }),
    ]);

    this.log.appendLine(
      `[hasa] routed ${turnId}: bootstrap=${interpreted.bootstrapModelId} ` +
        `worker=${decision.modelId ?? "none"} trigger=${decision.trigger} origin=${decision.origin}` +
        `${shadow === null ? "" : ` shadow=${shadow.status}/${shadow.shadowSelectedModelId ?? "-"}`}`,
    );

    return { workerModelId: decision.modelId, contractEvents: [contractEvent] };
  }

  /**
   * Measures the semantic term without letting it decide anything.
   *
   * Delegated to `ShadowRunner`, which is where the behaviour worth testing
   * lives — the provider built once rather than per turn, the observation run
   * against a decision that is already settled, and every failure returning
   * rather than throwing. Keeping it here made a regex over this file the only
   * available test, which is how the matcher went unwired for two slices.
   */
  private async observeShadow(
    decision: WorkerDecision,
    signal: AbortSignal,
  ): Promise<SemanticShadowEvaluation | null> {
    this.shadowRunner ??= new ShadowRunner({
      apiKey: () => this.apiKey(),
      baseUrl: () => {
        const configured = vscode.workspace
          .getConfiguration("hasaAgent")
          .get<string>("baseUrl", "")
          .trim();
        return configured.length > 0 ? configured : HASA_DEFAULT_BASE_URL;
      },
      taskContract: () => this.session?.taskContract ?? emptyContract(),
    });
    return this.shadowRunner.observe(decision, this.lastRegistry, signal);
  }

  /** Whatever could not be attached to the last message, once. */
  takeAttachmentProblem(): string | null {
    return this.session?.takeAttachmentProblem() ?? null;
  }

  async undo(): Promise<boolean> {
    return (await this.session?.undo()) ?? false;
  }

  keep(): void {
    this.session?.keep();
  }

  /**
   * Files this conversation changed.
   *
   * Taken from what the tools reported, with git used only to widen it. It used
   * to be git alone — `git status --porcelain` through the checkpoint manager —
   * which meant a workspace that is not a repository showed nothing at all: the
   * agent wrote four files and the review card stayed empty, because the only
   * thing being asked had no opinion about a plain folder.
   *
   * Git still contributes. It catches what a command changed, which no tool
   * reported and no event could know.
   */
  async changedFiles(): Promise<string[]> {
    const reported = reduceSession(this.recorded).changedFiles.map((f) => f.path);
    const fromGit = (await this.session?.changedFiles()) ?? [];
    return [...new Set([...reported, ...fromGit])].sort();
  }

  // -------------------------------------------------------------------------
  // Conversation history
  // -------------------------------------------------------------------------

  /**
   * The store for whichever key is in use.
   *
   * Scoped by the workspace, not by the key.
   *
   * It used to be the key, and rotating one emptied the history — every
   * conversation still on disk under a directory nothing would look in again. A
   * credential says who is calling; it says nothing about which project this
   * is. The store now has no argument to put a key in.
   *
   * Rebuilt when the workspace changes, which is why the id it was built for is
   * remembered: a window that adds a folder is a different workspace, and
   * continuing to write into the old one would file this project's
   * conversations under the last one.
   */
  private async ensureConversations(): Promise<ConversationStore | null> {
    const context = await this.workspace();
    const workspaceId = context.identity.id;
    if (this.conversations !== null && this.conversationsFor === workspaceId) return this.conversations;

    this.conversations = new ConversationStore({
      port: createConversationPort(),
      home: this.context.globalStorageUri.fsPath,
      workspaceId,
    });
    this.conversationsFor = workspaceId;
    return this.conversations;
  }

  /**
   * Which workspace this window is, and which folder to work in.
   *
   * Resolved once per call rather than cached across them: a user can add or
   * remove a folder, and an identity computed at activation would outlive the
   * thing it named. The result is cheap — a `realpath` per folder.
   */
  async workspace(): Promise<WorkspaceContext> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots = await Promise.all(folders.map((f) => canonicalizeRoot(f.uri.fsPath)));
    return resolveWorkspaceContext({
      folders: roots,
      ...(vscode.workspace.workspaceFile === undefined
        ? {}
        : { configPath: vscode.workspace.workspaceFile.fsPath }),
      // What this conversation has already been working in wins over anything
      // the user has clicked on since — otherwise the same relative path would
      // mean different files within one conversation.
      boundRoot: this.boundRoot,
      chosenRoot: this.chosenRoot,
      activeFile: vscode.window.activeTextEditor?.document.uri.fsPath ?? null,
    });
  }

  /** Records which folder the user picked, when the window has several. */
  chooseRoot(path: string | null): void {
    this.chosenRoot = path;
  }

  get currentConversationId(): string | null {
    return this.conversationId;
  }

  async listConversations(): Promise<ConversationSummary[]> {
    const store = await this.ensureConversations();
    return store === null ? [] : store.list();
  }

  /**
   * Loads a past conversation.
   *
   * Reading is local and stays local. This used to build a session first, which
   * meant validating the key and fetching the model list, so a gateway that was
   * down made every saved conversation unopenable — the history list showed them
   * and clicking one failed. Nothing about reading a file needs a model.
   *
   * Both halves still move together: the events are drawn now and the messages
   * wait in `pendingRestore` for the session that will hold them, which is
   * installed before any turn can run.
   */
  async openConversation(id: string): Promise<boolean> {
    const store = await this.ensureConversations();
    if (store === null) return false;
    const stored = await store.load(id);
    if (stored === null) return false;
    this.adopt(stored, "opened");
    return true;
  }

  /**
   * Moves the live session onto a stored conversation, both halves at once.
   *
   * The only place that does. Opening a conversation, switching branch, forking
   * and restoring a checkpoint are four ways of saying "the conversation is now
   * here", and each one that moved the halves itself would be a fresh chance to
   * move one and not the other — which is the failure the turn graph exists to
   * prevent, arriving through the back door.
   *
   * Both come from a single `store.load`, so they are the same traversal of the
   * same chain by construction rather than by care.
   */
  private adopt(stored: StoredConversation, what: string): void {
    this.pendingRestore = stored.messages;
    if (this.session !== null) this.applyPendingRestore(this.session);
    this.conversationId = stored.id;
    this.recorded = [...(stored.events ?? [])];
    this.pendingEvents = [];
    this.pendingDelta = [];
    // Counts turns rather than distinct event `turnId`s: a turn can end with no
    // events at all, and counting those would hand the next turn an id that is
    // already taken. Turns are never removed — an orphan is kept — so this only
    // ever grows, which is what keeps ids unique across forks.
    this.turnOrdinal = stored.turns?.length ?? new Set(this.recorded.map((e) => e.turnId)).size;
    // Taken from the conversation rather than from the window. A conversation
    // resumed a week later must resolve `src/a.ts` to the file it meant then,
    // not to whichever folder is in front now.
    this.boundRoot = stored.workspace?.boundRoot ?? null;
    this.log.appendLine(
      `[hasa] ${what} ${stored.id} on branch ${stored.activeBranchId ?? "main"} ` +
        `(${stored.turns?.length ?? 0} turns, ${this.recorded.length} events, ` +
        `${stored.messages.length} messages)`,
    );
  }

  // -------------------------------------------------------------------------
  // Branches and checkpoints
  //
  // None of these touches the working tree. Moving between two lines of a
  // conversation changes what the model has read; the files are the user's.
  // -------------------------------------------------------------------------

  /** The open conversation's graph, for offering fork points. */
  async conversationGraph(): Promise<StoredConversation | null> {
    const store = await this.ensureConversations();
    if (store === null || this.conversationId === null) return null;
    return store.load(this.conversationId);
  }

  /** Forks at a turn and moves onto the new branch. */
  async createBranch(
    name: string,
    fromTurnId: string,
  ): Promise<{ ok: true; branchId: string } | { ok: false; reason: string }> {
    const store = await this.ensureConversations();
    if (store === null || this.conversationId === null) {
      return { ok: false, reason: "열린 대화가 없습니다." };
    }
    const now = Date.now();
    // Derived from the fork point rather than the name: a name is the user's and
    // may be any text, an id is ours and is used as a key.
    const branchId = `b${now.toString(36)}`;
    const result = await store.createBranch(this.conversationId, {
      branchId,
      name,
      fromTurnId,
      at: now,
      activate: true,
    });
    if (!result.ok) return result;

    const stored = await store.load(this.conversationId);
    if (stored !== null) this.adopt(stored, "forked");
    return { ok: true, branchId };
  }

  async switchBranch(branchId: string): Promise<boolean> {
    const store = await this.ensureConversations();
    if (store === null || this.conversationId === null) return false;
    if (!(await store.switchBranch(this.conversationId, branchId, Date.now()))) return false;

    const stored = await store.load(this.conversationId);
    if (stored === null) return false;
    this.adopt(stored, "switched");
    return true;
  }

  async deleteBranch(branchId: string): Promise<{ ok: boolean; reason?: string }> {
    const store = await this.ensureConversations();
    if (store === null || this.conversationId === null) return { ok: false, reason: "열린 대화가 없습니다." };
    const result = await store.deleteBranch(this.conversationId, branchId, Date.now());
    if (!result.ok) return result;

    const stored = await store.load(this.conversationId);
    if (stored !== null) this.adopt(stored, "left branch on");
    return { ok: true };
  }

  /**
   * Bookmarks a turn, with a note about what the workspace looked like.
   *
   * The git head and the changed files are recorded because they are genuinely
   * useful to read later — "this is where it worked" means little without
   * knowing what "there" was. They are a note, not a handle: restoring this
   * checkpoint moves the conversation and leaves every file alone.
   */
  async createCheckpoint(
    message: string,
    turnId?: string,
  ): Promise<{ ok: true; checkpointId: string } | { ok: false; reason: string }> {
    const store = await this.ensureConversations();
    if (store === null || this.conversationId === null) {
      return { ok: false, reason: "열린 대화가 없습니다." };
    }
    const stored = await store.load(this.conversationId);
    if (stored === null) return { ok: false, reason: "열린 대화가 없습니다." };

    const branchId = stored.activeBranchId ?? "main";
    const head = stored.branches?.find((b) => b.id === branchId)?.headTurnId ?? null;
    const target = turnId ?? head;
    if (target === null) return { ok: false, reason: "저장할 지점이 아직 없습니다." };

    const now = Date.now();
    const result = await store.addCheckpoint(this.conversationId, {
      checkpointId: `cp${now.toString(36)}`,
      turnId: target,
      branchId,
      message,
      at: now,
      metadata: await this.workspaceNoteFor(),
    });
    return result.ok ? { ok: true, checkpointId: result.checkpoint.id } : result;
  }

  /**
   * Moves the conversation to a checkpoint's turn.
   *
   * Deliberately does not run `git checkout`, `reset` or `restore`, and does
   * nothing automatic with the files. The recorded git head is shown, so a user
   * who wants their files back can reach for git themselves — which is a
   * decision only they can make, and one there is no undo for.
   */
  async restoreCheckpoint(checkpointId: string): Promise<{ ok: boolean; reason?: string }> {
    const store = await this.ensureConversations();
    if (store === null || this.conversationId === null) return { ok: false, reason: "열린 대화가 없습니다." };
    const stored = await store.load(this.conversationId);
    if (stored === null) return { ok: false, reason: "열린 대화가 없습니다." };

    const checkpoint = stored.checkpoints?.find((c) => c.id === checkpointId);
    if (checkpoint === undefined) return { ok: false, reason: "없는 저장 지점입니다." };
    if (!(stored.turns ?? []).some((t) => t.id === checkpoint.turnId)) {
      return { ok: false, reason: "이 저장 지점이 가리키던 대화 지점이 없습니다." };
    }

    // A branch at the checkpoint, so continuing from it extends a line of its
    // own rather than overwriting the one the user came from.
    const created = await this.createBranch(checkpoint.message.slice(0, 40), checkpoint.turnId);
    return created.ok ? { ok: true } : { ok: false, reason: created.reason };
  }

  /** What the workspace looked like, for a checkpoint to remember. */
  private async workspaceNoteFor(): Promise<ConversationCheckpoint["metadata"]> {
    const changedFiles = await this.changedFiles().catch(() => []);
    return {
      gitHead: await this.session?.headSha().catch(() => null) ?? null,
      changedFiles,
      mode: this.mode,
      ...(this.selectedModelId === null ? {} : { modelId: this.selectedModelId }),
    };
  }

  /** The conversation as the user saw it, for the panel to project. */
  recordedEvents(): readonly SessionEvent[] {
    return this.recorded;
  }

  async deleteConversation(id: string): Promise<void> {
    const store = await this.ensureConversations();
    await store?.remove(id);
    if (this.conversationId === id) {
      this.conversationId = null;
      this.session?.clearHistory();
      // A conversation deleted before its messages reached a session must not
      // reach one afterwards.
      this.pendingRestore = null;
      this.recorded = [];
      this.pendingEvents = [];
      this.pendingDelta = [];
      this.turnOrdinal = 0;
    }
  }

  /**
   * Writes one turn to disk.
   *
   * Called after a turn rather than during it: a turn that is still running has
   * a history that is about to change.
   *
   * Both halves are taken here, together. The events are what the user saw; the
   * delta is what the model additionally read, observed from the real history
   * across the turn rather than rebuilt from the events — the two are not
   * interconvertible, and a reconstruction would be a guess written into a
   * record. Taking them in one place is what makes it impossible to store a turn
   * whose screen and whose context stopped at different moments.
   */
  private async persistTurn(turn: {
    id: string;
    startedAt: number;
    events: SessionEvent[];
    outcome: AgentTurnResult | null;
  }): Promise<void> {
    const store = await this.ensureConversations();
    const session = this.session;

    // Taken whenever there is a session, even when there is nowhere to write it.
    // Left in place it would be discarded by the next turn, and the events it
    // belongs with would then describe an exchange the model's stored history
    // does not contain.
    const delta = session === null ? [] : session.takeMessageDelta();

    // Nothing to write into. Both halves are held rather than dropped, so a turn
    // that died before its store existed still appears once the next one lands —
    // losing what the user typed because the gateway was down would be its own
    // small betrayal. Held together, so what comes back is still a whole turn.
    if (store === null || session === null) {
      this.pendingEvents.push(...turn.events);
      this.pendingDelta.push(...delta);
      return;
    }

    const events = [...this.pendingEvents, ...turn.events];
    const messageDelta = [...this.pendingDelta, ...delta];
    this.pendingEvents = [];
    this.pendingDelta = [];
    if (events.length === 0 && messageDelta.length === 0) return;

    const completedAt = Date.now();
    this.conversationId ??= newConversationId(completedAt, Math.random);

    try {
      await store.appendTurn(
        this.conversationId,
        completedTurn({
          id: turn.id,
          startedAt: turn.startedAt,
          completedAt,
          events,
          messageDelta,
          reason: turn.outcome?.reason ?? null,
        }),
        // The title comes from the whole conversation, not from this turn: the
        // first thing the user said is what names it, and later turns must not
        // rename it out from under them.
        {
          title: titleFrom([...session.history()]),
          updatedAt: completedAt,
          // Which folder this conversation's relative paths mean. Recorded so
          // resuming it a week later resolves them the same way.
          ...(this.boundRoot === null ? {} : { boundRoot: this.boundRoot }),
        },
      );
    } catch (err) {
      // A history that cannot be written must not lose the answer on screen.
      this.log.appendLine(`[hasa] could not save the conversation: ${describe(err)}`);
    }
  }

  newConversation(): void {
    this.session?.clearHistory();
    this.recorded = [];
    this.pendingEvents = [];
    this.pendingDelta = [];
    // Cleared even though `clearHistory` above looks like it covers this: when
    // the gateway was down there is no session to clear, and a conversation
    // opened while it was would otherwise be restored into the new one the
    // moment a session appeared.
    this.pendingRestore = null;
    // A new conversation settles on a folder of its own, on its first turn.
    this.boundRoot = null;
    this.turnOrdinal = 0;
    // A new id, so the next turn starts a new file rather than overwriting the
    // conversation the user just moved away from.
    this.conversationId = null;
  }
}

/**
 * Asks the user, modally.
 *
 * Modal because this is the moment the agent is about to change their files.
 * VS Code reserves modals for decisions that matter, and this is one; a toast
 * that can be missed is a toast that will be.
 */
async function askUser(request: ApprovalRequest): Promise<ApprovalAnswer> {
  const detail = request.preview === null ? undefined : request.preview.slice(0, 1500);
  const ALWAYS = "항상 허용";
  // Two affirmatives, because they are different answers. "허용" is about this
  // action; "항상 허용" is a decision about the tool, and the reason it exists is
  // that the fourth identical dialog in one turn is not read — which makes every
  // later dialog worth less, including the ones that matter.
  const choice = await vscode.window.showWarningMessage(
    request.summary,
    { modal: true, ...(detail === undefined ? {} : { detail }) },
    "허용",
    ALWAYS,
  );
  if (choice === ALWAYS) return "always";
  return choice === "허용";
}

function describe(err: unknown): string {
  if (err instanceof ProviderError) return `${err.code}: ${err.userMessage}`;
  return err instanceof Error ? err.message : String(err);
}
