import net from "node:net";
import type { HerdrErrorBody, HerdrEvent, HerdrMethod, HerdrMethods, HerdrOp, PluginListResult, SubscriptionType } from "./herdr-types.ts";

const SUBSCRIPTION_REQUEST_ID = "s1";
const REQUEST_TIMEOUT_MS = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// herdr speaks newline-delimited JSON over a Unix socket: one object per line
function onJsonLines(socket: net.Socket, handleMessage: (message: Record<string, unknown>) => void) {
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(message)) continue;
      handleMessage(message);
    }
  });
}

function connectSocket(socketPath: string) {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => {
      socket.removeListener("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

export class HerdrError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

function toHerdrError({ code, message }: HerdrErrorBody) {
  return new HerdrError(message, code);
}

function isErrorBody(value: unknown): value is HerdrErrorBody {
  return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string" && "message" in value && typeof value.message === "string";
}

export class HerdrClient {
  #socketPath: string;
  #nextId = 1;
  #closed = false;

  static async connect(socketPath: string) {
    (await connectSocket(socketPath)).destroy();
    return new HerdrClient(socketPath);
  }

  constructor(socketPath: string) {
    this.#socketPath = socketPath;
  }

  // herdr answers one request per connection and then closes it
  request<M extends HerdrMethod>(method: M, params: HerdrMethods[M]["params"]): Promise<HerdrMethods[M]["result"]> {
    if (this.#closed) return Promise.reject(new Error("herdr client closed"));
    const id = String(this.#nextId++);
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.#socketPath);
      let settled = false;
      const settle = (outcome: { error: Error } | { result: HerdrMethods[M]["result"] }) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if ("error" in outcome) reject(outcome.error);
        else resolve(outcome.result);
      };
      socket.setTimeout(REQUEST_TIMEOUT_MS, () => settle({ error: new Error(`${method} timed out`) }));
      socket.on("error", (error) => settle({ error }));
      socket.on("close", () => settle({ error: new Error("herdr socket closed") }));
      onJsonLines(socket, (message) => {
        if (message.id !== id) return;
        if (message.error) settle({ error: isErrorBody(message.error) ? toHerdrError(message.error) : new Error(`${method} failed`) });
        else settle({ result: message.result as HerdrMethods[M]["result"] });
      });
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  close(): void {
    this.#closed = true;
  }
}

export async function subscribeEvents(
  socketPath: string,
  types: SubscriptionType[],
  { onEvent, onClose }: { onEvent: (event: HerdrEvent) => void; onClose: () => void },
): Promise<{ close(): void }> {
  const socket = await connectSocket(socketPath);
  let closeNotified = false;
  const notifyClose = () => {
    if (closeNotified) return;
    closeNotified = true;
    onClose();
  };

  await new Promise<void>((resolve, reject) => {
    let started = false;
    socket.on("error", () => {});
    socket.on("close", () => {
      if (!started) reject(new Error("herdr socket closed before subscription started"));
      notifyClose();
    });
    onJsonLines(socket, (message) => {
      if (typeof message.event === "string") {
        if (started && isRecord(message.data)) onEvent(message as HerdrEvent);
        return;
      }
      if (message.error) {
        if (started) socket.destroy();
        else reject(isErrorBody(message.error) ? toHerdrError(message.error) : new Error("events.subscribe failed"));
        return;
      }
      const { result } = message;
      if (typeof result === "object" && result !== null && "type" in result && result.type === "subscription_started") {
        started = true;
        resolve();
      }
    });
    const subscriptions = types.map((type) => ({ type }));
    socket.write(`${JSON.stringify({ id: SUBSCRIPTION_REQUEST_ID, method: "events.subscribe", params: { subscriptions } })}\n`);
  }).catch((error) => {
    socket.destroy();
    throw error;
  });

  return { close: () => socket.destroy() };
}

export function pluginIsEnabled(pluginList: PluginListResult, pluginId: string): boolean {
  const plugin = pluginList.plugins.find((entry) => entry.plugin_id === pluginId);
  return plugin !== undefined && plugin.enabled !== false;
}

export async function applyOps(client: HerdrClient, ops: HerdrOp[], log: (message: string) => void): Promise<void> {
  for (const { method, params } of ops) {
    try {
      await client.request(method, params);
    } catch (error) {
      const reason = error instanceof HerdrError ? error.message || error.code : String(error instanceof Error ? error.message : error);
      log(`${method} failed: ${reason}`);
    }
  }
}
