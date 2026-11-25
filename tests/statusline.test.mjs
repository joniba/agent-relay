import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

import {
  stripControlChars,
  compose,
  resolveName,
} from "../extension/bin/agent-relay-statusline.mjs";
import { aliasFor } from "../extension/identity/local-alias.mjs";
import { createRegisteredNamePublisher, readRegisteredName } from "../extension/storage/registered-name.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "relay-statusline-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const env = { AGENT_RELAY_DATA_DIR: dir };
  const publisher = (sessionId, deps) => {
    const result = createRegisteredNamePublisher({ dir, sessionId, deps });
    t.after(() => result.close());
    return result;
  };
  const snapshot = () => join(
    dir, "registered-names",
    readdirSync(join(dir, "registered-names")).find((name) => name.endsWith(".json")),
  );
  return { dir, env, publisher, snapshot };
}

test("stripControlChars removes C0 controls and DEL", () => {
  assert.equal(stripControlChars("ab\x00c\x1b[31m\x7f"), "abc[31m");
  assert.equal(stripControlChars(42), "");
});

test("compose wraps a name in brackets, empty otherwise", () => {
  assert.equal(compose("stone"), "[stone]");
  assert.equal(compose(""), "");
  assert.equal(compose(null), "");
});

test("resolveName uses distinct registrations when preferred aliases collide", (t) => {
  const f = fixture(t);
  const first = "collision-5";
  const second = "collision-31";
  assert.equal(aliasFor(first), aliasFor(second));
  f.publisher(first).publish("rick");
  f.publisher(second).publish("liam");
  assert.equal(compose(resolveName(first, f.env)), "[rick]");
  assert.equal(compose(resolveName(second, f.env)), "[liam]");
});

test("resolveName does not guess a name before successful registration", (t) => {
  const f = fixture(t);
  const env = { ...f.env, AGENT_RELAY_NAME: "alice" };
  assert.equal(resolveName("sess-1", env), null);
  const publisher = f.publisher("sess-1");
  assert.equal(resolveName("sess-1", env), null);
  publisher.publish("alice");
  assert.equal(resolveName("sess-1", env), "alice");
  assert.equal(resolveName("sess-1", { ...env, AGENT_RELAY_NAME: "outdated" }), "alice");
});

test("a reconnect hides the old name, then publishes the new registration", (t) => {
  const f = fixture(t);
  const old = f.publisher("sess-1");
  old.publish("rick");
  const current = f.publisher("sess-1");
  assert.equal(resolveName("sess-1", f.env), null);
  current.publish("liam");
  old.publish("obsolete");
  assert.equal(resolveName("sess-1", f.env), "liam", "old callbacks must not replace the new name");
  old.close();
  assert.equal(resolveName("sess-1", f.env), "liam", "old teardown must not clear the new name");
  current.close();
  assert.equal(resolveName("sess-1", f.env), null);
  assert.throws(() => current.publish("rick"), /closed/);
});

test("a failed alias update invalidates the old name and the lease refresh retries", (t) => {
  const f = fixture(t);
  let fail = false;
  let refresh;
  const publisher = f.publisher("sess-1", {
    fs: {
      ...fs,
      renameSync: (...args) => {
        if (fail) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        fs.renameSync(...args);
      },
    },
    setInterval: (callback) => { refresh = callback; return {}; },
    clearInterval: () => {},
  });
  publisher.publish("rick");
  fail = true;
  assert.throws(() => publisher.publish("liam"), /disk full/);
  assert.equal(resolveName("sess-1", f.env), null);
  fail = false;
  refresh();
  assert.equal(resolveName("sess-1", f.env), "liam");
});

test("expiry bounds stale state even when invalidation fails and the PID is alive", (t) => {
  const f = fixture(t);
  let time = Date.now();
  let fail = false;
  const publisher = f.publisher("sess-1", {
    now: () => time,
    fs: {
      ...fs,
      renameSync: (...args) => {
        if (fail) throw new Error("read-only storage");
        fs.renameSync(...args);
      },
      unlinkSync: (path) => {
        if (fail && path.endsWith(".json")) throw new Error("cannot invalidate");
        fs.unlinkSync(path);
      },
    },
    setInterval: () => ({}), clearInterval: () => {},
  });
  publisher.publish("rick");
  fail = true;
  assert.throws(() => publisher.publish("liam"), /write and invalidation failed/);
  time += 60_000;
  assert.equal(readRegisteredName("sess-1", { dir: f.dir, now: () => time }), null);
  fail = false;
});

test("corrupt, mismatched and unreadable snapshots render nothing", (t) => {
  const f = fixture(t);
  f.publisher("sess-1").publish("rick");
  const path = f.snapshot();
  const record = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...record, sessionId: "another-session" }));
  assert.equal(resolveName("sess-1", f.env), null);
  writeFileSync(path, "{broken");
  assert.equal(resolveName("sess-1", f.env), null);
  const notADirectory = join(f.dir, "not-a-directory");
  writeFileSync(notADirectory, "");
  assert.equal(resolveName("sess-1", { AGENT_RELAY_DATA_DIR: notADirectory }), null);
});

test("a crashed publisher's snapshot is not treated as a live registration", (t) => {
  const f = fixture(t);
  const moduleUrl = new URL("../extension/storage/registered-name.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createRegisteredNamePublisher } from ${JSON.stringify(moduleUrl)};
    createRegisteredNamePublisher({
      dir: ${JSON.stringify(f.dir)}, sessionId: "sess-1",
    }).publish("rick");
  `], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(resolveName("sess-1", f.env), null);
});

test("the command protocol preserves bracket rendering and silent failure", (t) => {
  const f = fixture(t);
  f.publisher("sess-1").publish("liam");
  const script = fileURLToPath(new URL("../extension/bin/agent-relay-statusline.mjs", import.meta.url));
  const run = (input) => spawnSync(process.execPath, [script], {
    input, encoding: "utf8", env: { ...process.env, ...f.env },
  });
  for (const [input, expected] of [
    ['{"session_id":"sess-1"}', "[liam]"],
    ['{"session_id":"unknown"}', ""],
    ["not json", ""],
  ]) {
    const result = run(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
    assert.equal(result.stderr, "");
  }
});

test("resolveName: no session id → null (statusline stays empty)", () => {
  assert.equal(resolveName("", {}), null);
  assert.equal(resolveName(null, {}), null);
  assert.equal(resolveName(undefined, {}), null);
});
