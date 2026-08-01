"use strict";

const { join, resolve } = require("node:path");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");
const { runTests } = require("@vscode/test-electron");

/**
 * Runs the extension host checks in a real VS Code.
 *
 * Equivalent to pressing F5 and then doing something, except that it exits with
 * a status instead of needing someone to look at a window. It reuses the VS
 * Code already installed rather than downloading another copy, and it runs
 * against a throwaway user profile so nothing touches the developer's own
 * settings, extensions or stored secrets.
 */
async function main() {
  const extensionRoot = resolve(__dirname, "..");

  // VS Code sets these for anything it spawns, and they are inherited all the
  // way down. `ELECTRON_RUN_AS_NODE=1` makes the VS Code we are about to launch
  // start as a bare Node process, which then rejects every VS Code flag with
  // "bad option" and exits 9. The others point the new instance at the running
  // one's IPC socket and locale bundle.
  for (const leaked of Object.keys(process.env)) {
    if (leaked === "ELECTRON_RUN_AS_NODE" || leaked.startsWith("VSCODE_")) {
      delete process.env[leaked];
    }
  }

  const profile = mkdtempSync(join(tmpdir(), "hasa-exthost-"));
  const workspace = join(profile, "workspace");
  mkdirSync(workspace, { recursive: true });
  // A folder with something in it: the agent refuses to run without one, and a
  // package.json is what command discovery reads.
  writeFileSync(join(workspace, "greet.js"), "export function greet(n){ return 'Hello, ' + n; }\n");
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "probe", scripts: { test: "node --test" } }));

  await runTests({
    extensionDevelopmentPath: extensionRoot,
    extensionTestsPath: resolve(__dirname, "suite", "index.js"),
    launchArgs: [
      // `--folder-uri` rather than a positional path: in test mode a bare path
      // is handed to Electron as the entry module and the run dies with
      // "Cannot find module" before VS Code starts.
      `--folder-uri=${pathToFileURL(workspace).toString()}`,
      `--user-data-dir=${join(profile, "user-data")}`,
      `--extensions-dir=${join(profile, "extensions")}`,
      // Other extensions are noise here, and one of them crashing would read as
      // ours failing.
      "--disable-extensions",
      "--disable-gpu",
    ],
  });
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
