/**
 * Strip control characters that could forge line breaks / framing when a
 * peer-controlled value is interpolated into rendered output — the wake-prompt
 * header line and the `list_relay_agents` roster. Removes C0 controls + DEL, NEL,
 * and the Unicode line/paragraph separators; leaves ordinary text untouched.
 *
 * This guards the STRUCTURED display fields (sender alias/id, recipient alias,
 * roster attribute keys/values) so a hostile sender name / host / id cannot break
 * its line or forge an extra line. It is deliberately NOT applied to the message
 * BODY — that is free-form untrusted content rendered after a blank line; defending
 * the body against embedded instructions is the job of an opt-in guardrail
 * interceptor, not this renderer.
 *
 * @param {unknown} s
 * @returns {string}
 */
export function stripControl(s) {
  // eslint-disable-next-line no-control-regex
  return String(s ?? "").replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, "");
}
