import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLsofListeners, parsePsTree, listListeners, type RunCommand } from "../src/scan.ts";

test("parseLsofListeners handles ipv4, ipv6 and wildcard", () => {
  const text = "p41798\nn127.0.0.1:5176\nn[::1]:5176\np58033\nn*:8080\n";
  assert.deepEqual(parseLsofListeners(text), [
    { pid: 41798, port: 5176 },
    { pid: 58033, port: 8080 },
  ]);
});
test("parsePsTree maps pid to ppid", () => {
  assert.deepEqual([...parsePsTree("  1     0\n 2050     1\n41783  2050\n")], [[1, 0], [2050, 1], [41783, 2050]]);
});
test("listListeners returns no listeners when lsof exits 1 with empty output", async () => {
  const lsofNoMatch: RunCommand = async () => {
    throw Object.assign(new Error("Command failed: lsof"), { code: 1, stdout: "" });
  };
  assert.deepEqual(await listListeners(lsofNoMatch), []);
});
