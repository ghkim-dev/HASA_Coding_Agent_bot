import { createHasaProvider } from "../provider/hasa/createProvider.ts";
import { createModelFor } from "../agent/hasaModel.ts";
import { HasaCatalog, canConverse } from "../provider/hasa/hasaCatalog.ts";
import { createMediaTransport } from "../provider/hasa/hasaMediaTransport.ts";
import { protocolFor } from "../agent/autoModel.ts";
import { conversabilityFor, fingerprint } from "../router/conversability.ts";
import { poolEffectFor } from "../router/modelSemanticCatalog.ts";
import { DEFAULT_POOL } from "../router/semanticProfile.ts";
import { fakeModel, GOOD, OVERCLAIMER, SLOPPY, STUBBORN } from "./fakeModels.ts";
import type { ModelUnderTest } from "./sweep.ts";

/**
 * Which models there are to compare, asked rather than assumed.
 *
 * No model name appears in this file. The gateway's catalogue is the list, and
 * a hard-coded id would be a benchmark that quietly stops testing the thing it
 * names the day the catalogue changes — while still printing a row for it.
 *
 * When there is no credential there is no list, and that is reported as
 * *not run*. A benchmark that fabricates a row for a model it could not reach
 * is worse than one that ran nothing, because the row looks like a measurement.
 */

/** The calibration models. Always available; never comparable to a real one. */
export function referenceModels(): ModelUnderTest[] {
  return [
    { id: "reference:good", create: (s) => fakeModel(s, GOOD, "reference:good") },
    { id: "reference:sloppy", create: (s) => fakeModel(s, SLOPPY, "reference:sloppy") },
    { id: "reference:stubborn", create: (s) => fakeModel(s, STUBBORN, "reference:stubborn") },
    { id: "reference:overclaimer", create: (s) => fakeModel(s, OVERCLAIMER, "reference:overclaimer") },
  ];
}

export interface LiveModelsResult {
  models: ModelUnderTest[];
  /** Why nothing is here, when nothing is. Printed verbatim in the report. */
  unavailable: string | null;
  /**
   * What was known about chat-capability when the list was chosen.
   *
   * Handed back so the evidence writer can refuse a model this filter should
   * have excluded, rather than trusting that it did.
   */
  conversability: ReadonlyMap<string, boolean>;
}

/**
 * Models from the configured gateway, if there is one.
 *
 * The key is read from the environment and never from a file in the repository.
 * Nothing here writes it anywhere, and no request in a controlled run reaches
 * the gateway except the model call itself — the world is a fixture.
 */
export async function liveModels(opts: { limit?: number } = {}): Promise<LiveModelsResult> {
  const apiKey = process.env["HASA_API_KEY"] ?? process.env["HASA_KEY"] ?? "";
  const baseUrl = process.env["HASA_BASE_URL"] ?? "";
  if (apiKey.trim().length === 0) {
    return {
      models: [],
      conversability: new Map(),
      unavailable: "HASA_API_KEY is not set. Live model evaluation NOT RUN — no credential.",
    };
  }

  try {
    const provider = createHasaProvider({
      apiKey,
      ...(baseUrl.length === 0 ? {} : { baseUrl }),
    });
    const validation = await provider.validate();
    if (!validation.endpointReachable) {
      return { models: [], conversability: new Map(), unavailable: "The gateway did not answer." };
    }
    if (validation.credentialValid === false) {
      return { models: [], conversability: new Map(), unavailable: "The gateway rejected the credential." };
    }
    const listing = await provider.listModels();
    // Chat-capable workers for *this* pool, on the same evidence the router
    // uses — see `conversability` below for what that evidence is and what it
    // replaced, and the pool comment inside the filter for the other half.
    //
    // It matters more here than in a picker because this module feeds
    // `evidence.ts`: a model scored on the wrong scenarios becomes a wrong
    // ranking rather than merely a wrong row in a table.
    const converses = await conversability(apiKey, baseUrl);
    const usable = listing.models
      .filter((m) => {
        if (converses.get(m.id) === false) return false;
        if (protocolFor(m.capabilities) === null) return false;
        // Pool, not role.
        //
        // The first version of this asked `roleIsWorker`, and `roleIsWorker`
        // answers true for `ocr_worker` and `vision_worker` — correctly, because
        // they are workers, in their own pools. The question a coding benchmark
        // has to ask is whether they are workers *here*, and that is
        // `poolEffectFor`, which is why the role and the pool were separated in
        // the first place. Asking the wrong one put `paddleocr-vl` and
        // `qwen2.5-vl-72b` back on the list of models to score on twenty coding
        // scenarios.
        return !poolEffectFor(m.id, DEFAULT_POOL).excluded;
      })
      .slice(0, opts.limit ?? 3);
    if (usable.length === 0) {
      return { models: [], conversability: new Map(), unavailable: "The gateway offers no model that can hold a conversation." };
    }
    return {
      models: usable.map((model) => ({
        id: model.id,
        // The same rule the product applies, from the catalogue's own
        // capabilities rather than from a name. What it does not do is *probe*
        // — that is eleven live requests per model and belongs to the Auto
        // path, not to a benchmark whose cost would then vary per sweep.
        create: () =>
          createModelFor({
            provider,
            modelId: model.id,
            toolProtocol: protocolFor(model.capabilities) ?? "text",
          }),
      })),
      conversability: converses,
      unavailable: null,
    };
  } catch (err) {
    return { models: [], conversability: new Map(), unavailable: `Could not reach the gateway: ${(err as Error).message}` };
  }
}

/**
 * What is known about whether each model serves the chat endpoint.
 *
 * From the two sources that actually have the answer. This used to read a
 * `modality` field off `ProviderModel` through an optional cast —
 *
 *     (model as { modality?: string }).modality ?? "text"
 *
 * — and `ProviderModel` has no such field and never had one, so the expression
 * was `"text"` for every model on every call since it was written. The filter
 * around it looked like a filter and passed everything, which is how a sweep
 * came to score four image-and-video generation models as coding models that
 * failed all twenty scenarios. Those zeroes were about to be written down as
 * evidence.
 *
 * Modality lives in the portal catalogue, not in the gateway's model listing.
 * A failure to reach it yields an empty map — unknown, which keeps a model in
 * rather than letting an outage silently empty the sweep.
 */
async function conversability(apiKey: string, baseUrl: string): Promise<Map<string, boolean>> {
  const known = new Map<string, boolean>();
  try {
    const catalog = new HasaCatalog(
      createMediaTransport({ origin: baseUrl.replace(/\/v1\/?$/, ""), apiKey }),
    );
    for (const entry of await catalog.all()) {
      if (!canConverse(entry.modality) || entry.callable === false) known.set(entry.id, false);
    }
  } catch {
    // Unknown stays unknown. Not "yes".
  }
  // Invocation evidence outranks the catalogue and covers what it declines to
  // classify.
  for (const [id, value] of conversabilityFor({
    baseUrlFingerprint: fingerprint(baseUrl),
    credentialFingerprint: fingerprint(apiKey),
  })) {
    known.set(id, value);
  }
  return known;
}
