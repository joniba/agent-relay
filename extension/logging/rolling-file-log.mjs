import { mkdirSync, existsSync, appendFileSync, renameSync, rmSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_LEN = 24; // length of an ISO-8601 timestamp, e.g. "2026-06-15T19:22:16.115Z"

const defaultFs = {
  mkdirSync,
  existsSync,
  appendFileSync,
  renameSync,
  rmSync,
  // Read the first `n` characters of a file without slurping it whole.
  readFirstChars: (path, n) => {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(n);
      const bytes = readSync(fd, buf, 0, n, 0);
      return buf.toString("utf8", 0, bytes);
    } finally {
      closeSync(fd);
    }
  },
};

/**
 * Create a rolling file logger. Appends timestamped lines to
 * `<dir>/agent-relay.log` and, once the current file is older than `rotateAfterMs`,
 * rotates it to numbered backups (`agent-relay.1.log` .. `agent-relay.<keep>.log`),
 * keeping `keep` rolled files plus the current one — the oldest (`.<keep>`) is
 * deleted on rollover.
 *
 * BEST-EFFORT + FAILURE-ISOLATED: every filesystem operation runs under a single
 * try/catch and any error is swallowed, so a logging failure (full disk, EACCES,
 * a sharing violation) can NEVER disrupt the relay. The clock and fs are injectable
 * so rotation/retention are deterministically testable.
 *
 * @param {object} opts
 * @param {string} opts.dir                directory the logs live in (created on demand)
 * @param {number} [opts.rotateAfterMs]    age at which the current file rotates (default 24h)
 * @param {number} [opts.keep]             rolled files retained besides the current (default 3)
 * @param {() => number} [opts.now]        clock seam, ms since epoch (default Date.now)
 * @param {typeof defaultFs} [opts.fs]     fs seam for tests
 * @returns {(line: string) => void}       append one line (an ISO timestamp is prepended)
 */
export function createRollingFileLog({
  dir,
  rotateAfterMs = DAY_MS,
  keep = 3,
  now = Date.now,
  fs = defaultFs,
} = {}) {
  const current = join(dir, "agent-relay.log");
  const rolled = (n) => join(dir, `agent-relay.${n}.log`);
  let periodStart = null; // ms; lazily resolved on first write

  function rotate() {
    if (fs.existsSync(rolled(keep))) fs.rmSync(rolled(keep), { force: true }); // drop the oldest
    for (let n = keep - 1; n >= 1; n--) {
      if (fs.existsSync(rolled(n))) fs.renameSync(rolled(n), rolled(n + 1)); // shift up
    }
    if (fs.existsSync(current)) fs.renameSync(current, rolled(1)); // current -> .1
  }

  return function write(line) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const t = now();
      // Resume an existing period across restarts from the log's own first-line
      // timestamp (deterministic + platform-independent); else start fresh now.
      if (periodStart === null) periodStart = fileStart(fs, current) ?? t;
      if (t - periodStart >= rotateAfterMs) {
        rotate();
        periodStart = t;
      }
      fs.appendFileSync(current, `${new Date(t).toISOString()} ${line}\n`);
    } catch {
      /* logging must never disrupt the relay */
    }
  };
}

function fileStart(fs, path) {
  // The period started when the current file's FIRST line was written — and every
  // line is prefixed with an ISO-8601 timestamp, so the file is self-describing.
  // This avoids relying on filesystem birthtime (unavailable on some Linux setups,
  // where an mtime fallback advances on every append and would starve rotation).
  try {
    if (!fs.existsSync(path)) return null;
    const ms = Date.parse(fs.readFirstChars(path, ISO_LEN));
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}
