import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile, emptyMemory, type Memory } from "../src/reconcile.ts";
import type { HerdrOp } from "../src/herdr-types.ts";
import { SOURCE, TTL_MS, RENEW_MS } from "../src/constants.ts";

function reportOp(workspaceId: string, token: string): HerdrOp {
  return { method: "workspace.report_metadata", params: { workspace_id: workspaceId, source: SOURCE, tokens: { dev_servers: token }, ttl_ms: TTL_MS } };
}

function clearOp(workspaceId: string): HerdrOp {
  return { method: "workspace.report_metadata", params: { workspace_id: workspaceId, source: SOURCE, tokens: { dev_servers: null } } };
}

function badgedMemory({ paneOriginal = null, paneWritten = "⚡ 5176", tabOriginal = "2", tabWritten = "⚡ 2", token = "⚡5176", writtenAt = 1000 } = {}): Memory {
  return {
    panes: new Map([["w1:p2", { original: paneOriginal, written: paneWritten }]]),
    tabs: new Map([["w1:t2", { original: tabOriginal, written: tabWritten }]]),
    spaces: new Map([["w1", { token, writtenAt }]]),
  };
}

test("first server: pane, tab and space ops in one pass", () => {
  const panes = [{ pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", label: null }];
  const tabs = [{ tab_id: "w1:t2", workspace_id: "w1", label: "2" }];
  const portsByPane = new Map([["w1:p2", [5176, 5177]]]);
  const { ops, memory } = reconcile({ panes, tabs, portsByPane, memory: emptyMemory(), now: 1000 });
  assert.deepEqual(ops, [
    { method: "pane.rename", params: { pane_id: "w1:p2", label: "⚡ 5176 5177" } },
    { method: "tab.rename", params: { tab_id: "w1:t2", label: "⚡ 2" } },
    { method: "workspace.report_metadata", params: { workspace_id: "w1", source: SOURCE, tokens: { dev_servers: "⚡5176 5177" }, ttl_ms: TTL_MS } },
  ]);
  assert.deepEqual(memory.panes.get("w1:p2"), { original: null, written: "⚡ 5176 5177" });
  assert.deepEqual(memory.tabs.get("w1:t2"), { original: "2", written: "⚡ 2" });
  assert.deepEqual(memory.spaces.get("w1"), { token: "⚡5176 5177", writtenAt: 1000 });
});

test("steady state produces no ops before RENEW_MS, and a renew op after", () => {
  const panes = [{ pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", label: "⚡ 5176" }];
  const tabs = [{ tab_id: "w1:t2", workspace_id: "w1", label: "⚡ 2" }];
  const portsByPane = new Map([["w1:p2", [5176]]]);

  const early = reconcile({ panes, tabs, portsByPane, memory: badgedMemory(), now: 1000 + RENEW_MS - 1 });
  assert.deepEqual(early.ops, []);
  assert.deepEqual(early.memory, badgedMemory());

  const renewed = reconcile({ panes, tabs, portsByPane, memory: early.memory, now: 1000 + RENEW_MS });
  assert.deepEqual(renewed.ops, [reportOp("w1", "⚡5176")]);
  assert.deepEqual(renewed.memory.spaces.get("w1"), { token: "⚡5176", writtenAt: 1000 + RENEW_MS });
});

test("changed ports rewrite the pane label and the token before RENEW_MS", () => {
  const panes = [{ pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", label: "⚡ 5176" }];
  const tabs = [{ tab_id: "w1:t2", workspace_id: "w1", label: "⚡ 2" }];
  const portsByPane = new Map([["w1:p2", [5177, 5176]]]);
  const { ops, memory } = reconcile({ panes, tabs, portsByPane, memory: badgedMemory(), now: 2000 });
  assert.deepEqual(ops, [
    { method: "pane.rename", params: { pane_id: "w1:p2", label: "⚡ 5176 5177" } },
    reportOp("w1", "⚡5176 5177"),
  ]);
  assert.deepEqual(memory.panes.get("w1:p2"), { original: null, written: "⚡ 5176 5177" });
  assert.deepEqual(memory.spaces.get("w1"), { token: "⚡5176 5177", writtenAt: 2000 });
});

test("server stops: pane label back to null, tab back to original, token cleared", () => {
  const panes = [{ pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", label: "⚡ 5176" }];
  const tabs = [{ tab_id: "w1:t2", workspace_id: "w1", label: "⚡ 2" }];
  const { ops, memory } = reconcile({ panes, tabs, portsByPane: new Map(), memory: badgedMemory(), now: 2000 });
  assert.deepEqual(ops, [
    { method: "pane.rename", params: { pane_id: "w1:p2", label: null } },
    { method: "tab.rename", params: { tab_id: "w1:t2", label: "2" } },
    clearOp("w1"),
  ]);
  assert.ok(ops[2]);
  assert.equal("ttl_ms" in ops[2].params, false);
  assert.deepEqual(memory, emptyMemory());
});

test("badges left over without memory are stripped", () => {
  const panes = [{ pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", label: "⚡ 5176 | my pane" }];
  const tabs = [{ tab_id: "w1:t2", workspace_id: "w1", label: "⚡ 2" }];
  const { ops, memory } = reconcile({ panes, tabs, portsByPane: new Map(), memory: emptyMemory(), now: 1000 });
  assert.deepEqual(ops, [
    { method: "pane.rename", params: { pane_id: "w1:p2", label: "my pane" } },
    { method: "tab.rename", params: { tab_id: "w1:t2", label: "2" } },
  ]);
  assert.deepEqual(memory, emptyMemory());
});

test("unbadged panes and tabs without servers are left alone", () => {
  const panes = [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "shell" }];
  const tabs = [{ tab_id: "w1:t1", workspace_id: "w1", label: "1" }];
  const { ops, memory } = reconcile({ panes, tabs, portsByPane: new Map([["w1:p1", []]]), memory: emptyMemory(), now: 1000 });
  assert.deepEqual(ops, []);
  assert.deepEqual(memory, emptyMemory());
});

test("tab renamed by user while badged keeps the new name and re-adds the badge", () => {
  const panes = [{ pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", label: "⚡ 5176" }];
  const portsByPane = new Map([["w1:p2", [5176]]]);

  const plainRename = reconcile({ panes, tabs: [{ tab_id: "w1:t2", workspace_id: "w1", label: "api" }], portsByPane, memory: badgedMemory(), now: 2000 });
  assert.deepEqual(plainRename.ops, [{ method: "tab.rename", params: { tab_id: "w1:t2", label: "⚡ api" } }]);
  assert.deepEqual(plainRename.memory.tabs.get("w1:t2"), { original: "api", written: "⚡ api" });

  const badgedRename = reconcile({ panes, tabs: [{ tab_id: "w1:t2", workspace_id: "w1", label: "⚡ api" }], portsByPane, memory: badgedMemory(), now: 2000 });
  assert.deepEqual(badgedRename.ops, []);
  assert.deepEqual(badgedRename.memory.tabs.get("w1:t2"), { original: "api", written: "⚡ api" });

  const stopped = reconcile({ panes, tabs: [{ tab_id: "w1:t2", workspace_id: "w1", label: "⚡ api" }], portsByPane: new Map(), memory: plainRename.memory, now: 3000 });
  assert.deepEqual(stopped.ops, [
    { method: "pane.rename", params: { pane_id: "w1:p2", label: null } },
    { method: "tab.rename", params: { tab_id: "w1:t2", label: "api" } },
    clearOp("w1"),
  ]);
});

test("user rename without a badge after the server stops is not touched", () => {
  const panes = [{ pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", label: "logs" }];
  const tabs = [{ tab_id: "w1:t2", workspace_id: "w1", label: "api" }];
  const { ops, memory } = reconcile({ panes, tabs, portsByPane: new Map(), memory: badgedMemory(), now: 2000 });
  assert.deepEqual(ops, [clearOp("w1")]);
  assert.deepEqual(memory, emptyMemory());
});

test("pane with a manual label keeps it after the ports", () => {
  const tabs = [{ tab_id: "w1:t2", workspace_id: "w1", label: "⚡ 2" }];
  const first = reconcile({
    panes: [{ pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", label: "my pane" }],
    tabs,
    portsByPane: new Map([["w1:p2", [5176]]]),
    memory: badgedMemory({ paneWritten: "unused" }),
    now: 1000,
  });
  assert.deepEqual(first.ops, [{ method: "pane.rename", params: { pane_id: "w1:p2", label: "⚡ 5176 | my pane" } }]);
  assert.deepEqual(first.memory.panes.get("w1:p2"), { original: "my pane", written: "⚡ 5176 | my pane" });

  const morePorts = reconcile({
    panes: [{ pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", label: "⚡ 5176 | my pane" }],
    tabs,
    portsByPane: new Map([["w1:p2", [5176, 5177]]]),
    memory: first.memory,
    now: 2000,
  });
  assert.deepEqual(morePorts.ops, [
    { method: "pane.rename", params: { pane_id: "w1:p2", label: "⚡ 5176 5177 | my pane" } },
    reportOp("w1", "⚡5176 5177"),
  ]);
  assert.deepEqual(morePorts.memory.panes.get("w1:p2"), { original: "my pane", written: "⚡ 5176 5177 | my pane" });
});

test("two panes in one tab: one tab badge, two pane labels, union token", () => {
  const panes = [
    { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: null },
    { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "api" },
  ];
  const tabs = [{ tab_id: "w1:t1", workspace_id: "w1", label: "1" }];
  const portsByPane = new Map([["w1:p1", [5177, 5176]], ["w1:p2", [3000, 5176]]]);
  const { ops, memory } = reconcile({ panes, tabs, portsByPane, memory: emptyMemory(), now: 1000 });
  assert.deepEqual(ops, [
    { method: "pane.rename", params: { pane_id: "w1:p1", label: "⚡ 5176 5177" } },
    { method: "pane.rename", params: { pane_id: "w1:p2", label: "⚡ 3000 5176 | api" } },
    { method: "tab.rename", params: { tab_id: "w1:t1", label: "⚡ 1" } },
    reportOp("w1", "⚡3000 5176 5177"),
  ]);
  assert.equal(memory.tabs.size, 1);
  assert.deepEqual(memory.spaces.get("w1"), { token: "⚡3000 5176 5177", writtenAt: 1000 });
});

test("spaces follow the order workspaces first appear in panes", () => {
  const panes = [
    { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2", label: null },
    { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: null },
  ];
  const tabs = [
    { tab_id: "w1:t1", workspace_id: "w1", label: "1" },
    { tab_id: "w2:t1", workspace_id: "w2", label: "1" },
  ];
  const portsByPane = new Map([["w2:p1", [8080]], ["w1:p1", [5176]]]);
  const { ops } = reconcile({ panes, tabs, portsByPane, memory: emptyMemory(), now: 1000 });
  assert.deepEqual(ops, [
    { method: "pane.rename", params: { pane_id: "w2:p1", label: "⚡ 8080" } },
    { method: "pane.rename", params: { pane_id: "w1:p1", label: "⚡ 5176" } },
    { method: "tab.rename", params: { tab_id: "w1:t1", label: "⚡ 1" } },
    { method: "tab.rename", params: { tab_id: "w2:t1", label: "⚡ 1" } },
    reportOp("w2", "⚡8080"),
    reportOp("w1", "⚡5176"),
  ]);
});

test("closed pane disappears from memory without ops", () => {
  const panes = [{ pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2", label: "shell" }];
  const tabs = [{ tab_id: "w2:t1", workspace_id: "w2", label: "1" }];
  const { ops, memory } = reconcile({ panes, tabs, portsByPane: new Map(), memory: badgedMemory(), now: 2000 });
  assert.deepEqual(ops, []);
  assert.deepEqual(memory, emptyMemory());
});

test("reconcile does not mutate the input memory", () => {
  const input = badgedMemory();
  const panes = [{ pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", label: "⚡ 5176" }];
  const tabs = [{ tab_id: "w1:t2", workspace_id: "w1", label: "⚡ 2" }];
  const { memory } = reconcile({ panes, tabs, portsByPane: new Map([["w1:p2", [5177]]]), memory: input, now: 99999 });
  assert.deepEqual(input, badgedMemory());
  assert.notEqual(memory.panes, input.panes);
  assert.notEqual(memory.tabs, input.tabs);
  assert.notEqual(memory.spaces, input.spaces);
});

test("restart with empty memory keeps live badges and only renews the token", () => {
  const panes = [{ pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", label: "⚡ 5176" }];
  const tabs = [{ tab_id: "w1:t2", workspace_id: "w1", label: "⚡ 2" }];
  const { ops, memory } = reconcile({ panes, tabs, portsByPane: new Map([["w1:p2", [5176]]]), memory: emptyMemory(), now: 1000 });
  assert.deepEqual(ops, [reportOp("w1", "⚡5176")]);
  assert.deepEqual(memory, badgedMemory());
});
test("pane label decorated by another plugin is left alone while the ports are unchanged", () => {
  const panes = [{ pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", label: "⚡ 5176:p2" }];
  const tabs = [{ tab_id: "w1:t2", workspace_id: "w1", label: "⚡ 2" }];
  const portsByPane = new Map([["w1:p2", [5176]]]);
  const { ops, memory } = reconcile({ panes, tabs, portsByPane, memory: badgedMemory(), now: 1000 });
  assert.deepEqual(ops, []);
  assert.deepEqual(memory.panes.get("w1:p2"), { original: null, written: "⚡ 5176:p2" });

  const changed = reconcile({ panes, tabs, portsByPane: new Map([["w1:p2", [5177]]]), memory, now: 1000 });
  assert.deepEqual(changed.ops[0], { method: "pane.rename", params: { pane_id: "w1:p2", label: "⚡ 5177" } });
});
test("pane label that still lists a stopped port is rewritten, not mistaken for a decoration", () => {
  const tabs = [{ tab_id: "w1:t2", workspace_id: "w1", label: "⚡ 2" }];
  const portsByPane = new Map([["w1:p2", [5176]]]);
  const cases = [
    { label: "⚡ 5176 5177", original: null, expected: "⚡ 5176" },
    { label: "⚡ 5176 5177 | api", original: "api", expected: "⚡ 5176 | api" },
    { label: "⚡ 5176 5177:p2", original: null, expected: "⚡ 5176" },
    { label: "⚡ 51760", original: null, expected: "⚡ 5176" },
  ];
  for (const { label, original, expected } of cases) {
    const panes = [{ pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", label }];
    const memory = { ...badgedMemory(), panes: new Map([["w1:p2", { original, written: label }]]) };
    const { ops } = reconcile({ panes, tabs, portsByPane, memory, now: 1000 });
    assert.deepEqual(ops, [{ method: "pane.rename", params: { pane_id: "w1:p2", label: expected } }], label);
  }
});
