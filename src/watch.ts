import { mkdir, stat } from "node:fs/promises";
import { DEBOUNCE_MS, INTERVAL_MS, PLUGIN_ID } from "./constants.ts";
import { loadPluginEnv } from "./env.ts";
import { listListeners, listProcessTree } from "./scan.ts";
import { attributePorts } from "./detect.ts";
import { HerdrClient, subscribeEvents, applyOps, pluginIsEnabled } from "./herdr.ts";
import type { HerdrEvent, SubscriptionType } from "./herdr-types.ts";
import { reconcile, emptyMemory } from "./reconcile.ts";
import type { Memory, PaneSnapshot, TabSnapshot } from "./reconcile.ts";
import { controlSocketPath, startControlServer } from "./control.ts";

const SUBSCRIBED_EVENTS: SubscriptionType[] = ["pane.created", "pane.closed", "pane.exited", "tab.renamed", "tab.closed", "workspace.closed"];
const SHELL_GONE_EVENTS = new Set<HerdrEvent["event"]>(["pane_closed", "pane_exited"]);
const SUBSCRIBE_FAILED_EXIT_CODE = 1;

const log = (message: string): void => console.error(`port-labels: ${message}`);

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message) return error.message;
    if ("code" in error && typeof error.code === "string") return error.code;
  }
  return String(error);
}

const { herdrSocketPath, stateDir, pluginRoot, version } = loadPluginEnv();
const controlPath = controlSocketPath(stateDir, herdrSocketPath);

let client: HerdrClient;
let memory: Memory = emptyMemory();
const shellPidByPane = new Map<string, number>();
let controlServer: { close(): Promise<void> };
let controlSocketInode: number;
let intervalTimer: ReturnType<typeof setInterval> | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let tickInFlight: Promise<void> | null = null;
let tickQueued = false;
let shuttingDown = false;

async function listPanes(): Promise<PaneSnapshot[]> {
  const { panes } = await client.request("pane.list", {});
  // pane.list omits label for unnamed panes; reconcile expects null
  return panes.map((pane) => ({ ...pane, label: pane.label ?? null }));
}

async function listTabs(): Promise<TabSnapshot[]> {
  const { tabs } = await client.request("tab.list", {});
  return tabs;
}

async function refreshShellPids(panes: PaneSnapshot[]): Promise<Map<number, string>> {
  const livePaneIds = new Set(panes.map((pane) => pane.pane_id));
  for (const paneId of shellPidByPane.keys()) {
    if (!livePaneIds.has(paneId)) shellPidByPane.delete(paneId);
  }
  for (const pane of panes) {
    if (shellPidByPane.has(pane.pane_id)) continue;
    try {
      const { process_info: processInfo } = await client.request("pane.process_info", { pane_id: pane.pane_id });
      const shellPid = processInfo.shell_pid;
      if (typeof shellPid === "number" && Number.isInteger(shellPid)) shellPidByPane.set(pane.pane_id, shellPid);
    } catch (error) {
      log(`pane.process_info ${pane.pane_id} failed: ${describeError(error)}`);
    }
  }
  return new Map([...shellPidByPane].map(([paneId, shellPid]) => [shellPid, paneId]));
}

async function publish(panes: PaneSnapshot[], tabs: TabSnapshot[], portsByPane: Map<string, number[]>): Promise<void> {
  const result = reconcile({ panes, tabs, portsByPane, memory, now: Date.now() });
  memory = result.memory;
  await applyOps(client, result.ops, log);
}

async function controlSocketState(): Promise<"deleted" | "ours" | "taken"> {
  const current = await stat(controlPath).catch(() => null);
  if (current === null) return "deleted";
  return current.ino === controlSocketInode ? "ours" : "taken";
}

async function scanOnce(): Promise<void> {
  const controlState = await controlSocketState();
  if (controlState === "taken") {
    log("another watcher took over the control socket; exiting");
    process.exit(0);
  }
  if (controlState === "deleted") {
    // shutdown awaits this tick, so it must not be awaited from inside it
    void shutdown("control socket deleted");
    return;
  }
  if (!pluginIsEnabled(await client.request("plugin.list", {}), PLUGIN_ID)) {
    void shutdown("plugin disabled or removed");
    return;
  }
  const panes = await listPanes();
  const paneByShellPid = await refreshShellPids(panes);
  const tabs = await listTabs();
  const [listeners, parentOf] = await Promise.all([listListeners(), listProcessTree()]);
  await publish(panes, tabs, attributePorts(listeners, parentOf, paneByShellPid));
}

async function runQueuedTicks(): Promise<void> {
  do {
    tickQueued = false;
    try {
      await scanOnce();
    } catch (error) {
      log(`tick failed: ${describeError(error)}`);
    }
  } while (tickQueued && !shuttingDown);
  tickInFlight = null;
}

function tick(): void {
  if (shuttingDown) return;
  if (tickInFlight) {
    tickQueued = true;
    return;
  }
  tickInFlight = runQueuedTicks();
}

function onHerdrEvent({ event, data }: HerdrEvent): void {
  if (SHELL_GONE_EVENTS.has(event) && "pane_id" in data) shellPidByPane.delete(data.pane_id);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(tick, DEBOUNCE_MS);
}

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`stopping (${reason})`);
  clearInterval(intervalTimer);
  clearTimeout(debounceTimer);
  await tickInFlight;
  try {
    await publish(await listPanes(), await listTabs(), new Map());
  } catch (error) {
    log(`clearing badges failed: ${describeError(error)}`);
  }
  await controlServer.close();
  client.close();
  process.exit(0);
}

await mkdir(stateDir, { recursive: true });
try {
  controlServer = await startControlServer(controlPath, { version, pluginRoot }, () => void shutdown("quit requested"));
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "already_running")) throw error;
  log("another watcher is running");
  process.exit(0);
}
controlSocketInode = (await stat(controlPath)).ino;
client = await HerdrClient.connect(herdrSocketPath);

async function subscribe(): Promise<void> {
  let started = false;
  await subscribeEvents(herdrSocketPath, SUBSCRIBED_EVENTS, {
    onEvent: onHerdrEvent,
    // onClose also fires when the subscribe request itself is rejected, before started is set
    onClose: () => {
      if (started) void resubscribeOrExit();
    },
  });
  started = true;
}

async function resubscribeOrExit(): Promise<void> {
  if (shuttingDown) return;
  try {
    await subscribe();
  } catch (error) {
    if (shuttingDown) return;
    log(`herdr socket closed; exiting (${describeError(error)})`);
    process.exit(0);
  }
  log("resubscribed");
  tick();
}

try {
  await subscribe();
} catch (error) {
  log(`events.subscribe failed: ${describeError(error)}`);
  await controlServer.close();
  process.exit(SUBSCRIBE_FAILED_EXIT_CODE);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
intervalTimer = setInterval(tick, INTERVAL_MS);
log(`watching ${herdrSocketPath} (v${version})`);
tick();
