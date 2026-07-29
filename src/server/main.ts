import { randomBytes } from "node:crypto";
import { clientFromEnv } from "../hasa-client/client.ts";
import { createLogger } from "../hasa-client/logger.ts";
import { promptsAreLogged } from "../hasa-client/redact.ts";
import { CodeRunManager } from "../core/codeRunManager.ts";
import { EventHub } from "../core/events.ts";
import { ModelRegistry } from "../core/registry.ts";
import { RunManager } from "../core/runManager.ts";
import { getScheduler } from "../core/scheduler.ts";
import { Store } from "../core/store.ts";
import { buildServer } from "./app.ts";

async function main(): Promise<void> {
  const log = createLogger("main");

  if (promptsAreLogged()) {
    log.warn("ARENA_LOG_PROMPTS=1 — full prompts will be written to logs. Development only.");
  }

  const client = clientFromEnv();
  const store = await Store.open({ dbPath: ".arena/arena.db", artifactRoot: ".arena" });
  const hub = new EventHub();
  // One scheduler for the whole process. Never construct one per request.
  const scheduler = getScheduler();
  const runs = new RunManager({ client, scheduler, store, hub, logger: log.child("run") });

  const registry = await ModelRegistry.load();
  const staleness = registry.staleness(Date.now());
  if (staleness.length > 0) {
    log.warn("capability matrix is missing or stale — code runs cannot verify model eligibility", {
      reasons: staleness,
    });
  }
  const codeRuns = new CodeRunManager({
    client,
    scheduler,
    store,
    hub,
    registry,
    logger: log.child("code-run"),
  });

  const token = process.env["ARENA_TOKEN"] ?? randomBytes(24).toString("hex");
  const app = buildServer({ runs, codeRuns, store, hub, logger: log.child("http"), token });

  const port = Number(process.env["ARENA_PORT"] ?? 7801);
  // Loopback only: this process holds the API key, so it must not be reachable
  // from the network. See docs/security-policy.md §4.3.
  const host = process.env["ARENA_HOST"] ?? "127.0.0.1";
  await app.listen({ port, host });

  log.info("orchestrator listening", { url: `http://${host}:${port}`, sqlite: store.sqliteEnabled });
  process.stdout.write(`\nHASA Agent Arena orchestrator\n  http://${host}:${port}\n  x-arena-token: ${token}\n\n`);

  const shutdown = (): void => {
    void app.close().then(() => {
      hub.closeAll();
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
