import { parsePaneLabel } from "./labels.ts";
import type { ServerPane } from "./control.ts";
import type { PaneInfo, TabInfo, WorkspaceInfo } from "./herdr-types.ts";

export interface ServerRow {
  paneId: string;
  ports: number[];
  spaceLabel: string;
  tabLabel: string;
  paneName: string | null;
}

function repoKeys(workspaces: WorkspaceInfo[], isLinkedWorktree: boolean): Set<string> {
  return new Set(
    workspaces.flatMap((workspace) => (workspace.worktree?.is_linked_worktree === isLinkedWorktree ? [workspace.worktree.repo_key] : [])),
  );
}

// Mirrors herdr 0.9.5 sidebar.rs workspace_entries: a repo with both a main checkout and a linked worktree forms a group at its first member
function sidebarOrder(workspaces: WorkspaceInfo[]): WorkspaceInfo[] {
  const mainRepoKeys = repoKeys(workspaces, false);
  const linkedRepoKeys = repoKeys(workspaces, true);
  const ordered: WorkspaceInfo[] = [];
  const placedRepoKeys = new Set<string>();
  for (const workspace of workspaces) {
    const repoKey = workspace.worktree?.repo_key;
    const isGrouped = repoKey !== undefined && mainRepoKeys.has(repoKey) && linkedRepoKeys.has(repoKey);
    if (!isGrouped) {
      ordered.push(workspace);
      continue;
    }
    if (placedRepoKeys.has(repoKey)) continue;
    placedRepoKeys.add(repoKey);
    const members = workspaces.filter((member) => member.worktree?.repo_key === repoKey);
    ordered.push(...members.filter((member) => !member.worktree?.is_linked_worktree));
    ordered.push(...members.filter((member) => member.worktree?.is_linked_worktree));
  }
  return ordered;
}

export function serverRows({
  servers,
  workspaces,
  tabs,
  panes,
}: {
  servers: ServerPane[];
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: PaneInfo[];
}): ServerRow[] {
  const portsByPane = new Map(servers.map((server) => [server.pane_id, server.ports]));
  const tabById = new Map(tabs.map((tab) => [tab.tab_id, tab]));
  const focusedSpaces = workspaces.filter((workspace) => workspace.focused);
  const otherSpaces = sidebarOrder(workspaces).filter((workspace) => !workspace.focused);

  return [...focusedSpaces, ...otherSpaces].flatMap((workspace) =>
    panes
      .filter((pane) => pane.workspace_id === workspace.workspace_id && portsByPane.has(pane.pane_id))
      .map((pane) => ({ pane, tab: tabById.get(pane.tab_id) }))
      .sort((left, right) => (left.tab?.number ?? 0) - (right.tab?.number ?? 0))
      .map(({ pane, tab }) => ({
        paneId: pane.pane_id,
        ports: portsByPane.get(pane.pane_id) ?? [],
        spaceLabel: workspace.label,
        tabLabel: tab?.label ?? "",
        paneName: parsePaneLabel(pane.label ?? null).original,
      })),
  );
}
