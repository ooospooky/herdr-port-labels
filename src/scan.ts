import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LSOF_NO_MATCH_EXIT_CODE = 1;
const COMMAND_TIMEOUT_MS = 10000;

export interface Listener {
  pid: number;
  port: number;
}

export type RunCommand = (file: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;

interface ExecFailure { code?: unknown; signal?: unknown; killed?: unknown; stdout?: unknown; stderr?: unknown }

function isExecFailure(error: unknown): error is ExecFailure {
  return typeof error === "object" && error !== null;
}

// promisified execFile reports a timeout as killed plus a signal with a null code, and says only "Command failed"
function describeCommandFailure(file: string, error: unknown): Error {
  if (!isExecFailure(error)) return new Error(`${file} failed: ${String(error)}`);
  if (typeof error.signal === "string") {
    return new Error(error.killed === true ? `${file} timed out after ${COMMAND_TIMEOUT_MS} ms (${error.signal})` : `${file} was killed by ${error.signal}`);
  }
  if (typeof error.code === "number") {
    const stderrFirstLine = typeof error.stderr === "string" ? error.stderr.split("\n").find((line) => line.trim() !== "") : undefined;
    return new Error(`${file} exited ${error.code}${stderrFirstLine === undefined ? "" : `: ${stderrFirstLine}`}`);
  }
  return error instanceof Error ? error : new Error(`${file} failed: ${String(error)}`);
}

export function parseLsofListeners(text: string): Listener[] {
  const listeners: Listener[] = [];
  const seen = new Set<string>();
  let currentPid: number | null = null;
  for (const line of text.split("\n")) {
    const value = line.slice(1);
    if (line.startsWith("p")) {
      currentPid = Number(value);
      continue;
    }
    if (!line.startsWith("n") || currentPid === null) continue;
    const port = Number(value.slice(value.lastIndexOf(":") + 1));
    if (!Number.isInteger(port)) continue;
    const key = `${currentPid}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    listeners.push({ pid: currentPid, port });
  }
  return listeners;
}

export interface ProcessTree {
  parentOf: Map<number, number>;
  commandNameOf: Map<number, string>;
}

const PS_LINE = /^(\d+)\s+(\d+)\s*(.*)$/;

export function parsePsTree(text: string): ProcessTree {
  const parentOf = new Map<number, number>();
  const commandNameOf = new Map<number, string>();
  for (const line of text.split("\n")) {
    const match = PS_LINE.exec(line.trim());
    if (match === null) continue;
    const [, pid, parentPid, command] = match;
    parentOf.set(Number(pid), Number(parentPid));
    if (command) commandNameOf.set(Number(pid), path.basename(command));
  }
  return { parentOf, commandNameOf };
}

export async function listListeners(runCommand: RunCommand = execFileAsync): Promise<Listener[]> {
  try {
    const { stdout } = await runCommand("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], { timeout: COMMAND_TIMEOUT_MS });
    return parseLsofListeners(stdout);
  } catch (error) {
    // lsof exits 1 when nothing matches, and also when it only warned about unreadable processes
    if (isExecFailure(error) && error.code === LSOF_NO_MATCH_EXIT_CODE) return parseLsofListeners(typeof error.stdout === "string" ? error.stdout : "");
    throw describeCommandFailure("lsof", error);
  }
}

export async function listProcessTree(runCommand: RunCommand = execFileAsync): Promise<ProcessTree> {
  try {
    const { stdout } = await runCommand("ps", ["-A", "-o", "pid=,ppid=,comm="], { timeout: COMMAND_TIMEOUT_MS });
    return parsePsTree(stdout);
  } catch (error) {
    throw describeCommandFailure("ps", error);
  }
}
