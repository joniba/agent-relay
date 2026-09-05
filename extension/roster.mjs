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
 * Render an agent's opaque `attributes` bag as ` (k=v, prefix: a, b)` — BOTH keys and
 * values String-coerced + control-char stripped, empty entries omitted (so it is
 * stable and unforgeable across plugins). Core does NOT interpret any key.
 *
 * Keys sharing a **dotted prefix** are grouped and rendered as `prefix: suffix, suffix`
 * without their values. The rule is purely structural — core still knows nothing about
 * what any key means, it only groups on the dot. The reason is that the roster's reader
 * is usually a model, and the question it answers is "who holds what", not "when was it
 * set": repeating a prefix and a value per entry is context spent on something nobody
 * asked. Values remain available through the API.
 *
 * @param {Record<string, unknown>} [attributes]
 * @returns {string}
 */
function renderAttributes(attributes) {
  if (!attributes || typeof attributes !== "object") return "";
  const plain = [];
  /** @type {Map<string, string[]>} */
  const grouped = new Map();

  for (const rawKey of Object.keys(attributes).sort()) {
    const value = stripControl(attributes[rawKey]);
    const key = stripControl(rawKey);
    if (key === "" || value === "") continue;
    const dot = key.indexOf(".");
    // A leading or trailing dot isn't a namespace, it's just an odd key.
    if (dot > 0 && dot < key.length - 1) {
      const prefix = key.slice(0, dot);
      if (!grouped.has(prefix)) grouped.set(prefix, []);
      grouped.get(prefix).push(key.slice(dot + 1));
    } else {
      plain.push(`${key}=${value}`);
    }
  }

  const parts = plain;
  for (const [prefix, suffixes] of [...grouped].sort(([a], [b]) => (a < b ? -1 : 1))) {
    parts.push(`${prefix}: ${suffixes.join(", ")}`);
  }
  return parts.length ? ` (${parts.join(", ")})` : "";
}
