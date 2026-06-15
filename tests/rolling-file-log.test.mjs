import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { createRollingFileLog } from "../extension/logging/rolling-file-log.mjs";

const DAY = 24 * 60 * 60 * 1000;

// In-memory fs that records content + birth/mtime from an injected clock, so
// rotation/retention are deterministic without touching the real disk.
function memFs() {
  const files = new Map(); // path -> { content }
  return {
    mkdirSync: () => {},
    existsSync: (p) => files.has(p),
    appendFileSync: (p, data) => {
      const f = files.get(p);
      if (f) f.content += data;
      else files.set(p, { content: data });
    },
    renameSync: (a, b) => {
      files.set(b, files.get(a));
      files.delete(a);
    },
    rmSync: (p) => files.delete(p),
    readFirstChars: (p, n) => {
      const f = files.get(p);
      if (!f) {
        const e = new Error("ENOENT");
        e.code = "ENOENT";
        throw e;
      }
      return f.content.slice(0, n);
    },
    _files: files,
  };
}

const DIR = "/d";
const C = join(DIR, "agent-relay.log");
const R = (n) => join(DIR, `agent-relay.${n}.log`);

test("appends an ISO-timestamped line to the current log", () => {
  let t = 1_700_000_000_000;
  const fs = memFs(() => t);
  const log = createRollingFileLog({ dir: "/d", now: () => t, fs });
  log("hello world");
  const content = fs._files.get(C).content;
  assert.match(content, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z hello world\n$/);
});

test("does NOT rotate while the current file is younger than the window", () => {
  let t = 1_700_000_000_000;
  const fs = memFs(() => t);
  const log = createRollingFileLog({ dir: "/d", now: () => t, fs });
  log("a");
  t += DAY - 1; // just under 24h
  log("b");
  assert.ok(!fs._files.has(R(1)), "no rotation under the window");
  assert.match(fs._files.get(C).content, /a\n.*b\n/s, "both lines in the current file");
});

test("rotates current -> .1 once the window elapses", () => {
  let t = 1_700_000_000_000;
  const fs = memFs(() => t);
  const log = createRollingFileLog({ dir: "/d", now: () => t, fs });
  log("day1");
  t += DAY;
  log("day2");
  assert.match(fs._files.get(R(1)).content, /day1/, "old content moved to .1");
  assert.match(fs._files.get(C).content, /day2/, "new content in the current file");
  assert.ok(!fs._files.has(R(2)), "only one backup so far");
});

test("keeps current + 3 backups; the 4th-oldest is deleted on rollover", () => {
  let t = 1_700_000_000_000;
  const fs = memFs(() => t);
  const log = createRollingFileLog({ dir: "/d", now: () => t, fs });
  for (const line of ["a", "b", "c", "d"]) {
    log(line);
    t += DAY;
  }
  log("e"); // 5th period -> "a" should be gone
  // Present: current(e) + .1(d) .2(c) .3(b); "a" evicted; no .4
  assert.match(fs._files.get(C).content, /e/);
  assert.match(fs._files.get(R(1)).content, /d/);
  assert.match(fs._files.get(R(2)).content, /c/);
  assert.match(fs._files.get(R(3)).content, /b/);
  assert.ok(!fs._files.has(R(4)), "never keeps a 4th backup");
  const everywhere = [...fs._files.values()].map((f) => f.content).join("");
  assert.ok(!everywhere.includes(" a\n"), "the oldest period (a) was evicted");
});

test("resumes the current period across a restart via the first-line timestamp", () => {
  let t = 1_700_000_000_000;
  const fs = memFs();
  createRollingFileLog({ dir: DIR, now: () => t, fs })("first"); // file's first line stamped at t

  t += DAY + 5; // a fresh logger instance (restart) writes >24h after that first line
  createRollingFileLog({ dir: DIR, now: () => t, fs })("second");
  assert.match(fs._files.get(R(1)).content, /first/, "the pre-restart period rotated out");
  assert.match(fs._files.get(C).content, /second/);
});

test("treats an existing log with an unparseable first line as a fresh period", () => {
  let t = 1_700_000_000_000;
  const fs = memFs();
  fs._files.set(C, { content: "not-a-timestamp banana\n" }); // pre-existing junk, no ISO stamp
  const log = createRollingFileLog({ dir: DIR, now: () => t, fs });
  t += 10 * DAY; // far past the window, but the first line carries no resumable timestamp
  log("fresh");
  assert.ok(!fs._files.has(R(1)), "no rotation: the period can't be resumed, so it starts now");
  assert.match(fs._files.get(C).content, /banana[\s\S]*fresh/, "appended to the existing file");
});

test("a filesystem failure never throws (logging is failure-isolated)", () => {
  const throwingFs = {
    mkdirSync: () => {},
    existsSync: () => false,
    appendFileSync: () => {
      throw new Error("EACCES");
    },
    renameSync: () => {},
    rmSync: () => {},
    readFirstChars: () => {
      const e = new Error("ENOENT");
      e.code = "ENOENT";
      throw e;
    },
  };
  const log = createRollingFileLog({ dir: "/d", now: () => 0, fs: throwingFs });
  assert.doesNotThrow(() => log("boom"));
});
