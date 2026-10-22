import { test } from "node:test";
import assert from "node:assert/strict";
import { attributePorts } from "../src/detect.ts";

test("attributePorts walks ancestry to a pane shell and dedupes", () => {
  const listeners = [{ pid: 41798, port: 5176 }, { pid: 41798, port: 5177 }, { pid: 99, port: 3000 }];
  const parentOf = new Map([[41798, 41783], [41783, 2050], [2050, 1], [99, 1]]);
  const paneByShellPid = new Map([[2050, "w3X:p2"]]);
  assert.deepEqual([...attributePorts(listeners, parentOf, paneByShellPid)], [["w3X:p2", [5176, 5177]]]);
});
test("attributePorts stops on cycles and unknown parents", () => {
  const parentOf = new Map([[5, 6], [6, 5]]);
  assert.equal(attributePorts([{ pid: 5, port: 1 }], parentOf, new Map()).size, 0);
});
