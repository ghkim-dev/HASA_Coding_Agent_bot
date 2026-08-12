import { createHasaProvider } from "../provider/hasa/createProvider.ts";

const provider = createHasaProvider({
  apiKey: process.env["HASA_API_KEY"] ?? "",
  ...(process.env["HASA_BASE_URL"] ? { baseUrl: process.env["HASA_BASE_URL"] } : {}),
});
const validation = await provider.validate();
process.stdout.write(`reachable=${validation.endpointReachable} credential=${String(validation.credentialValid)} models=${validation.modelCount}\n`);
const listing = await provider.listModels();
for (const m of listing.models.slice(0, 12)) {
  process.stdout.write(`  ${m.id}  chat=${String(m.capabilities.chat)} coding=${String(m.capabilities.coding)}\n`);
}
