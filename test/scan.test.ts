import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLsofListeners, parsePsTree, listListeners, listProcessTree, type RunCommand } from "../src/scan.ts";

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
test("listListeners reports an lsof timeout with the signal instead of a bare Command failed", async () => {
  const lsofTimedOut: RunCommand = async () => {
    throw Object.assign(new Error("Command failed: lsof -nP -iTCP -sTCP:LISTEN -Fpn\n"), { code: null, signal: "SIGTERM", killed: true });
  };
  await assert.rejects(listListeners(lsofTimedOut), { message: /^lsof timed out after \d+ ms \(SIGTERM\)$/ });
});
test("listListeners reports a non-zero lsof exit with the first stderr line", async () => {
  const lsofFailed: RunCommand = async () => {
    throw Object.assign(new Error("Command failed: lsof\nlsof: WARNING: can't stat() nfs file system\nsecond line\n"), {
      code: 2,
      stdout: "",
      stderr: "lsof: WARNING: can't stat() nfs file system\nsecond line\n",
    });
  };
  await assert.rejects(listListeners(lsofFailed), { message: "lsof exited 2: lsof: WARNING: can't stat() nfs file system" });
});
test("listProcessTree reports a ps timeout the same way", async () => {
  const psTimedOut: RunCommand = async () => {
    throw Object.assign(new Error("Command failed: ps -A -o pid=,ppid=\n"), { code: null, signal: "SIGTERM", killed: true });
  };
  await assert.rejects(listProcessTree(psTimedOut), { message: /^ps timed out after \d+ ms \(SIGTERM\)$/ });
});
