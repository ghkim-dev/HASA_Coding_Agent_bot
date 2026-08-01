import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Builds the extension.
 *
 * Two things make a bundler necessary rather than convenient.
 *
 * `src/` is ESM and is run by Node's own type stripping — no build, `.ts` in
 * import specifiers, `"type": "module"`. A VS Code extension is CommonJS and is
 * loaded by `require`. Those cannot meet: `require` will not take an ESM module,
 * and VS Code's Node does not strip types. Four separate compiler errors say so.
 *
 * The alternative was to keep the agent in a separate process and talk to it
 * over HTTP. What decided against it is approval: the loop has to stop, ask the
 * user, and wait. Over HTTP that is a correlation protocol with timeouts and a
 * stuck-loop failure mode; in process it is one `await`.
 *
 * This changes nothing about how `src/` is run elsewhere. The CLI, the
 * orchestrator and the tests still execute the TypeScript directly.
 */

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: [join(here, "src", "extension.ts")],
  outfile: join(here, "out", "extension.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  // VS Code 1.90 ships Node 20. Targeting it rather than the repository's Node
  // 24 keeps syntax the extension host can actually parse.
  target: "node20",
  sourcemap: true,
  minify: false,
  // Provided by the host, never bundled.
  external: ["vscode"],
  logLevel: "info",
  // `src/` imports carry `.ts`, which esbuild resolves natively.
  resolveExtensions: [".ts", ".js", ".mjs", ".json"],
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("watching…");
} else {
  await build(options);
}
