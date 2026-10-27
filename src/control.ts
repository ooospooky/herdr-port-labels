import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";

const QUIT_POLL_INTERVAL_MS = 100;
const REQUEST_TIMEOUT_MS = 3000;
const SOCKET_PATH_MAX_BYTES = 100;

export interface ControlIdentity {
  version: string;
  pluginRoot: string;
}

export interface ServerPane {
  pane_id: string;
  ports: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isControlIdentity(value: unknown): value is ControlIdentity {
  return isRecord(value) && typeof value.version === "string" && typeof value.pluginRoot === "string";
}

function isServerPane(value: unknown): value is ServerPane {
  return (
    isRecord(value) &&
    typeof value.pane_id === "string" &&
    Array.isArray(value.ports) &&
    value.ports.every((port) => typeof port === "number")
  );
}

export function controlSocketPath(stateDir: string, herdrSocketPath: string): string {
  const hash = createHash("sha1").update(herdrSocketPath).digest("hex").slice(0, 12);
  const preferredPath = path.join(stateDir, `watch-${hash}.sock`);
  if (Buffer.byteLength(preferredPath) <= SOCKET_PATH_MAX_BYTES) return preferredPath;
  // macOS rejects Unix socket paths longer than 103 bytes
  return path.join(os.tmpdir(), `herdr-port-labels-${hash}.sock`);
}

export async function startControlServer(
  socketPath: string,
  identity: ControlIdentity,
  onQuit: () => void,
  listServers: () => ServerPane[] = () => [],
): Promise<{ close(): Promise<void> }> {
  if (await queryControl(socketPath)) {
    throw Object.assign(new Error(`a watcher already answers on ${socketPath}`), { code: "already_running" });
  }
  await unlink(socketPath).catch((error) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  });

  const sockets = new Set<net.Socket>();
  let quitRequested = false;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line, socket);
    });
  });

  function handleLine(line: string, socket: net.Socket) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      message = {};
    }
    const op = isRecord(message) ? message.op : undefined;
    if (op === "version") {
      socket.write(`${JSON.stringify(identity)}\n`);
    } else if (op === "servers") {
      socket.write(`${JSON.stringify({ panes: listServers() })}\n`);
    } else if (op === "quit") {
      socket.write(`${JSON.stringify({ ok: true })}\n`, () => {
        if (quitRequested) return;
        quitRequested = true;
        onQuit();
      });
    } else {
      socket.write(`${JSON.stringify({ error: "unknown_op" })}\n`);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      server.on("error", () => {});
      resolve();
    });
  });

  return {
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketPath).catch(() => {});
    },
  };
}

function sendRequest(socketPath: string, payload: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const finish = (reply: unknown) => {
      socket.destroy();
      resolve(reply);
    };
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      try {
        finish(JSON.parse(buffer.slice(0, newlineIndex)));
      } catch {
        finish(null);
      }
    });
    socket.write(`${JSON.stringify(payload)}\n`);
  });
}

export async function queryControl(socketPath: string): Promise<ControlIdentity | null> {
  const reply = await sendRequest(socketPath, { op: "version" });
  return isControlIdentity(reply) ? reply : null;
}

export async function queryServers(socketPath: string): Promise<ServerPane[] | null> {
  const reply = await sendRequest(socketPath, { op: "servers" });
  if (!isRecord(reply) || !Array.isArray(reply.panes) || !reply.panes.every(isServerPane)) return null;
  return reply.panes;
}

export async function requestQuit(socketPath: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  if (!(await sendRequest(socketPath, { op: "quit" }, timeoutMs))) return;
  while (Date.now() < deadline) {
    if (!(await queryControl(socketPath))) return;
    await new Promise((resolve) => setTimeout(resolve, QUIT_POLL_INTERVAL_MS));
  }
}
