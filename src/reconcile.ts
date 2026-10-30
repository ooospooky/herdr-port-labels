import { SOURCE, TOKEN_NAME, TTL_MS, RENEW_MS, PANE_TOKEN_TTL_MS, PANE_TOKEN_RENEW_MS } from "./constants.ts";
import type { HerdrOp } from "./herdr-types.ts";
import { carriesPortLabel, hasBadge, withBadge, withoutBadge, paneLabel, parsePaneLabel, portsToken } from "./labels.ts";

export interface PaneSnapshot { pane_id: string; tab_id: string; workspace_id: string; label: string | null }
export interface TabSnapshot { tab_id: string; workspace_id: string; label: string }
export interface PaneMemory { original: string | null; written: string | null }
export interface TabMemory { original: string; written: string }
export interface TokenMemory { token: string; writtenAt: number }
export interface Memory { panes: Map<string, PaneMemory>; tabs: Map<string, TabMemory>; spaces: Map<string, TokenMemory>; paneTokens: Map<string, TokenMemory> }

export function emptyMemory(): Memory {
  return { panes: new Map(), tabs: new Map(), spaces: new Map(), paneTokens: new Map() };
}

function currentOriginal<Label extends string | null>(remembered: { original: Label; written: Label } | undefined, label: Label, originalFromLabel: (label: Label) => Label): Label {
  const labelIsOurs = remembered !== undefined && label === remembered.written;
  return labelIsOurs ? remembered.original : originalFromLabel(label);
}

function paneOriginalFromLabel(label: string | null): string | null {
  return parsePaneLabel(label).original;
}

function reconcilePanes(panes: PaneSnapshot[], portsOfPane: (paneId: string) => number[], memory: Memory, nextMemory: Memory, ops: HerdrOp[]): void {
  for (const pane of panes) {
    const ports = portsOfPane(pane.pane_id);
    const hasServer = ports.length > 0;
    const remembered = memory.panes.get(pane.pane_id);
    const needsAttention = hasServer || remembered !== undefined || hasBadge(pane.label);
    if (!needsAttention) continue;

    const original = currentOriginal(remembered, pane.label, paneOriginalFromLabel);
    // Another plugin may decorate our label (`⚡ 5176:p2`); while it still carries our ports, leave it alone
    const decoratedByOthers = hasServer && pane.label !== null && carriesPortLabel(pane.label, ports);
    const desired = decoratedByOthers ? pane.label : hasServer ? paneLabel(ports, original) : original;
    if (pane.label !== desired) ops.push({ method: "pane.rename", params: { pane_id: pane.pane_id, label: desired } });
    if (hasServer) nextMemory.panes.set(pane.pane_id, { original, written: desired });
  }
}

function reconcileTabs(tabs: TabSnapshot[], serverTabIds: Set<string>, memory: Memory, nextMemory: Memory, ops: HerdrOp[]): void {
  for (const tab of tabs) {
    const hasServer = serverTabIds.has(tab.tab_id);
    const remembered = memory.tabs.get(tab.tab_id);
    const needsAttention = hasServer || remembered !== undefined || hasBadge(tab.label);
    if (!needsAttention) continue;

    const original = currentOriginal(remembered, tab.label, withoutBadge);
    const desired = hasServer ? withBadge(original) : original;
    if (tab.label !== desired) ops.push({ method: "tab.rename", params: { tab_id: tab.tab_id, label: desired } });
    if (hasServer) nextMemory.tabs.set(tab.tab_id, { original, written: desired });
  }
}

interface TokenTarget {
  memory: Map<string, TokenMemory>;
  nextMemory: Map<string, TokenMemory>;
  renewMs: number;
  reportOp: (id: string, token: string | null) => HerdrOp;
}

function reconcileTokens(portsById: Map<string, number[]>, now: number, ops: HerdrOp[], { memory, nextMemory, renewMs, reportOp }: TokenTarget): void {
  for (const [id, ports] of portsById) {
    const remembered = memory.get(id);
    if (ports.length === 0) {
      if (remembered !== undefined) ops.push(reportOp(id, null));
      continue;
    }

    const token = portsToken(ports);
    const isStillFresh = remembered !== undefined && remembered.token === token && now - remembered.writtenAt < renewMs;
    if (isStillFresh) {
      nextMemory.set(id, remembered);
      continue;
    }
    ops.push(reportOp(id, token));
    nextMemory.set(id, { token, writtenAt: now });
  }
}

function spaceReportOp(workspaceId: string, token: string | null): HerdrOp {
  const params = { workspace_id: workspaceId, source: SOURCE, tokens: { [TOKEN_NAME]: token } };
  return { method: "workspace.report_metadata", params: token === null ? params : { ...params, ttl_ms: TTL_MS } };
}

function paneReportOp(paneId: string, token: string | null): HerdrOp {
  const params = { pane_id: paneId, source: SOURCE, tokens: { [TOKEN_NAME]: token } };
  return { method: "pane.report_metadata", params: token === null ? params : { ...params, ttl_ms: PANE_TOKEN_TTL_MS } };
}

export function reconcile({ panes, tabs, portsByPane, memory, now }: { panes: PaneSnapshot[]; tabs: TabSnapshot[]; portsByPane: Map<string, number[]>; memory: Memory; now: number }): { ops: HerdrOp[]; memory: Memory } {
  const portsOfPane = (paneId: string): number[] => portsByPane.get(paneId) ?? [];
  const serverTabIds = new Set(panes.filter((pane) => portsOfPane(pane.pane_id).length > 0).map((pane) => pane.tab_id));
  const portsByLivePane = new Map(panes.map((pane) => [pane.pane_id, portsOfPane(pane.pane_id)]));
  const portsBySpace = new Map<string, number[]>();
  for (const pane of panes) {
    const spacePorts = portsBySpace.get(pane.workspace_id) ?? [];
    portsBySpace.set(pane.workspace_id, [...spacePorts, ...portsOfPane(pane.pane_id)]);
  }

  // Only ids present in this snapshot are copied forward, which is how closed panes, tabs and workspaces leave memory.
  const nextMemory = emptyMemory();
  const ops: HerdrOp[] = [];
  reconcilePanes(panes, portsOfPane, memory, nextMemory, ops);
  reconcileTokens(portsByLivePane, now, ops, { memory: memory.paneTokens, nextMemory: nextMemory.paneTokens, renewMs: PANE_TOKEN_RENEW_MS, reportOp: paneReportOp });
  reconcileTabs(tabs, serverTabIds, memory, nextMemory, ops);
  reconcileTokens(portsBySpace, now, ops, { memory: memory.spaces, nextMemory: nextMemory.spaces, renewMs: RENEW_MS, reportOp: spaceReportOp });
  return { ops, memory: nextMemory };
}
