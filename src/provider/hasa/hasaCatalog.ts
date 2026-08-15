/**
 * What kind of model each one is.
 *
 * `GET /v1/models` returns ids and nothing else — no type, no modality. So the
 * question "is `Qwen-Image` an image model?" cannot be answered from the
 * OpenAI-compatible surface at all, and the obvious workaround is to read it
 * off the name. §14 of the brief forbids exactly that, and rightly: `Qwen-Image`
 * and `qwen2.5-vl-72b` both say "image" to a substring match and only one of
 * them generates pictures.
 *
 * The gateway publishes the answer at `GET /api/catalog`, unauthenticated, with
 * a `modality` field per model. That is the source used here, so a model added
 * next month routes correctly without an extension release — which is the same
 * rule the chat side already follows.
 *
 * This is deliberately separate from `/v1/models`: the catalogue is the
 * gateway's own web-portal API, not the OpenAI-compatible one, and mixing them
 * would put a non-standard dependency inside the provider that every
 * OpenAI-compatible backend is supposed to satisfy.
 */

export type Modality =
  | "chat"
  | "vision"
  | "image"
  | "video"
  | "audio"
  | "embeddings"
  | "rerank"
  | "safety"
  | "unknown";

const KNOWN: ReadonlySet<string> = new Set([
  "chat",
  "vision",
  "image",
  "video",
  "audio",
  "embeddings",
  "rerank",
  "safety",
]);

/**
 * Modalities served by an endpoint of their own.
 *
 * Taken from the gateway's own routing table rather than reasoned out here:
 * image → `/v1/images/generations`, video → `/v1/videos/generations`,
 * embeddings → `/v1/embeddings`, rerank → `/rerank`, everything else →
 * `/v1/chat/completions`. That "everything else" matters — `granite-guardian`
 * is catalogued as `safety` and answers chat perfectly well, so a list of
 * modalities that *may* converse would have excluded a model that does.
 *
 * `audio` was in that "everything else" and should not have been. The picker
 * offered `whisper-large-v3`, which the catalogue calls available and callable,
 * and `/v1/chat/completions` answers 404 for it — measured 2026-08-03. A
 * speech model is reached the same way an image model is: not by selecting it
 * and typing.
 */
const DEDICATED_ENDPOINT: ReadonlySet<Modality> = new Set<Modality>([
  "image",
  "video",
  "embeddings",
  "rerank",
  "audio",
]);

/**
 * Whether this model can hold the conversation.
 *
 * A user who wants a picture reasonably reaches for the image model, and the
 * picker used to let them: selecting `Qwen-Image` sent the turn to
 * `/v1/chat/completions`, which answers 404 before the agent does anything.
 * Image and video models are reached through the generation tools instead —
 * the user asks for a picture and the agent uses one.
 *
 * `unknown` converses. A catalogue that is unreachable must not empty the
 * picker; not knowing what a model is has to degrade to offering it, not to
 * hiding it.
 */
export function canConverse(modality: Modality): boolean {
  return !DEDICATED_ENDPOINT.has(modality);
}

/**
 * Whether the model picker should offer this model for conversation.
 *
 * Three ways to be excluded, and they are three different claims:
 *
 *   - the modality has an endpoint of its own, so chat would 404;
 *   - the catalogue says the model is not `available`, so it is announced
 *     rather than running;
 *   - the catalogue says this key class may not call it.
 *
 * Only the first was being checked. `tts-ko` is catalogued `unavailable` and
 * `callable: false` and was offered anyway — selecting it produced
 * `403 model_not_on_key`, a permissions error for a model the gateway had
 * already said was not callable. The media path has always consulted both
 * fields (`byModality`); the conversation path did not, and that asymmetry was
 * the bug rather than any single missing check.
 *
 * A model with no catalogue entry is offered. The picker's list comes from
 * `/v1/models` and the catalogue only annotates it, so a model present in one
 * and absent from the other must not vanish — and an unreachable catalogue must
 * degrade to offering everything rather than to an empty picker.
 */
export function offerForConversation(entry: CatalogEntry | null | undefined): boolean {
  if (entry === null || entry === undefined) return true;
  if (!canConverse(entry.modality)) return false;
  return entry.available && entry.callable;
}

export interface CatalogEntry {
  id: string;
  modality: Modality;
  /** Human label from the gateway, for the picker. */
  title: string | null;
  /** `available` means it can be called now; `listed` means announced only. */
  available: boolean;
  /** Whether this key class may call it, when the catalogue says. */
  callable: boolean;
  /** Generation parameters, for video. Shape is the gateway's, kept verbatim. */
  videoSpec: VideoSpec | null;
}

export interface VideoSpec {
  fps: number;
  maxSeconds: number;
  maxFrames: number;
  frameAlign: number;
  sizes: string[];
  audio: boolean;
  /** Rough seconds of compute per second of output. Used to warn, not to time out. */
  genTimePerSecond: number;
  defaultSeconds: number;
}

export interface CatalogPort {
  /** GETs a catalogue path and returns parsed JSON, or throws. */
  fetchJson: (path: string) => Promise<unknown>;
}

function readModality(value: unknown): Modality {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  return KNOWN.has(text) ? (text as Modality) : "unknown";
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Reads a `video_spec` object, keeping the gateway's numbers rather than ours. */
export function readVideoSpec(value: unknown): VideoSpec | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const sizes = Array.isArray(raw["sizes"])
    ? raw["sizes"].filter((s): s is string => typeof s === "string" && /^\d+x\d+$/.test(s))
    : [];
  if (sizes.length === 0) return null;

  const fps = num(raw["fps"], 0);
  if (fps <= 0) return null;

  const maxSeconds = num(raw["max_seconds"], 0);
  return {
    fps,
    maxSeconds: maxSeconds > 0 ? maxSeconds : 10,
    maxFrames: num(raw["max_frames"], Math.round((maxSeconds > 0 ? maxSeconds : 10) * fps)),
    frameAlign: Math.max(1, num(raw["frame_align"], 1)),
    sizes,
    audio: raw["audio"] === true,
    genTimePerSecond: num(raw["gen_time_per_sec"], 25),
    defaultSeconds: num(raw["default_seconds"], Math.min(5, maxSeconds > 0 ? maxSeconds : 5)),
  };
}

function readEntry(value: unknown): CatalogEntry | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  // `name` is the id used on the wire; `id` is the catalogue's own row key and
  // is not what `/v1/chat/completions` accepts.
  const id = typeof raw["name"] === "string" ? raw["name"] : null;
  if (id === null || id.length === 0) return null;

  return {
    id,
    modality: readModality(raw["modality"]),
    title: typeof raw["title"] === "string" && raw["title"].length > 0 ? raw["title"] : null,
    available: raw["status"] === "available",
    // Absent means unknown rather than forbidden: a catalogue that stops
    // publishing the field should not silently hide every model.
    callable: raw["callable"] !== false,
    videoSpec: readVideoSpec(raw["video_spec"]),
  };
}

/** Pulls the entries out of whatever envelope the catalogue uses. */
export function parseCatalog(payload: unknown): CatalogEntry[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === "object"
      ? ((payload as Record<string, unknown>)["items"] ??
        (payload as Record<string, unknown>)["data"] ??
        (payload as Record<string, unknown>)["models"])
      : null;
  if (!Array.isArray(rows)) return [];

  const seen = new Set<string>();
  const out: CatalogEntry[] = [];
  for (const row of rows) {
    const entry = readEntry(row);
    if (entry === null || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

/**
 * The catalogue, fetched once and remembered.
 *
 * Degrades to an empty catalogue rather than throwing. Not knowing a model's
 * modality costs the media tools; it must not cost the chat path, which worked
 * before this file existed and has to keep working when the portal API is down.
 */
/**
 * How long a catalogue answer is treated as current.
 *
 * Five minutes rather than a process lifetime. The catalogue used to be fetched
 * once and held until the extension host restarted, and the cost of that was
 * measured rather than imagined: the key's model access went from four models
 * to thirty-four in thirteen days, and one model was withdrawn entirely, while
 * anything holding a `HasaCatalog` kept answering from the first fetch.
 *
 * Short enough that a model added or withdrawn during a session is picked up
 * without anyone restarting; long enough that a burst of calls in one turn
 * makes one request.
 */
export const CATALOG_TTL_MS = 5 * 60 * 1000;

export class HasaCatalog {
  private readonly port: CatalogPort;
  /** The resolved answer, when there is one within its TTL. */
  private cached: CatalogEntry[] | null = null;
  /**
   * A fetch already on the wire.
   *
   * Held separately from `cached` because the two answer different questions,
   * and collapsing them is what broke concurrency: with only a resolved value
   * to check, three calls in the same tick all saw "nothing cached" and each
   * started its own request.
   */
  private pending: Promise<CatalogEntry[]> | null = null;
  private fetchedAt = 0;
  private readonly ttlMs: number;
  private readonly now: () => number;
  /**
   * Incremented by every `invalidate`.
   *
   * A fetch in flight when the catalogue is invalidated must not be allowed to
   * install its result afterwards: the invalidation happened *because*
   * something changed — a new key, a new provider — and the answer already on
   * the wire is about the old one. The generation is captured before the
   * request and checked before the write, so a late response is discarded
   * rather than becoming the new truth.
   */
  private generation = 0;

  constructor(port: CatalogPort, options: { ttlMs?: number; now?: () => number } = {}) {
    this.port = port;
    this.ttlMs = options.ttlMs ?? CATALOG_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Forgets what was fetched, so a new key or a restarted gateway is re-read.
   *
   * Now also voids any fetch already in flight — see `generation`.
   */
  invalidate(): void {
    this.generation += 1;
    this.cached = null;
    this.pending = null;
    this.fetchedAt = 0;
  }

  /** Whether the held answer is still within its TTL. */
  get fresh(): boolean {
    return this.cached !== null && this.now() - this.fetchedAt < this.ttlMs;
  }

  async all(): Promise<CatalogEntry[]> {
    if (this.fresh && this.cached !== null) return this.cached;
    // A request already on the wire is the answer for everyone who asks while
    // it is in flight; three lookups in one tick make one request.
    if (this.pending !== null) return this.pending;

    const generation = this.generation;
    const pending = this.port
      .fetchJson("/api/catalog")
      .then(parseCatalog)
      .then((parsed) => {
        // Only if nothing invalidated us while this was in flight. An answer
        // that arrived after a key change describes the old key.
        if (generation === this.generation) {
          this.cached = parsed;
          this.fetchedAt = this.now();
        }
        return parsed;
      })
      .catch(() => {
        // A failure is not cached. It used to be: `[]` was stored and every
        // later call answered "the gateway offers nothing" for the rest of the
        // process, so one bad minute became a permanently empty picker.
        return [] as CatalogEntry[];
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      });

    this.pending = pending;
    const result = await pending;
    // A response that arrived after an invalidation belongs to the old world.
    return generation === this.generation ? result : this.all();
  }

  async entry(modelId: string): Promise<CatalogEntry | null> {
    return (await this.all()).find((e) => e.id === modelId) ?? null;
  }

  async modalityOf(modelId: string): Promise<Modality> {
    return (await this.entry(modelId))?.modality ?? "unknown";
  }

  /** Callable models of one modality, in catalogue order. */
  async byModality(modality: Modality): Promise<CatalogEntry[]> {
    return (await this.all()).filter(
      (e) => e.modality === modality && e.available && e.callable,
    );
  }

  /**
   * The per-model row, which carries `video_spec` that the list does not.
   *
   * Fetched on demand: it is one request per video model actually used, rather
   * than twenty-two to fill in a field almost nothing reads.
   */
  async videoSpec(modelId: string): Promise<VideoSpec | null> {
    const listed = await this.entry(modelId);
    if (listed?.videoSpec != null) return listed.videoSpec;
    try {
      const raw = await this.port.fetchJson(`/api/catalog/${encodeURIComponent(modelId)}`);
      const row =
        raw !== null && typeof raw === "object" && "model" in raw
          ? (raw as { model: unknown }).model
          : raw;
      if (row === null || typeof row !== "object") return null;
      return readVideoSpec((row as Record<string, unknown>)["video_spec"]);
    } catch {
      return null;
    }
  }

}
