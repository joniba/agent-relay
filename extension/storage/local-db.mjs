import { DatabaseSync } from "node:sqlite";
import { existsSync, rmSync, linkSync } from "node:fs";

/**
 * One-time, crash-safe relocation of the local SQLite store to a new path.
 *
 * Uses SQLite's `VACUUM INTO` to produce a transactionally-CONSISTENT single-file
 * copy — safe even if another connection is mid-write, and with NO `-wal`/`-shm`
 * sidecars to carry — written to a temp file that is then atomically renamed into
 * place. Consequences:
 *   - A naive multi-file copy of a live WAL database can capture a torn main file
 *     or a salt-mismatched WAL (losing committed-but-uncheckpointed rows). VACUUM
 *     INTO snapshots one consistent point-in-time image instead.
 *   - The commit is an atomic create-if-absent hard-link (never an overwriting
 *     rename), so a concurrent first-run migration can't clobber a destination a
 *     peer already created. An interruption leaves the destination ABSENT and is
 *     retried on the next boot (no corrupt latch). The success and peer-yield paths
 *     always remove their own temp; only an abrupt crash mid-copy can orphan a
 *     (small, harmless) temp file.
 *
 * No-op (returns false) when the destination already exists or the source is
 * missing. Non-destructive: the legacy file is only read, never moved or deleted,
 * so a rollback to an older build still finds it.
 *
 * @param {object} args
 * @param {string} args.from   legacy DB path (read-only source)
 * @param {string} args.to     canonical destination path
 * @param {object} [args.deps] test seam: { fs, openDb }
 * @param {{ existsSync: Function, renameSync: Function, rmSync: Function }} [args.deps.fs]
 * @param {(path: string) => { exec: Function, close: Function }} [args.deps.openDb]
 * @returns {boolean} true iff it relocated the DB on this call
 */
export function migrateLocalDbOnce({ from, to, deps = {} }) {
  const fs = deps.fs ?? { existsSync, rmSync, linkSync };
  const openDb = deps.openDb ?? ((path) => new DatabaseSync(path));

  if (fs.existsSync(to)) return false; // already migrated (or a fresh DB was created)
  if (!fs.existsSync(from)) return false; // nothing legacy to relocate

  const tmp = `${to}.migrating-${process.pid}`;
  if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true }); // clear our own prior temp

  const db = openDb(from);
  try {
    // SQLite string literal: escape embedded single quotes (backslashes are literal).
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  try {
    // Atomic create-if-absent commit: linkSync throws EEXIST if a peer already
    // created `to`, so a concurrent first-run migration can never clobber it (a
    // plain rename would silently overwrite). tmp and to share a directory, so the
    // hard link is always same-volume.
    fs.linkSync(tmp, to);
    return true;
  } catch (err) {
    if (err && err.code === "EEXIST") return false; // a peer won the destination
    throw err;
  } finally {
    // Drop our temp on every handled outcome; the hard-linked `to` survives.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort */
    }
  }
}
