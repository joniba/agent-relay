import { randomUUID } from "node:crypto";

/**
 * A message moving through the relay.
 *
 * Intentionally minimal (F1/F2). `inReplyTo` is reserved for an optional reply
 * reference; threading is parked (see spec/IDEAS.md). Delivery semantics
 * (retention, ordering, dedup) are a transport concern, not encoded here.
 *
 * `meta` is an OPAQUE, transport-preserved key/value bag for cross-cutting
 * concerns that must NOT bloat the core: interceptors may read/write it (hop
 * counts, trust/authority labels, priorities, correlation ids, …) and a
 * conformant transport carries it through untouched. The core never lets `meta`
 * change ROUTING or delivery BEHAVIOR — this is the OCP escape hatch so future
 * guardrails need no core change. (The core does stamp + read ONE diagnostic
 * provenance key — `meta.fromDevice`, the sender's machine — for observability
 * only, e.g. showing the source machine in a `recv` log line; it never affects
 * delivery.)
 *
 * @typedef {object} Message
 * @property {string} id          Unique message id.
 * @property {string} from        Sender's addressable name.
 * @property {string} to          Recipient's name (or id).
 * @property {string} body        Message text.
 * @property {string} ts          ISO-8601 creation timestamp.
 * @property {string} [inReplyTo] Optional id of the message this replies to.
 * @property {Record<string, unknown>} meta  Opaque, transport-preserved metadata.
 */

/**
 * Build a {@link Message} with a fresh id + timestamp.
 *
 * @param {object} fields
 * @param {string} fields.from
 * @param {string} fields.to
 * @param {string} fields.body
 * @param {string} [fields.inReplyTo]
 * @param {Record<string, unknown>} [fields.meta]  Initial opaque metadata.
 * @returns {Message}
 */
export function createMessage({ from, to, body, inReplyTo, meta }) {
  /** @type {Message} */
  const message = {
    id: randomUUID(),
    from,
    to,
    body,
    ts: new Date().toISOString(),
    meta: meta ? { ...meta } : {},
  };
  if (inReplyTo) message.inReplyTo = inReplyTo;
  return message;
}
