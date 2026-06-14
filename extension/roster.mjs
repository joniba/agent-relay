/**
 * Format the reachable-agents roster for the `list_relay_agents` tool output.
 *
 * Pure + presentation-only. Appends a display-only device name when present
 * (e.g. `gull (my-laptop)`), marks the current session, and shows the stable id.
 * The device name is informative metadata only — NEVER used for addressing.
 *
 * @param {Array<{ id: string, name: string, deviceName?: string, self?: boolean }>} agents
 * @returns {string} one line per agent
 */
export function formatRoster(agents) {
  return agents
    .map(
      (a) =>
        `- ${a.name}` +
        `${a.deviceName ? ` (${a.deviceName})` : ""}` +
        `${a.self ? " (you)" : ""}` +
        `  [id: ${a.id}]`,
    )
    .join("\n");
}
