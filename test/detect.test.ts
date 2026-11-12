import { test } from "node:test";
import assert from "node:assert/strict";
import { attributePorts } from "../src/detect.ts";

test("attributePorts walks ancestry to a pane shell and dedupes", () => {
  const listeners = [{ pid: 41798, port: 5176 }, { pid: 41798, port: 5177 }, { pid: 99, port: 3000 }];
  const parentOf = new Map([[41798, 41783], [41783, 2050], [2050, 1], [99, 1]]);
  const paneByShellPid = new Map([[2050, "w3X:p2"]]);
  assert.deepEqual([...attributePorts(listeners, { parentOf, commandNameOf: new Map() }, paneByShellPid)], [["w3X:p2", [5176, 5177]]]);
});
test("attributePorts stops on cycles and unknown parents", () => {
  const parentOf = new Map([[5, 6], [6, 5]]);
  assert.equal(attributePorts([{ pid: 5, port: 1 }], { parentOf, commandNameOf: new Map() }, new Map()).size, 0);
});
test("attributePorts skips Claude Code's own port but keeps a server it started", () => {
  const listeners = [{ pid: 15660, port: 58825 }, { pid: 20001, port: 3000 }];
  const parentOf = new Map([[20001, 15660], [15660, 14732], [14732, 1]]);
  const commandNameOf = new Map([[15660, "claude"], [20001, "node"], [14732, "-zsh"]]);
  const paneByShellPid = new Map([[14732, "w1:p1"]]);
  assert.deepEqual([...attributePorts(listeners, { parentOf, commandNameOf }, paneByShellPid)], [["w1:p1", [3000]]]);
});
