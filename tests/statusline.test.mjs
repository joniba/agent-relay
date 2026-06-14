import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  stripControlChars,
  compose,
  lookupName,
} from "../extension/bin/agent-relay-statusline.mjs";

test("stripControlChars removes C0 controls and DEL", () => {
  assert.equal(stripControlChars("ab\x00c\x1b[31m\x7f"), "abc[31m");
  assert.equal(stripControlChars(42), "");
});

test("compose wraps a name in brackets, empty otherwise", () => {
  assert.equal(compose("stone"), "[stone]");
  assert.equal(compose(""), "");
  assert.equal(compose(null), "");
});

test("lookupName returns the registered name for a session id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-sl-"));
  const dbPath = join(dir, "agent-relay.db");
  try {
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, registered_at TEXT, last_heartbeat TEXT)");
    db.prepare("INSERT INTO agents (id, name, registered_at, last_heartbeat) VALUES (?,?,?,?)")
      .run("sess-1", "cedar", "t", "t");
    db.close();

    assert.equal(await lookupName("sess-1", dbPath), "cedar");
    assert.equal(await lookupName("nobody", dbPath), null);
    assert.equal(await lookupName("sess-1", join(dir, "missing.db")), null); // missing DB → null
    assert.equal(await lookupName("", dbPath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
