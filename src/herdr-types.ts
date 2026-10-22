// Shapes copied from `herdr api schema --json` (protocol 22); subscriptions are dotted, event payloads underscored
export interface PaneInfo { pane_id: string; tab_id: string; workspace_id: string; label?: string | null }
export interface TabInfo { tab_id: string; workspace_id: string; label: string }
export interface PaneProcessInfo { pane_id: string; shell_pid?: number | null }
export interface InstalledPluginInfo { plugin_id: string; enabled: boolean }
export interface PaneListResult { type: "pane_list"; panes: PaneInfo[] }
export interface TabListResult { type: "tab_list"; tabs: TabInfo[] }
export interface PaneProcessInfoResult { type: "pane_process_info"; process_info: PaneProcessInfo }
export interface PluginListResult { type: "plugin_list"; plugins: InstalledPluginInfo[] }
export interface HerdrErrorBody { code: string; message: string }
export interface HerdrMethods {
  "pane.list": { params: { workspace_id?: string | null }; result: PaneListResult };
  "tab.list": { params: { workspace_id?: string | null }; result: TabListResult };
  "pane.process_info": { params: { pane_id?: string | null }; result: PaneProcessInfoResult };
  "plugin.list": { params: { plugin_id?: string | null }; result: PluginListResult };
  "pane.rename": { params: { pane_id: string; label: string | null }; result: unknown };
  "tab.rename": { params: { tab_id: string; label: string }; result: unknown };
  "workspace.report_metadata": { params: { workspace_id: string; source: string; tokens: Record<string, string | null>; ttl_ms?: number }; result: unknown };
}
export type HerdrMethod = keyof HerdrMethods;
export type HerdrOp = { [M in HerdrMethod]: { method: M; params: HerdrMethods[M]["params"] } }[HerdrMethod];
export type SubscriptionType = "pane.created" | "pane.closed" | "pane.exited" | "tab.renamed" | "tab.closed" | "workspace.closed";
export type HerdrEvent =
  | { event: "pane_created"; data: { type: "pane_created"; pane: PaneInfo } }
  | { event: "pane_closed"; data: { type: "pane_closed"; pane_id: string; workspace_id: string } }
  | { event: "pane_exited"; data: { type: "pane_exited"; pane_id: string; workspace_id: string } }
  | { event: "tab_renamed"; data: { type: "tab_renamed"; tab_id: string; workspace_id: string; label: string } }
  | { event: "tab_closed"; data: { type: "tab_closed"; tab_id: string; workspace_id: string } }
  | { event: "workspace_closed"; data: { type: "workspace_closed"; workspace_id: string } };
