"use strict";

const assert = require("node:assert/strict");
const vscode = require("vscode");

/**
 * The extension, checked from inside a real VS Code.
 *
 * This is the one part of the repository `pnpm test` cannot execute: it needs
 * an extension host, a webview and a command registry. Everything below runs
 * where those exist, which is the only way to find out whether the thing
 * actually starts — type checking a bundle proves it compiles, not that VS Code
 * will load it.
 *
 * Nothing here talks to HASA. Activation, command registration and the panel
 * are what a launch can get wrong; the gateway is covered by the opt-in
 * integration test.
 */

const EXTENSION_ID = "hasa-arena.hasa-agent-arena";

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    return true;
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err && err.message}`);
    return false;
  }
}

exports.run = async function run() {
  console.log("\nextension host checks\n");
  const results = [];

  const extension =
    vscode.extensions.getExtension(EXTENSION_ID) ??
    vscode.extensions.all.find((e) => e.packageJSON && e.packageJSON.name === "hasa-agent-arena");

  results.push(
    await test("the extension is present", () => {
      assert.ok(extension, "VS Code did not find the extension under development");
    }),
  );

  results.push(
    await test("it activates without throwing", async () => {
      // The bundle is 300 KB of `src/` that has never been loaded by VS Code's
      // Node. If an ESM leftover or a missing external survived bundling, this
      // is where it surfaces.
      assert.ok(extension);
      await extension.activate();
      assert.equal(extension.isActive, true);
    }),
  );

  results.push(
    await test("every contributed command is registered", async () => {
      // A command in package.json that nothing registers fails only when a user
      // picks it from the palette.
      assert.ok(extension);
      const declared = extension.packageJSON.contributes.commands.map((c) => c.command);
      const registered = await vscode.commands.getCommands(true);
      for (const command of declared) {
        assert.ok(registered.includes(command), `${command} is declared but not registered`);
      }
      assert.ok(declared.includes("hasa.chat"), "the agent command must exist");
      assert.ok(declared.includes("hasaArena.compare"), "the Arena command must still exist");
    }),
  );

  results.push(
    await test("opening the chat panel does not throw", async () => {
      // With no key stored, this is the first-run path: the panel opens and
      // asks to connect. It must not depend on a gateway to render.
      await vscode.commands.executeCommand("hasa.chat");
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }),
  );

  results.push(
    await test("opening it twice reveals the same panel rather than stacking", async () => {
      await vscode.commands.executeCommand("hasa.chat");
      await new Promise((resolve) => setTimeout(resolve, 500));
      const chat = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter((tab) => tab.label === "HASA Coding Agent");
      assert.equal(chat.length, 1, `expected one chat tab, found ${chat.length}`);
    }),
  );

  results.push(
    await test("closing the panel and reopening it does not throw", async () => {
      // `panel.webview` does not return undefined once the panel is disposed —
      // its getter throws. So a post after a close was a synchronous exception
      // from a property access, and when it happened inside the error handler
      // the rejection had nowhere left to go: "rejected promise not handled
      // within 1 second: Error: Webview is disposed".
      const rejections = [];
      const onRejection = (reason) => rejections.push(reason);
      process.on("unhandledRejection", onRejection);
      try {
        const chatTabs = () =>
          vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.label === "HASA Coding Agent");

        await vscode.commands.executeCommand("hasa.chat");
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(chatTabs().length, 1, "the panel should be open");

        await vscode.window.tabGroups.close(chatTabs());
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(chatTabs().length, 0, "the panel should be closed");

        // The part with teeth. This command redraws the panel, and the
        // controller used to keep its reference to the closed one — so the
        // redraw reached a disposed webview and the property access threw.
        // Opening and closing alone never posts anything, which is why the
        // first version of this test passed against the unfixed code.
        await vscode.commands.executeCommand("hasa.clearApiKey");
        await new Promise((r) => setTimeout(r, 300));

        // Reopening builds a fresh panel rather than reviving the disposed one.
        await vscode.commands.executeCommand("hasa.chat");
        await new Promise((r) => setTimeout(r, 1500));
        assert.equal(chatTabs().length, 1, "reopening should give exactly one panel");

        const disposed = rejections.filter((r) => String(r && r.message).includes("Webview is disposed"));
        assert.equal(disposed.length, 0, `webview-disposed rejections: ${disposed.length}`);
      } finally {
        process.off("unhandledRejection", onRejection);
      }
    }),
  );

  results.push(
    await test("the settings it contributes are readable with their defaults", () => {
      const config = vscode.workspace.getConfiguration("hasaAgent");
      assert.equal(config.get("approvalMode"), "safe", "safe must be the default");
      assert.equal(config.get("baseUrl"), "", "the gateway is the provider's business by default");
    }),
  );

  results.push(
    await test("no key is stored on a fresh install", async () => {
      // The panel's own state says `hasApiKey: false`; this checks the storage
      // it reads from, since a leftover key would make the first-run path
      // untestable.
      assert.ok(extension);
      const stored = await extension.exports?.secretsProbe?.();
      assert.ok(stored === undefined || stored === null || stored === "");
    }),
  );

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed\n`);
  if (failed > 0) throw new Error(`${failed} extension host check(s) failed`);
};
