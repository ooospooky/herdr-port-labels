import { test } from "node:test";
import assert from "node:assert/strict";
import { hasBadge, withBadge, withoutBadge, paneLabel, parsePaneLabel, spaceToken } from "../src/labels.ts";

test("hasBadge detects the badge anywhere, not a bare badge", () => {
  assert.equal(hasBadge("⚡ 2"), true);
  assert.equal(hasBadge("[2] ⚡ zsh"), true);
  assert.equal(hasBadge("[2] ⚡ [2] zsh"), true);
  assert.equal(hasBadge("⚡"), false);
  assert.equal(hasBadge("2"), false);
  assert.equal(hasBadge(null), false);
});
test("withBadge adds the prefix once, after a jump-key prefix", () => {
  assert.equal(withBadge("2"), "⚡ 2");
  assert.equal(withBadge("⚡ 2"), "⚡ 2");
  assert.equal(withBadge("[2] zsh"), "[2] ⚡ zsh");
  assert.equal(withBadge("[2] ⚡ zsh"), "[2] ⚡ zsh");
  assert.equal(withBadge("[2] ⚡ [2] zsh"), "[2] ⚡ [2] zsh");
});
test("withoutBadge strips the prefix from its slot and keeps everything else", () => {
  assert.equal(withoutBadge("⚡ 2"), "2");
  assert.equal(withoutBadge("[2] ⚡ zsh"), "[2] zsh");
  assert.equal(withoutBadge("⚡"), "⚡");
  assert.equal(withoutBadge("2"), "2");
  assert.equal(withoutBadge("foo ⚡ bar"), "foo ⚡ bar");
});
test("paneLabel and parsePaneLabel round-trip", () => {
  assert.equal(paneLabel([5177, 5176], null), "⚡ 5176 5177");
  assert.equal(paneLabel([5176], "my pane"), "⚡ 5176 | my pane");
  assert.deepEqual(parsePaneLabel("⚡ 5176 5177 | my pane"), { ports: [5176, 5177], original: "my pane" });
  assert.deepEqual(parsePaneLabel("⚡ 5176"), { ports: [5176], original: null });
  assert.deepEqual(parsePaneLabel("my pane"), { ports: [], original: "my pane" });
  assert.deepEqual(parsePaneLabel(null), { ports: [], original: null });
});
test("pane label round-trips originals that look like ports", () => {
  for (const original of ["2", "5173 proxy"]) {
    assert.deepEqual(parsePaneLabel(paneLabel([5176, 5177], original)), { ports: [5176, 5177], original });
  }
  assert.equal(paneLabel([5176], "5173 proxy"), "⚡ 5176 | 5173 proxy");
  assert.deepEqual(parsePaneLabel("⚡ 5176 stray"), { ports: [5176], original: null });
});
test("parsePaneLabel sorts and de-duplicates ports, and keeps a bare badge as the original", () => {
  assert.deepEqual(parsePaneLabel("⚡ 5177 5176 5177 | app"), { ports: [5176, 5177], original: "app" });
  assert.deepEqual(parsePaneLabel("⚡"), { ports: [], original: "⚡" });
});
test("spaceToken sorts, and truncates past 80 chars with +n", () => {
  assert.equal(spaceToken([5177, 5176]), "⚡5176 5177");
  const many = Array.from({ length: 30 }, (_, index) => 10000 + index);
  const token = spaceToken(many);
  assert.ok(token.length <= 80);
  assert.match(token, / \+\d+$/);
});
