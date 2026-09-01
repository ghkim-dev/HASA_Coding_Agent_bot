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

/**
 * What the designer host may send, on the same terms.
 *
 * The designer panel had none of this: its message was `unknown`, so the view
 * could read `design.recommendations` for a field called `recommendation` and
 * draw nothing, silently, with the host entirely correct. That is the same
 * failure this file already guards for the chat panel, and it was unguarded in
 * the newer one.
 */
type DesignerHostMessage = import("../src/design/designerPanel.ts").DesignerHostMessage;

/** The design itself, so the renderer is bound to the shape the host builds. */
type DesignPayload = import("../../src/design/designerPayload.ts").DesignPayload;

/**
 * What the Arena host may send. Same reason as the two above.
 *
 * Named rather than reusing `HostMessage`: the chat panel and the Arena have
 * different messages that happen to share a type name in their own files, and
 * a global that meant one of them depending on which file you read would be
 * worse than none.
 */
type ArenaHostMessage = import("../src/types.ts").HostMessage;
