import { basename } from "node:path";

/**
 * Default IdentityProvider: name = launch-folder leaf, id = the Copilot sessionId.
 *
 * Name precedence: explicit `nameOverride` → `AGENT_RELAY_NAME` env → cwd leaf →
 * "agent". The id is always the (stable) session id.
 *
 * @param {{ nameOverride?: string, cwd?: string }} [opts]
 * @returns {import('../seams/identity.mjs').IdentityProvider}
 */
export function createFolderNameIdentity({ nameOverride, cwd } = {}) {
  return {
    async resolve(session) {
      const name =
        nameOverride ||
        process.env.AGENT_RELAY_NAME ||
        basename(cwd || process.cwd()) ||
        "agent";
      return { id: session.sessionId, name };
    },
  };
}
