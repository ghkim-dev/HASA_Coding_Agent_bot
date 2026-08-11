import { createHasaProvider } from "../provider/hasa/createProvider.ts";
import { createModelFor } from "../agent/hasaModel.ts";
import { canConverse, type Modality } from "../provider/hasa/hasaCatalog.ts";
import { protocolFor } from "../agent/autoModel.ts";
import type { ProviderModel } from "../provider/types.ts";
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
      return { models: [], unavailable: "The gateway did not answer." };
    }
    if (validation.credentialValid === false) {
      return { models: [], unavailable: "The gateway rejected the credential." };
    }
    const listing = await provider.listModels();
    // Whatever the catalogue offers, in its order. Chat-capable only: an
    // embedding endpoint cannot hold a conversation and scoring it as though it
    // failed one would be a measurement of the wrong thing.
    const usable = listing.models
      .filter((m) => canConverse(modalityOf(m)) && protocolFor(m.capabilities) !== null)
      .slice(0, opts.limit ?? 3);
    if (usable.length === 0) {
      return { models: [], unavailable: "The gateway offers no model that can hold a conversation." };
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
      unavailable: null,
    };
  } catch (err) {
    return { models: [], unavailable: `Could not reach the gateway: ${(err as Error).message}` };
  }
}

/** A model's modality, defaulting to text when the catalogue does not say. */
function modalityOf(model: ProviderModel): Modality {
  const value = (model as { modality?: string }).modality;
  return (value ?? "text") as Modality;
}
