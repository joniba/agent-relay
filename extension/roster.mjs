import { stripControl } from "./core/sanitize.mjs";

/**
 * Format the reachable-agents roster for the `list_relay_agents` tool output.
 *
 * Pure + presentation-only. Renders each agent's opaque `attributes` bag (when a
 * transport supplies one) generically — core interprets NO key. Marks the current
 * session and shows the stable id.
 *
 * @param {Array<{ id: string, name: string, attributes?: Record<string, unknown>, self?: boolean }>} agents
 * @returns {string} one line per agent
 */
export function formatRoster(agents) {
  return agents
    .map(
      (a) =>
        `- ${a.name}` +
        `${renderAttributes(a.attributes)}` +
        `${a.self ? " (you)" : ""}` +
        `  [id: ${a.id}]`,
    )
    .join("\n");
}

/**
 * Render an agent's opaque `attributes` bag as ` (k=v, k=v)` — keys sorted
 * alphabetically, BOTH keys and values String-coerced + control-char stripped,
 * empty entries omitted (so it is stable and unforgeable across plugins). Core does
 * NOT interpret any key; a transport/plugin populates them (e.g. `machine`, future
 * `repo`/`role`). Returns "" when there are no usable attributes (bare name).
 *
 * @param {Record<string, unknown>} [attributes]
 * @returns {string}
 */
function renderAttributes(attributes) {
  if (!attributes || typeof attributes !== "object") return "";
  const parts = [];
  for (const rawKey of Object.keys(attributes).sort()) {
    const value = stripControl(attributes[rawKey]);
    const key = stripControl(rawKey);
    if (key === "" || value === "") continue;
    parts.push(`${key}=${value}`);
  }
  return parts.length ? ` (${parts.join(", ")})` : "";
}
