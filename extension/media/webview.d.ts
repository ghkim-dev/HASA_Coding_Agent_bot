/**
 * What VS Code puts in a webview's global scope.
 *
 * Declared rather than imported: `@types/vscode` describes the extension host,
 * which is the other side of the boundary. The webview gets exactly this one
 * function and nothing else — no `require`, no `process`, no filesystem — and
 * writing that down is part of the point.
 */
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

/**
 * What the host may send, as a global type.
 *
 * Declared here rather than with a `@typedef {import(...)}` in the panel itself
 * because `extensionBoundary.test.ts` forbids the substring `import(` in any
 * webview *script* — dynamic import is a way to load code, and a scan that has
 * to tell a type-only one from a real one is a scan that will eventually get it
 * wrong. A `.d.ts` is not a script and is not scanned, so the type arrives
 * without the panel ever writing the word.
 *
 * No top-level import/export in this file, which is what keeps it a global
 * script rather than a module — the declarations above would otherwise be
 * scoped to it and invisible to `chat.js`.
 */
type HostMessage = import("../src/agent/chatPanel.ts").HostMessage;
