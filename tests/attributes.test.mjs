import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { createSqlitePollTransport } from "../extension/transports/sqlite-poll.mjs";
import { createNoneCredentials } from "../extension/credentials/none.mjs";
import { formatRoster } from "../extension/roster.mjs";
import { createRelay } from "../extension/core/relay.mjs";

const credentials = createNoneCredentials();

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "agent-relay-attr-"));
  return { dbPath: join(dir, "relay.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Bring a transport up as `self`, ready to use. */
async function up(dbPath, self) {
  const t = createSqlitePollTransport({ dbPath });
  await t.init({ self, credentials });
  await t.register(self);
  return t;
}

const me = { id: "s-me", name: "loon" };
const other = { id: "s-other", name: "gull" };

// ─── round-trip ──────────────────────────────────────────────────

test("attributes supplied at register are returned by listAgents", async () => {
  const { dbPath, cleanup } = tempDb();
  const t = await up(dbPath, { ...me, attributes: { machine: "box-a", "role.owner": "2026-01-01" } });
  try {
    const [agent] = await t.listAgents();
    assert.deepEqual(agent.attributes, { machine: "box-a", "role.owner": "2026-01-01" });
  } finally {
    await t.stop();
    cleanup();
  }
});

test("a session publishing nothing carries no attributes bag at all", async () => {
  const { dbPath, cleanup } = tempDb();
  const t = await up(dbPath, { ...me });
  try {
    const [agent] = await t.listAgents();
    assert.deepEqual(agent, { id: "s-me", name: "loon" });
  } finally {
    await t.stop();
    cleanup();
  }
});

// ─── PATCH semantics ─────────────────────────────────────────────

test("setAttributes PATCHes: unsent keys are left alone", async () => {
  const { dbPath, cleanup } = tempDb();
  const t = await up(dbPath, { ...me, attributes: { a: "1", b: "2" } });
  try {
    const res = await t.setAttributes({ attributes: { b: "changed", c: "3" } });
    assert.equal(res.ok, true);
    assert.deepEqual(res.attributes, { a: "1", b: "changed", c: "3" });
  } finally {
    await t.stop();
    cleanup();
  }
});

test("a null value REMOVES the key and is never stored", async () => {
  const { dbPath, cleanup } = tempDb();
  const t = await up(dbPath, { ...me, attributes: { keep: "yes", drop: "soon" } });
  try {
    const res = await t.setAttributes({ attributes: { drop: null } });
    assert.deepEqual(res.attributes, { keep: "yes" });
    assert.ok(!("drop" in res.attributes), "the key must be gone, not set to null");

    // And nothing literal made it to disk either.
    const raw = new DatabaseSync(dbPath);
    try {
      const stored = raw.prepare("SELECT attributes FROM agents WHERE id = ?").get("s-me");
      assert.doesNotMatch(stored.attributes, /null/);
    } finally {
      raw.close();
    }
  } finally {
    await t.stop();
    cleanup();
  }
});

test("setAttributes rejects a non-object payload", async () => {
  const { dbPath, cleanup } = tempDb();
  const t = await up(dbPath, { ...me });
  try {
    for (const bad of ["nope", 42, null, ["a"]]) {
      const res = await t.setAttributes({ attributes: bad });
      assert.equal(res.ok, false);
      assert.match(res.error, /must be an object/);
    }
  } finally {
    await t.stop();
    cleanup();
  }
});

// ─── the force gate ──────────────────────────────────────────────

test("writing ANOTHER session's attributes is refused without force, allowed with it", async () => {
  const { dbPath, cleanup } = tempDb();
  const mine = await up(dbPath, { ...me });
  const theirs = await up(dbPath, { ...other });
  try {
    const refused = await mine.setAttributes({ id: other.id, attributes: { "role.owner": "x" } });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /without force/);

    const forced = await mine.setAttributes({ id: other.id, attributes: { "role.owner": "x" }, force: true });
    assert.equal(forced.ok, true);
    assert.deepEqual(forced.attributes, { "role.owner": "x" });
  } finally {
    await mine.stop();
    await theirs.stop();
    cleanup();
  }
});

test("writing your OWN attributes never consults force", async () => {
  const { dbPath, cleanup } = tempDb();
  const t = await up(dbPath, { ...me });
  try {
    const res = await t.setAttributes({ id: me.id, attributes: { mine: "yes" } });
    assert.equal(res.ok, true);
  } finally {
    await t.stop();
    cleanup();
  }
});

test("setAttributes on an unknown agent fails rather than silently doing nothing", async () => {
  const { dbPath, cleanup } = tempDb();
  const t = await up(dbPath, { ...me });
  try {
    const res = await t.setAttributes({ id: "ghost", attributes: { a: "1" }, force: true });
    assert.equal(res.ok, false);
    assert.match(res.error, /no such agent: ghost/);
  } finally {
    await t.stop();
    cleanup();
  }
});

// ─── concurrency: the reason the merge is done in the DB ─────────

test("two writers patching DIFFERENT keys do not clobber each other", async () => {
  // A JavaScript read-modify-write of the whole bag would lose one of these, which
  // is exactly what one-key-per-fact exists to prevent.
  const { dbPath, cleanup } = tempDb();
  const a = await up(dbPath, { ...me });
  const b = await up(dbPath, { ...other });
  try {
    await Promise.all([
      a.setAttributes({ id: me.id, attributes: { "role.first": "1" } }),
      b.setAttributes({ id: me.id, attributes: { "role.second": "2" }, force: true }),
    ]);
    const [agent] = (await a.listAgents()).filter((x) => x.id === me.id);
    assert.deepEqual(agent.attributes, { "role.first": "1", "role.second": "2" });
  } finally {
    await a.stop();
    await b.stop();
    cleanup();
  }
});

// ─── re-registration must MERGE, not replace ─────────────────────

test("re-registering WITHOUT attributes leaves the stored ones intact", async () => {
  // This is the resume path. A resuming session supplies no attributes -- they live
  // in the store, not in its configuration -- so replacing would erase everything it
  // had published, before anything had a chance to notice.
  const { dbPath, cleanup } = tempDb();
  const t = await up(dbPath, { ...me, attributes: { "role.owner": "2026-01-01" } });
  try {
    await t.register({ ...me }); // no attributes, as on resume
    const [agent] = await t.listAgents();
    assert.deepEqual(agent.attributes, { "role.owner": "2026-01-01" });
  } finally {
    await t.stop();
    cleanup();
  }
});

test("re-registering WITH attributes merges them onto what is already stored", async () => {
  const { dbPath, cleanup } = tempDb();
  const t = await up(dbPath, { ...me, attributes: { a: "1" } });
  try {
    await t.register({ ...me, attributes: { b: "2" } });
    const [agent] = await t.listAgents();
    assert.deepEqual(agent.attributes, { a: "1", b: "2" });
  } finally {
    await t.stop();
    cleanup();
  }
});

test("registered_at survives re-registration", async () => {
  const { dbPath, cleanup } = tempDb();
  const t = await up(dbPath, { ...me });
  try {
    const read = () => {
      const db = new DatabaseSync(dbPath);
      try {
        return db.prepare("SELECT registered_at FROM agents WHERE id=?").get("s-me").registered_at;
      } finally {
        db.close();
      }
    };
    const first = read();
    await new Promise((r) => setTimeout(r, 5));
    await t.register({ ...me });
    assert.equal(read(), first);
  } finally {
    await t.stop();
    cleanup();
  }
});

// ─── upgrading a database created before attributes existed ──────

test("an existing database created WITHOUT the attributes column is upgraded in place", async () => {
  // The installer deliberately preserves the runtime DB across upgrades, and
  // CREATE TABLE IF NOT EXISTS will not add a column to a table that already exists.
  // Without the guarded ALTER TABLE this is the case that breaks every real install
  // while every test on a fresh temp database passes.
  const { dbPath, cleanup } = tempDb();

  // Build the exact pre-attributes schema, populated.
  const old = new DatabaseSync(dbPath);
  old.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      registered_at TEXT NOT NULL, last_heartbeat TEXT NOT NULL
    )`);
  old.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, from_name TEXT NOT NULL, to_target TEXT NOT NULL,
      recipient_id TEXT NOT NULL, body TEXT NOT NULL, ts TEXT NOT NULL,
      in_reply_to TEXT, meta TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0
    )`);
  const then = "2020-01-01T00:00:00.000Z";
  const soon = new Date().toISOString();
  old.prepare("INSERT INTO agents VALUES (?,?,?,?)").run("s-old", "heron", then, soon);
  old.prepare("INSERT INTO messages (id,from_name,to_target,recipient_id,body,ts,meta) VALUES (?,?,?,?,?,?,?)")
    .run("m-1", "heron", "loon", "s-old", "hello from before", then, "{}");
  old.close();

  const t = await up(dbPath, { ...me, attributes: { fresh: "yes" } });
  try {
    const db = new DatabaseSync(dbPath);
    try {
      // The pre-existing row survived, timestamps and all.
      const kept = db.prepare("SELECT * FROM agents WHERE id = ?").get("s-old");
      assert.equal(kept.name, "heron");
      assert.equal(kept.registered_at, then);
      // Its attributes default rather than being null, so reads don't need a special case.
      assert.equal(kept.attributes, "{}");

      // Messages are untouched.
      const msg = db.prepare("SELECT body FROM messages WHERE id = ?").get("m-1");
      assert.equal(msg.body, "hello from before");

      // And the new column actually works.
      const mine = db.prepare("SELECT attributes FROM agents WHERE id = ?").get("s-me");
      assert.deepEqual(JSON.parse(mine.attributes), { fresh: "yes" });
    } finally {
      db.close();
    }
  } finally {
    await t.stop();
    cleanup();
  }
});

test("bringing the transport up twice does not fail on the already-added column", async () => {
  const { dbPath, cleanup } = tempDb();
  const first = await up(dbPath, { ...me });
  await first.stop();
  const second = await up(dbPath, { ...me }); // ALTER TABLE would throw if not guarded
  try {
    assert.equal((await second.listAgents()).length, 1);
  } finally {
    await second.stop();
    cleanup();
  }
});

// ─── roster rendering ────────────────────────────────────────────

test("formatRoster groups dotted keys and drops their values", async () => {
  const line = formatRoster([
    {
      id: "s1",
      name: "loon",
      attributes: { machine: "box-a", "role.owner": "2026-01-01", "role.reviewer": "2026-02-02" },
    },
  ]);
  assert.match(line, /machine=box-a/);
  assert.match(line, /role: owner, reviewer/);
  // The timestamps are context nobody asked the roster for; they stay on the API.
  assert.doesNotMatch(line, /2026-01-01/);
});

test("formatRoster leaves undotted keys as key=value, sorted", () => {
  const line = formatRoster([{ id: "s1", name: "loon", attributes: { repo: "agent-relay", machine: "box-a" } }]);
  assert.match(line, /\(machine=box-a, repo=agent-relay\)/);
});

test("formatRoster treats a leading or trailing dot as an ordinary key, not a namespace", () => {
  const line = formatRoster([{ id: "s1", name: "loon", attributes: { ".odd": "a", "trailing.": "b" } }]);
  assert.match(line, /\.odd=a/);
  assert.match(line, /trailing\.=b/);
});

// ─── hostile column contents ─────────────────────────────────────

test("a corrupt attributes value does not cost the session its relay", async () => {
  // The read path already tolerates this (safeParse). If the WRITE path does not,
  // json_patch raises inside register — so one bad row stops the relay starting at
  // all, on every start, and the installer preserves the db across upgrades.
  const { dbPath, cleanup } = tempDb();
  const t = await up(dbPath, { ...me });
  try {
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE agents SET attributes = ? WHERE id = ?").run("CORRUPT", me.id);
    raw.close();

    const res = await t.setAttributes({ attributes: { "role.owner": "2026-01-01" } });
    assert.equal(res.ok, true, "a patch must survive a bad column value");
    assert.deepEqual(res.attributes, { "role.owner": "2026-01-01" });

    await t.register(me); // the other statement that patches
    const [agent] = await t.listAgents();
    assert.deepEqual(agent.attributes, { "role.owner": "2026-01-01" });
  } finally {
    await t.stop();
    cleanup();
  }
});

test("patching an agent that no longer exists returns a result, never throws", async () => {
  // deregister hard-deletes, and force-writing a peer is what force is FOR, so
  // "patch a peer while it exits" is the intended call racing the intended teardown.
  const { dbPath, cleanup } = tempDb();
  const t = await up(dbPath, { ...me });
  try {
    const res = await t.setAttributes({
      id: "s-gone",
      attributes: { "role.owner": "2026-01-01" },
      force: true,
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /no such agent: s-gone/);
  } finally {
    await t.stop();
    cleanup();
  }
});

test("setAttributes REJECTS an unknown option instead of silently writing self", async () => {
  // Every near-miss for `id` would otherwise be dropped by destructuring, redirecting
  // the write to the caller's own entry and returning ok:true — a wrong write reported
  // as a right one. `force` gives no signal either, since it is fine on a self-write.
  const { dbPath, cleanup } = tempDb();
  const t = await up(dbPath, { ...me });
  try {
    await t.register(other);
    await t.register(me); // re-assert self after registering the peer

    const relay = createRelay({ sink: { wake: async () => {} }, self: me, transport: t, interceptors: [] });
    for (const key of ["sessionId", "to", "target"]) {
      const res = await relay.setAttributes({ [key]: other.id, attributes: { x: "1" }, force: true });
      assert.equal(res.ok, false, `${key} must not be accepted`);
      assert.match(res.error, /unknown setAttributes option/);
    }
    // And the correct spelling still works.
    const ok = await relay.setAttributes({ id: other.id, attributes: { x: "1" }, force: true });
    assert.equal(ok.ok, true);
  } finally {
    await t.stop();
    cleanup();
  }
});
