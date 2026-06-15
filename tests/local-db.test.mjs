import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateLocalDbOnce } from "../extension/storage/local-db.mjs";

// ── unit tests with injected fakes (no real sqlite/fs) ───────────────────────

function fakeFs(present = []) {
  const files = new Set(present);
  return {
    existsSync: (p) => files.has(p),
    linkSync: (a, b) => {
      if (files.has(b)) {
        const e = new Error("EEXIST: file already exists");
        e.code = "EEXIST";
        throw e;
      }
      files.add(b); // hard link: the temp `a` still exists until rmSync
    },
    rmSync: (p) => files.delete(p),
    _files: files,
  };
}

// A fake DB whose VACUUM INTO "writes" the temp file into the fake fs.
function fakeDb(fs, extraOnExec = () => {}) {
  return {
    _exec: [],
    _closed: false,
    exec(sql) {
      this._exec.push(sql);
      const m = sql.match(/'(.+)'/);
      if (m) fs._files.add(m[1].replace(/''/g, "'"));
      extraOnExec(sql);
    },
    close() {
      this._closed = true;
    },
  };
}

test("migrateLocalDbOnce no-ops (never opens the DB) when the target exists", () => {
  const fs = fakeFs(["/old.db", "/new.db"]);
  let opened = false;
  const moved = migrateLocalDbOnce({
    from: "/old.db",
    to: "/new.db",
    deps: { fs, openDb: () => { opened = true; return fakeDb(fs); } },
  });
  assert.equal(moved, false);
  assert.equal(opened, false);
});

test("migrateLocalDbOnce no-ops when the source is missing", () => {
  const fs = fakeFs([]);
  let opened = false;
  const moved = migrateLocalDbOnce({
    from: "/old.db",
    to: "/new.db",
    deps: { fs, openDb: () => { opened = true; return fakeDb(fs); } },
  });
  assert.equal(moved, false);
  assert.equal(opened, false);
});

test("migrateLocalDbOnce VACUUMs INTO a temp then atomically links into place", () => {
  const fs = fakeFs(["/old.db"]);
  let openedPath = null;
  const db = fakeDb(fs);
  const moved = migrateLocalDbOnce({
    from: "/old.db",
    to: "/new.db",
    deps: { fs, openDb: (p) => { openedPath = p; return db; } },
  });
  assert.equal(moved, true);
  assert.equal(openedPath, "/old.db", "opened the legacy source");
  assert.equal(db._exec.length, 1);
  assert.match(db._exec[0], /^VACUUM INTO '\/new\.db\.migrating-\d+'$/);
  assert.equal(db._closed, true, "source connection closed");
  assert.ok(fs._files.has("/new.db"), "destination created");
  assert.ok(![...fs._files].some((f) => f.includes(".migrating-")), "temp removed after link");
});

test("migrateLocalDbOnce yields + drops its temp if a peer wins the destination mid-VACUUM", () => {
  const fs = fakeFs(["/old.db"]);
  // Simulate a concurrent session finishing its own migration while we VACUUM.
  const db = fakeDb(fs, () => fs._files.add("/new.db"));
  const moved = migrateLocalDbOnce({ from: "/old.db", to: "/new.db", deps: { fs, openDb: () => db } });
  assert.equal(moved, false, "did not claim a destination a peer already created");
  assert.ok(fs._files.has("/new.db"), "peer's DB is kept");
  assert.ok(![...fs._files].some((f) => f.includes(".migrating-")), "our temp is cleaned up");
});

// ── integration: a real SQLite round-trip ────────────────────────────────────

test("migrateLocalDbOnce relocates real SQLite data with no sidecars (integration)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-mig-"));
  const from = join(dir, "old.db");
  const to = join(dir, "new.db");
  try {
    const src = new DatabaseSync(from);
    src.exec("CREATE TABLE t (k TEXT); INSERT INTO t VALUES ('hello')");
    src.close();

    const moved = migrateLocalDbOnce({ from, to });
    assert.equal(moved, true);
    assert.ok(existsSync(to), "destination DB exists");
    assert.ok(!existsSync(to + "-wal") && !existsSync(to + "-shm"), "no WAL/SHM sidecars at destination");

    const dst = new DatabaseSync(to);
    const row = dst.prepare("SELECT k FROM t").get();
    dst.close();
    assert.equal(row.k, "hello", "data survived the relocation");

    // Second call is a no-op now that the destination exists.
    assert.equal(migrateLocalDbOnce({ from, to }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
