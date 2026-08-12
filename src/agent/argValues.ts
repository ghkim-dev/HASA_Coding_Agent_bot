/**
 * Reading a tool argument that arrived in a shape nobody promised.
 *
 * The schemas say `steps` and `requirements` are strings, newline-separated,
 * because the text protocol writes parameters as tag bodies and a list has no
 * natural spelling there. Models send arrays anyway — the parameter is called
 * `requirements`, so a list is what a list-shaped name invites, and the models
 * that emit JSON tool calls have no reason to join anything.
 *
 * What happened when they did:
 *
 *     typeof args["requirements"] === "string" ? args["requirements"] : ""
 *
 * An array became an empty string, silently. `record_request` then failed its
 * own validation for having no requirements, so no contract was recorded, so
 * every substantive action for the rest of the turn was deferred by
 * `TURN_CONTRACT_REQUIRED` — a whole turn lost to a type check, with the model
 * having said exactly the right thing.
 *
 * `shellTools.argLines` already did this correctly. This is that rule, in one
 * place, for every caller that reads a list-shaped parameter.
 */

const MAX_ITEMS = 200;

/**
 * A list-shaped argument as lines of text.
 *
 * Accepts what models actually send: the newline-joined string the schema asks
 * for, an array of strings, an array of objects with an obvious text field, and
 * a lone string. Anything else is nothing, because guessing at a shape is how a
 * requirement turns into `[object Object]`.
 */
export function argText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .slice(0, MAX_ITEMS)
      .map((item) => itemText(item))
      .filter((line) => line.length > 0)
      .join("\n");
  }
  if (raw === null || raw === undefined) return "";
  // A single object where a list was expected — one item, not a cast.
  const single = itemText(raw);
  return single;
}

function itemText(item: unknown): string {
  if (typeof item === "string") return item.trim();
  if (typeof item === "number" || typeof item === "boolean") return String(item);
  if (item !== null && typeof item === "object") {
    // The fields a model actually uses when it wraps a list item. `String(obj)`
    // would give "[object Object]", which reads as a requirement and is not one.
    for (const key of ["text", "description", "step", "name", "value", "requirement", "title"]) {
      const value = (item as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
  }
  return "";
}
