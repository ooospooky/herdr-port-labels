import type { Listener } from "./scan.ts";

const MAX_ANCESTRY_DEPTH = 64;
const ROOT_PIDS = new Set([0, 1]);

function findPane(startPid: number, parentOf: Map<number, number>, paneByShellPid: Map<number, string>): string | null {
  const visited = new Set<number>();
  let pid: number | undefined = startPid;
  for (let step = 0; step < MAX_ANCESTRY_DEPTH; step++) {
    if (pid === undefined || ROOT_PIDS.has(pid) || visited.has(pid)) return null;
    const paneId = paneByShellPid.get(pid);
    if (paneId !== undefined) return paneId;
    visited.add(pid);
    pid = parentOf.get(pid);
  }
  return null;
}

export function attributePorts(
  listeners: Listener[],
  parentOf: Map<number, number>,
  paneByShellPid: Map<number, string>,
): Map<string, number[]> {
  const portsByPane = new Map<string, Set<number>>();
  for (const { pid, port } of listeners) {
    const paneId = findPane(pid, parentOf, paneByShellPid);
    if (paneId === null) continue;
    const ports = portsByPane.get(paneId) ?? new Set<number>();
    portsByPane.set(paneId, ports);
    ports.add(port);
  }
  return new Map(
    [...portsByPane].map(([paneId, ports]) => [paneId, [...ports].sort((left, right) => left - right)]),
  );
}
