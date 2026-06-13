/**
 * Interceptor chain runner + the core's neutral default prompt renderer.
 *
 * The runner threads a message through an ordered list of interceptor hooks
 * using the standard middleware contract: each hook receives `(message, next)`
 * and either calls `next(message)` to continue (optionally transforming the
 * message) or returns without calling `next` to DROP the message.
 *
 * Keeping this isolated (SRP) means the core orchestrator doesn't know how many
 * interceptors exist or what they do — it just runs the chain.
 *
 * @typedef {import('../seams/interceptor.mjs').Interceptor} Interceptor
 * @typedef {import('./message.mjs').Message} Message
 */

/**
 * Run a single hook (`onSend` or `onReceive`) across the interceptor list, in
 * the canonical middleware style: each hook gets `(message, next)`, where
 * `next(msg)` returns the downstream promise. Calling `next` twice is an error.
 *
 * @param {Interceptor[]} interceptors
 * @param {"onSend"|"onReceive"} hook
 * @param {Message} message
 * @returns {Promise<Message|null>} the (possibly transformed) message, or null
 *   if an interceptor dropped it (returned without calling next).
 */
export async function runChain(interceptors, hook, message) {
  let index = -1;
  let result = message; // the message as transformed so far
  let dropped = false;

  /**
   * @param {number} i
   * @param {Message} msg
   * @returns {Promise<void>}
   */
  async function dispatch(i, msg) {
    if (i <= index) throw new Error("next() called multiple times in interceptor chain");
    index = i;
    result = msg;

    const interceptor = interceptors[i];
    if (!interceptor) return; // whole chain traversed
    const fn = interceptor[hook];
    if (typeof fn !== "function") return dispatch(i + 1, msg); // no hook here: pass through

    let called = false;
    let downstream; // the promise next() produced, awaited even if the hook didn't
    await fn(msg, (nextMsg = msg) => {
      called = true;
      downstream = dispatch(i + 1, nextMsg);
      return downstream;
    });
    if (downstream) await downstream; // robust even if the hook fire-and-forgets next()
    if (!called) dropped = true; // hook returned without next() → drop
  }

  await dispatch(0, message);
  return dropped ? null : result;
}

/**
 * The core's neutral default wake-prompt renderer. Strictly minimal (F2):
 * sender + body, with just enough framing for the recipient to recognize a peer
 * message (not a user instruction). NO routing/reply directives — the spike
 * lesson; any such guidance is an opt-in interceptor's `renderPrompt`.
 *
 * @param {Message} message
 * @returns {string}
 */
export function defaultRenderPrompt(message) {
  return `[agent-relay] Message from ${message.from}:\n\n${message.body}`;
}

/**
 * Resolve the wake prompt for a received message: the first interceptor that
 * provides a non-null `renderPrompt` wins; otherwise the core default.
 *
 * @param {Interceptor[]} interceptors
 * @param {Message} message
 * @returns {string}
 */
export function renderPrompt(interceptors, message) {
  for (const interceptor of interceptors) {
    if (typeof interceptor.renderPrompt === "function") {
      const rendered = interceptor.renderPrompt(message);
      if (rendered != null) return rendered;
    }
  }
  return defaultRenderPrompt(message);
}
