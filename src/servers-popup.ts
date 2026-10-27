import readline from "node:readline";
import { loadPluginEnv } from "./env.ts";
import { controlSocketPath, queryServers } from "./control.ts";
import { HerdrClient, HerdrError } from "./herdr.ts";
import { serverRows } from "./servers.ts";
import type { ServerRow } from "./servers.ts";

const ESCAPE_CODE_TIMEOUT_MS = 50;
const COLUMN_GAP = "   ";
const CURSOR_MARK = "▌";
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const LINES_AROUND_LIST = 5;
const WATCHER_MISSING = "Port Labels watcher is not running. Open a new pane to start it.";
const NO_SERVERS = "No dev servers running.  Press any key to close.";
const PANE_GONE = "That pane is gone. List refreshed.";
const KEY_HINTS = "↑↓/jk move   enter jump   esc/q close";
const CLEAR_SCREEN = "\x1b[H\x1b[2J";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const DISABLE_LINE_WRAP = "\x1b[?7l";
const ENABLE_LINE_WRAP = "\x1b[?7h";
// Terminals draw CJK and emoji-presentation characters, ⚡ included, two columns wide
const WIDE_CHARACTER = /[\p{Emoji_Presentation}\p{Script=Han}\u1100-\u115F\u3000-\u30FF\uAC00-\uD7A3\uFF01-\uFF60\uFFE0-\uFFE6]/u;

const { herdrSocketPath, stateDir } = loadPluginEnv();
const controlPath = controlSocketPath(stateDir, herdrSocketPath);
const client = new HerdrClient(herdrSocketPath);

let rows: ServerRow[] = [];
let screenMessage: string | null = null;
let footerMessage: string | null = null;
let cursor = 0;
let scrollOffset = 0;
let busy = false;

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message) return error.message;
    if ("code" in error && typeof error.code === "string") return error.code;
  }
  return String(error);
}

async function loadRows(): Promise<void> {
  try {
    const [servers, { workspaces }, { tabs }, { panes }] = await Promise.all([
      queryServers(controlPath),
      client.request("workspace.list", {}),
      client.request("tab.list", {}),
      client.request("pane.list", {}),
    ]);
    rows = servers === null ? [] : serverRows({ servers, workspaces, tabs, panes });
    screenMessage = servers === null ? WATCHER_MISSING : rows.length === 0 ? NO_SERVERS : null;
  } catch (error) {
    rows = [];
    screenMessage = `Could not list servers: ${describeError(error)}`;
  }
  cursor = Math.min(cursor, Math.max(rows.length - 1, 0));
}

function displayWidth(text: string): number {
  return [...text].reduce((width, character) => width + (WIDE_CHARACTER.test(character) ? 2 : 1), 0);
}

function padEnd(text: string, width: number): string {
  return text + " ".repeat(Math.max(width - displayWidth(text), 0));
}

function clip(line: string, width: number): string {
  let clipped = "";
  let usedWidth = 0;
  for (const character of line) {
    usedWidth += displayWidth(character);
    if (usedWidth > width) break;
    clipped += character;
  }
  return clipped;
}

function render(): void {
  const width = process.stdout.columns || DEFAULT_COLUMNS;
  const height = process.stdout.rows || DEFAULT_ROWS;
  const lines: string[] = [];
  if (screenMessage !== null) {
    lines.push("", ` ${screenMessage}`);
    if (footerMessage !== null) lines.push("", ` ${footerMessage}`);
  } else {
    const title = " Dev servers";
    const count = `${rows.length} ${rows.length === 1 ? "server" : "servers"} `;
    lines.push(padEnd(title, width - displayWidth(count)) + count, "");

    const listHeight = Math.max(height - LINES_AROUND_LIST, 1);
    scrollOffset = Math.min(Math.max(scrollOffset, cursor - listHeight + 1), cursor);
    const widest = (texts: string[]) => Math.max(...texts.map(displayWidth));
    const portsWidth = widest(rows.map((row) => row.ports.join(" ")));
    const spaceWidth = widest(rows.map((row) => row.spaceLabel));
    const tabWidth = widest(rows.map((row) => row.tabLabel));
    rows.slice(scrollOffset, scrollOffset + listHeight).forEach((row, visibleIndex) => {
      const mark = scrollOffset + visibleIndex === cursor ? CURSOR_MARK : " ";
      const columns = [
        padEnd(row.ports.join(" "), portsWidth),
        padEnd(row.spaceLabel, spaceWidth),
        padEnd(row.tabLabel, tabWidth),
        row.paneName ?? "",
      ];
      lines.push(`${mark} ${columns.join(COLUMN_GAP)}`.trimEnd());
    });

    lines.push("", footerMessage === null ? "" : `  ${footerMessage}`, `  ${KEY_HINTS}`);
  }
  process.stdout.write(CLEAR_SCREEN + lines.map((line) => clip(line, width)).join("\r\n"));
}

function restoreTerminal(): void {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(SHOW_CURSOR + ENABLE_LINE_WRAP);
}

async function jump(row: ServerRow): Promise<void> {
  busy = true;
  try {
    await client.request("pane.focus", { pane_id: row.paneId });
    process.exit(0);
  } catch (error) {
    if (error instanceof HerdrError && error.code === "pane_not_found") {
      await loadRows();
      footerMessage = PANE_GONE;
    } else {
      footerMessage = `Could not jump: ${describeError(error)}`;
    }
  } finally {
    busy = false;
  }
  render();
}

function onKeypress(_text: string | undefined, key: readline.Key | undefined): void {
  const name = key?.name;
  const isClose = name === "escape" || name === "q" || (key?.ctrl === true && name === "c");
  if (isClose) process.exit(0);
  if (busy) return;
  if (screenMessage !== null) process.exit(0);

  const selected = rows[cursor];
  if (name === "up" || name === "k") cursor = Math.max(cursor - 1, 0);
  else if (name === "down" || name === "j") cursor = Math.min(cursor + 1, rows.length - 1);
  else if (name === "return" && selected) {
    void jump(selected);
    return;
  } else return;
  render();
}

process.on("exit", restoreTerminal);
await loadRows();
// Node reads only escapeCodeTimeout from this argument; the 500 ms default delays a lone Esc
readline.emitKeypressEvents(process.stdin, { escapeCodeTimeout: ESCAPE_CODE_TIMEOUT_MS } as unknown as readline.Interface);
process.stdin.setRawMode(true);
process.stdin.on("keypress", onKeypress);
process.stdout.on("resize", render);
process.stdout.write(HIDE_CURSOR + DISABLE_LINE_WRAP);
render();
