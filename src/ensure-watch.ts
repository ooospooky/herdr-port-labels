import path from "node:path";
import { spawn } from "node:child_process";
import { mkdirSync, openSync, statSync, truncateSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadPluginEnv } from "./env.ts";
import { controlSocketPath, queryControl, requestQuit } from "./control.ts";

const QUIT_WAIT_MS = 10000;
const LOG_MAX_BYTES = 1024 * 1024;

const watchPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "watch.ts");
const { herdrSocketPath, stateDir, pluginRoot, version } = loadPluginEnv();
const controlPath = controlSocketPath(stateDir, herdrSocketPath);

const running = await queryControl(controlPath);
if (running?.version === version && running?.pluginRoot === pluginRoot) process.exit(0);
if (running) {
  console.error(`port-labels: replacing watcher ${running.version} at ${running.pluginRoot}`);
  await requestQuit(controlPath, QUIT_WAIT_MS);
}

mkdirSync(stateDir, { recursive: true });
const logPath = path.join(stateDir, "watch.log");
const logSize = statSync(logPath, { throwIfNoEntry: false })?.size ?? 0;
if (logSize > LOG_MAX_BYTES) truncateSync(logPath);
const logFd = openSync(logPath, "a");
const child = spawn(process.execPath, [watchPath], { detached: true, stdio: ["ignore", "ignore", logFd], env: process.env });
child.unref();
process.exit(0);
