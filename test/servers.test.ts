import { test } from "node:test";
import assert from "node:assert/strict";
import { serverRows } from "../src/servers.ts";
import type { ServerPane } from "../src/control.ts";
import type { PaneInfo, TabInfo, WorkspaceInfo } from "../src/herdr-types.ts";

const workspace = (workspaceId: string, overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  workspace_id: workspaceId,
  label: `space ${workspaceId}`,
  number: 1,
  focused: false,
  worktree: null,
  ...overrides,
});
const worktree = (repoKey: string, isLinkedWorktree: boolean) => ({ repo_key: repoKey, is_linked_worktree: isLinkedWorktree });
const tab = (tabId: string, number: number, label = `tab ${tabId}`): TabInfo => ({
  tab_id: tabId,
  workspace_id: tabId.split(":")[0] ?? "",
  label,
  number,
});
const pane = (paneId: string, tabId: string, label?: string | null): PaneInfo => ({
  pane_id: paneId,
  tab_id: tabId,
  workspace_id: paneId.split(":")[0] ?? "",
  label,
});
const server = (paneId: string, ...ports: number[]): ServerPane => ({ pane_id: paneId, ports });

const paneIds = (rows: { paneId: string }[]) => rows.map((row) => row.paneId);

test("a pane the watcher still reports but herdr no longer lists gets no row", () => {
  const rows = serverRows({
    servers: [server("w1:p1", 5173), server("w1:p9", 3000)],
    workspaces: [workspace("w1", { focused: true })],
    tabs: [tab("w1:t1", 1)],
    panes: [pane("w1:p1", "w1:t1")],
  });
  assert.deepEqual(paneIds(rows), ["w1:p1"]);
});

test("a pane with several ports is one row that keeps the watcher's ascending port order", () => {
  const rows = serverRows({
    servers: [server("w1:p1", 5173, 5174)],
    workspaces: [workspace("w1", { focused: true, label: "web" })],
    tabs: [tab("w1:t1", 1, "⚡ dev")],
    panes: [pane("w1:p1", "w1:t1", "⚡ 5173 5174 | api")],
  });
  assert.deepEqual(rows, [{ paneId: "w1:p1", ports: [5173, 5174], spaceLabel: "web", tabLabel: "⚡ dev", paneName: "api" }]);
});

test("the pane name drops our port prefix and is null when the user never named the pane", () => {
  const rows = serverRows({
    servers: [server("w1:p1", 5173), server("w1:p2", 5174), server("w1:p3", 5175)],
    workspaces: [workspace("w1", { focused: true })],
    tabs: [tab("w1:t1", 1, "⚡ dev")],
    panes: [pane("w1:p1", "w1:t1", "⚡ 5173 | api"), pane("w1:p2", "w1:t1", "⚡ 5174"), pane("w1:p3", "w1:t1")],
  });
  assert.deepEqual(
    rows.map((row) => [row.paneName, row.tabLabel]),
    [
      ["api", "⚡ dev"],
      [null, "⚡ dev"],
      [null, "⚡ dev"],
    ],
  );
});

test("the focused Space comes first even when the sidebar puts it last", () => {
  const rows = serverRows({
    servers: [server("w1:p1", 3000), server("w2:p1", 4000), server("w3:p1", 5000)],
    workspaces: [workspace("w1"), workspace("w2"), workspace("w3", { focused: true })],
    tabs: [tab("w1:t1", 1), tab("w2:t1", 1), tab("w3:t1", 1)],
    panes: [pane("w1:p1", "w1:t1"), pane("w2:p1", "w2:t1"), pane("w3:p1", "w3:t1")],
  });
  assert.deepEqual(paneIds(rows), ["w3:p1", "w1:p1", "w2:p1"]);
});

test("the other Spaces follow the sidebar: a repo's main checkouts then its linked worktrees, at the group's first member", () => {
  const workspaces = [
    workspace("focus", { focused: true }),
    workspace("solo"),
    workspace("repoA-linked1", { worktree: worktree("repoA", true) }),
    workspace("plain"),
    workspace("repoA-main", { worktree: worktree("repoA", false) }),
    workspace("orphan-linked", { worktree: worktree("repoB", true) }),
    workspace("repoA-linked2", { worktree: worktree("repoA", true) }),
    workspace("tail"),
  ];
  const ids = workspaces.map((entry) => entry.workspace_id);
  const rows = serverRows({
    servers: ids.map((id) => server(`${id}:p1`, 3000)),
    workspaces,
    tabs: ids.map((id) => tab(`${id}:t1`, 1)),
    panes: ids.map((id) => pane(`${id}:p1`, `${id}:t1`)),
  });
  assert.deepEqual(
    rows.map((row) => row.paneId.split(":")[0]),
    ["focus", "solo", "repoA-main", "repoA-linked1", "repoA-linked2", "plain", "orphan-linked", "tail"],
  );
});

test("a group keeps its sidebar place when the focused Space is its only main checkout", () => {
  const workspaces = [
    workspace("repoA-linked1", { worktree: worktree("repoA", true) }),
    workspace("plain"),
    workspace("repoA-main", { focused: true, worktree: worktree("repoA", false) }),
    workspace("repoA-linked2", { worktree: worktree("repoA", true) }),
  ];
  const ids = workspaces.map((entry) => entry.workspace_id);
  const rows = serverRows({
    servers: ids.map((id) => server(`${id}:p1`, 3000)),
    workspaces,
    tabs: ids.map((id) => tab(`${id}:t1`, 1)),
    panes: ids.map((id) => pane(`${id}:p1`, `${id}:t1`)),
  });
  assert.deepEqual(
    rows.map((row) => row.paneId.split(":")[0]),
    ["repoA-main", "repoA-linked1", "repoA-linked2", "plain"],
  );
});

test("within a Space rows follow the tab number, then the pane.list order", () => {
  const rows = serverRows({
    servers: [server("w1:p1", 3000), server("w1:p2", 3001), server("w1:p3", 3002), server("w1:p4", 3003)],
    workspaces: [workspace("w1", { focused: true })],
    tabs: [tab("w1:t5", 2), tab("w1:t2", 1)],
    panes: [pane("w1:p3", "w1:t5"), pane("w1:p4", "w1:t2"), pane("w1:p1", "w1:t5"), pane("w1:p2", "w1:t2")],
  });
  assert.deepEqual(paneIds(rows), ["w1:p4", "w1:p2", "w1:p3", "w1:p1"]);
});

test("no attributed ports means no rows", () => {
  const rows = serverRows({
    servers: [],
    workspaces: [workspace("w1", { focused: true })],
    tabs: [tab("w1:t1", 1)],
    panes: [pane("w1:p1", "w1:t1")],
  });
  assert.deepEqual(rows, []);
});
