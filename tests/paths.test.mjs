import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  resolveDataDir,
  dataFile,
  ensureDataDir,
} from "../extension/storage/paths.mjs";

const HOME = "/home/u";
const WHOME = "C:\\Users\\u";

test("resolveDataDir: AGENT_RELAY_DATA_DIR override wins on every platform", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const dir = resolveDataDir({
      env: { AGENT_RELAY_DATA_DIR: "/custom/dir" },
      platform,
      homedir: HOME,
    });
    assert.equal(dir, "/custom/dir");
  }
});

test("resolveDataDir: win32 uses %LOCALAPPDATA%\\agent-relay", () => {
  const dir = resolveDataDir({
    env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
    platform: "win32",
    homedir: WHOME,
  });
  assert.equal(dir, join("C:\\Users\\u\\AppData\\Local", "agent-relay"));
});

test("resolveDataDir: win32 falls back to ~\\AppData\\Local when LOCALAPPDATA unset", () => {
  const dir = resolveDataDir({ env: {}, platform: "win32", homedir: WHOME });
  assert.equal(dir, join(WHOME, "AppData", "Local", "agent-relay"));
});

test("resolveDataDir: darwin uses ~/Library/Application Support", () => {
  const dir = resolveDataDir({ env: {}, platform: "darwin", homedir: HOME });
  assert.equal(dir, join(HOME, "Library", "Application Support", "agent-relay"));
});

test("resolveDataDir: linux uses $XDG_DATA_HOME when set", () => {
  const dir = resolveDataDir({ env: { XDG_DATA_HOME: "/xdg" }, platform: "linux", homedir: HOME });
  assert.equal(dir, join("/xdg", "agent-relay"));
});

test("resolveDataDir: linux falls back to ~/.local/share", () => {
  const dir = resolveDataDir({ env: {}, platform: "linux", homedir: HOME });
  assert.equal(dir, join(HOME, ".local", "share", "agent-relay"));
});

test("dataFile joins a name under the data dir", () => {
  const p = dataFile("agent-relay.db", {
    env: { AGENT_RELAY_DATA_DIR: "/d" },
    platform: "linux",
    homedir: HOME,
  });
  assert.equal(p, join("/d", "agent-relay.db"));
});

test("ensureDataDir mkdirs recursively and returns the dir", () => {
  const calls = [];
  const dir = ensureDataDir({
    env: { AGENT_RELAY_DATA_DIR: "/d" },
    platform: "linux",
    homedir: HOME,
    fs: { mkdirSync: (p, opts) => calls.push([p, opts]) },
  });
  assert.equal(dir, "/d");
  assert.deepEqual(calls, [["/d", { recursive: true }]]);
});
