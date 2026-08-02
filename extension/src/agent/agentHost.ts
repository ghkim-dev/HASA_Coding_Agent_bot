import * as vscode from "vscode";
import { AgentSession } from "../../../src/agent/session.ts";
import { createModelFor } from "../../../src/agent/hasaModel.ts";
import { chooseModel, protocolFor, type AutoModelChoice } from "../../../src/agent/autoModel.ts";
import type { AgentEvent, AgentMode, AgentTurnResult, ApprovalRequest } from "../../../src/agent/types.ts";
import type { HasaProvider } from "../../../src/provider/hasa/hasaProvider.ts";
import { createHasaProvider } from "../../../src/provider/hasa/createProvider.ts";
import { describeVerification, verifyModels } from "../../../src/provider/hasa/verifyModels.ts";
import { FileModelCache } from "../../../src/provider/modelCache.ts";
import { ProviderError } from "../../../src/provider/errors.ts";
import type { ModelListing, ProviderValidation } from "../../../src/provider/types.ts";
import type { CommandSpec } from "../../../src/protocol/index.ts";
import type { RuntimeGap } from "../../../src/agent/discoverCommands.ts";
import { HasaCatalog } from "../../../src/provider/hasa/hasaCatalog.ts";
import { createMediaTransport } from "../../../src/provider/hasa/hasaMediaTransport.ts";
import type { AgentSessionOptions } from "../../../src/agent/session.ts";
import { discoverCommands } from "./commands.ts";

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

export interface ConnectionState {
  hasApiKey: boolean;
  connected: boolean;
  detail: string;
  modelCount: number;
  usableModelId: string | null;
}

export class AgentHost {
  private readonly context: vscode.ExtensionContext;
  private readonly log: vscode.OutputChannel;
  private provider: HasaProvider | null = null;
  private session: AgentSession | null = null;
  private validation: ProviderValidation | null = null;
  private selectedModelId: string | null = null;
  private autoChoice: AutoModelChoice | null = null;
  private catalog: HasaCatalog | null = null;
  private mode: AgentMode = "code";
  private running: AbortController | null = null;

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
    return this.autoChoice === null ? "✨ Auto" : `✨ Auto · ${this.autoChoice.modelId}`;
  }

  selectModel(modelId: string | null): void {
    this.selectedModelId = modelId;
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
    // The catalogue and the media endpoints hang off the origin, not off `/v1`.
    const origin = (configured.length > 0 ? configured : "https://open.hasa.re.kr/v1").replace(/\/v1\/?$/, "");

    const transport = createMediaTransport({ origin, apiKey: key });
    this.catalog ??= new HasaCatalog(transport);

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
    const listing = await provider.listModels({ refresh: true });

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

  private async ensureSession(onEvent: (event: AgentEvent) => void): Promise<AgentSession | null> {
    const provider = await this.ensureProvider();
    if (provider === null) return null;

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder === undefined) return null;

    const choice = await this.resolveModel(provider);
    if (choice === null) return null;

    if (this.session !== null) {
      this.session.setMode(this.mode);
      return this.session;
    }

    // The measured output ceiling, when there is one. Without it the gateway
    // applies its own default, and for a model with a small context that
    // default is larger than the model can accept — a 400 before any work
    // begins, observed on granite-guardian-3.1-8b.
    const limits = await provider.capabilities.limitsOf(choice.modelId);

    this.session = await AgentSession.open({
      workspaceRoot: folder.uri.fsPath,
      model: createModelFor({
        provider,
        modelId: choice.modelId,
        toolProtocol: choice.toolProtocol,
        ...(limits.maxOutputTokens === null ? {} : { maxOutputTokens: limits.maxOutputTokens }),
      }),
      approvalPort: { request: (request) => askUser(request) },
      mode: this.mode,
      approvalMode: vscode.workspace
        .getConfiguration("hasaAgent")
        .get<"safe" | "balanced" | "auto">("approvalMode", "safe"),
      ...(await workspaceCommands(folder.uri.fsPath, this.log)),
      ...(await this.mediaTools()),
      onEvent,
    });
    return this.session;
  }

  /** The model to use, and how it will be asked to call tools. */
  private async resolveModel(provider: HasaProvider): Promise<AutoModelChoice | null> {
    if (this.selectedModelId !== null) {
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

    const listing = await provider.listModels();
    const choice = await chooseModel({
      models: listing.models,
      mode: this.mode,
      knownUsableModelId: this.validation?.usableModelId ?? null,
      measure: (id) => provider.capabilities.ensure(id),
    });
    if (choice === null) return null;
    this.autoChoice = choice;
    this.log.appendLine(
      `[hasa] auto model: ${choice.modelId} (${choice.confidence}, ${choice.toolProtocol} tools)`,
    );
    return choice;
  }

  async send(prompt: string, onEvent: (event: AgentEvent) => void): Promise<AgentTurnResult | null> {
    if (this.running !== null) return null;
    const session = await this.ensureSession(onEvent);
    if (session === null) return null;

    // A session created earlier does not carry this turn's event sink, so the
    // loop is given one per turn through the session's own callback.
    const controller = new AbortController();
    this.running = controller;
    try {
      return await session.send(prompt, controller.signal);
    } finally {
      this.running = null;
    }
  }

  async undo(): Promise<boolean> {
    return (await this.session?.undo()) ?? false;
  }

  keep(): void {
    this.session?.keep();
  }

  async changedFiles(): Promise<string[]> {
    return (await this.session?.changedFiles()) ?? [];
  }

  newConversation(): void {
    this.session?.clearHistory();
  }
}

/**
 * Asks the user, modally.
 *
 * Modal because this is the moment the agent is about to change their files.
 * VS Code reserves modals for decisions that matter, and this is one; a toast
 * that can be missed is a toast that will be.
 */
async function askUser(request: ApprovalRequest): Promise<boolean> {
  const detail = request.preview === null ? undefined : request.preview.slice(0, 1500);
  const choice = await vscode.window.showWarningMessage(
    request.summary,
    { modal: true, ...(detail === undefined ? {} : { detail }) },
    "허용",
  );
  return choice === "허용";
}

function describe(err: unknown): string {
  if (err instanceof ProviderError) return `${err.code}: ${err.userMessage}`;
  return err instanceof Error ? err.message : String(err);
}
