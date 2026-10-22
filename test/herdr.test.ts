import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { HerdrClient, subscribeEvents, applyOps, pluginIsEnabled } from "../src/herdr.ts";
import type { HerdrEvent, InstalledPluginInfo, PluginListResult } from "../src/herdr-types.ts";

const servers: { server: net.Server; sockets: Set<net.Socket> }[] = [];

async function startFakeServer(onMessage: (message: { id: string; method: string; params: unknown }, socket: net.Socket) => void) {
  const socketPath = path.join(os.tmpdir(), `herdr-test-${randomBytes(6).toString("hex")}.sock`);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) onMessage(JSON.parse(line), socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  servers.push({ server, sockets });
  return socketPath;
}

after(() => {
  for (const { server, sockets } of servers) {
    for (const socket of sockets) socket.destroy();
    server.close();
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

const reply = (socket: net.Socket, payload: unknown) => socket.write(`${JSON.stringify(payload)}\n`);

test("request resolves result and rejects herdr errors with code", async () => {
  const socketPath = await startFakeServer((message, socket) => {
    if (message.method === "tab.list") {
      reply(socket, { id: message.id, result: { type: "tab_info", tab: { tab_id: "w1:t1" } } });
    } else {
      reply(socket, { id: message.id, error: { code: "tab_not_found", message: "tab nope:t9 not found" } });
    }
  });
  const client = await HerdrClient.connect(socketPath);
  try {
    const result = await client.request("tab.list", {});
    assert.deepEqual(result, { type: "tab_info", tab: { tab_id: "w1:t1" } });
    await assert.rejects(client.request("tab.rename", { tab_id: "nope:t9", label: "x" }), {
      message: "tab nope:t9 not found",
      code: "tab_not_found",
    });
  } finally {
    client.close();
  }
});

test("request rejects when herdr replies with a malformed error", async () => {
  const socketPath = await startFakeServer((message, socket) => {
    reply(socket, { id: message.id, error: "boom" });
  });
  const client = await HerdrClient.connect(socketPath);
  try {
    await assert.rejects(client.request("tab.list", {}), { message: "tab.list failed" });
  } finally {
    client.close();
  }
});

test("request uses a fresh connection per call because herdr closes after one reply", async () => {
  const socketPath = await startFakeServer((message, socket) => {
    if (message.method === "pane.process_info") {
      socket.destroy();
      return;
    }
    reply(socket, { id: message.id, result: { method: message.method } });
    socket.end();
  });
  const client = await HerdrClient.connect(socketPath);
  assert.deepEqual(await client.request("pane.list", {}), { method: "pane.list" });
  assert.deepEqual(await client.request("tab.list", {}), { method: "tab.list" });
  await assert.rejects(client.request("pane.process_info", {}), { message: "herdr socket closed" });
  client.close();
  await assert.rejects(client.request("pane.list", {}), { message: "herdr client closed" });
});

test("subscribeEvents resolves after subscription_started, then delivers events and onClose", async () => {
  let receivedSubscribe: { method: string; params: unknown } | undefined;
  const socketPath = await startFakeServer((message, socket) => {
    receivedSubscribe = message;
    reply(socket, { id: message.id, result: { type: "subscription_started" } });
    reply(socket, { event: "tab_renamed", data: { type: "tab_renamed", tab_id: "w1:t1", label: "x" } });
    setTimeout(() => socket.end(), 20);
  });
  const events: HerdrEvent[] = [];
  let closeCount = 0;
  const closed = deferred();
  const subscription = await subscribeEvents(socketPath, ["tab.renamed", "pane.created"], {
    onEvent: (event) => events.push(event),
    onClose: () => {
      closeCount += 1;
      closed.resolve();
    },
  });
  await closed.promise;
  await new Promise((resolve) => setTimeout(resolve, 20));
  subscription.close();
  assert.equal(receivedSubscribe?.method, "events.subscribe");
  assert.deepEqual(receivedSubscribe?.params, { subscriptions: [{ type: "tab.renamed" }, { type: "pane.created" }] });
  assert.deepEqual(events, [{ event: "tab_renamed", data: { type: "tab_renamed", tab_id: "w1:t1", label: "x" } }]);
  assert.equal(closeCount, 1);
});

test("subscribeEvents treats events_lost like a close and calls onClose once", async () => {
  const socketPath = await startFakeServer((message, socket) => {
    reply(socket, { id: message.id, result: { type: "subscription_started" } });
    reply(socket, { id: message.id, error: { code: "events_lost", message: "lagged" } });
    socket.end();
  });
  let closeCount = 0;
  const closed = deferred();
  const events: HerdrEvent[] = [];
  await subscribeEvents(socketPath, ["tab.renamed"], {
    onEvent: (event) => events.push(event),
    onClose: () => {
      closeCount += 1;
      closed.resolve();
    },
  });
  await closed.promise;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closeCount, 1);
  assert.deepEqual(events, []);
});

test("subscribeEvents drops an event whose data is not an object", async () => {
  const socketPath = await startFakeServer((message, socket) => {
    reply(socket, { id: message.id, result: { type: "subscription_started" } });
    reply(socket, { event: "pane_closed", data: null });
    reply(socket, { event: "tab_renamed", data: { type: "tab_renamed", tab_id: "w1:t1", workspace_id: "w1", label: "x" } });
    socket.end();
  });
  const events: HerdrEvent[] = [];
  const closed = deferred();
  await subscribeEvents(socketPath, ["pane.closed", "tab.renamed"], {
    onEvent: (event) => events.push(event),
    onClose: closed.resolve,
  });
  await closed.promise;
  assert.deepEqual(events, [{ event: "tab_renamed", data: { type: "tab_renamed", tab_id: "w1:t1", workspace_id: "w1", label: "x" } }]);
});

test("applyOps continues past a failing op", async () => {
  const seen: string[] = [];
  const socketPath = await startFakeServer((message, socket) => {
    seen.push(message.method);
    if (message.method === "tab.rename") {
      reply(socket, { id: message.id, error: { code: "tab_not_found", message: "gone" } });
    } else {
      reply(socket, { id: message.id, result: { type: "ok" } });
    }
  });
  const client = await HerdrClient.connect(socketPath);
  const logs: string[] = [];
  try {
    await applyOps(
      client,
      [
        { method: "pane.rename", params: { pane_id: "w1:p1", label: null } },
        { method: "tab.rename", params: { tab_id: "w1:t1", label: "x" } },
        { method: "workspace.report_metadata", params: { workspace_id: "w1", source: "s", tokens: {} } },
      ],
      (message) => logs.push(message),
    );
  } finally {
    client.close();
  }
  assert.deepEqual(seen, ["pane.rename", "tab.rename", "workspace.report_metadata"]);
  assert.deepEqual(logs, ["tab.rename failed: gone"]);
});

test("pluginIsEnabled is false when the plugin is missing or disabled", () => {
  const listWith = (plugins: InstalledPluginInfo[]): PluginListResult => ({ type: "plugin_list", plugins });
  const ours = { plugin_id: "ooospooky.port-labels", enabled: true, plugin_root: "/plugins/port-labels", version: "0.1.0" };
  assert.equal(pluginIsEnabled(listWith([ours]), "ooospooky.port-labels"), true);
  assert.equal(pluginIsEnabled(listWith([{ ...ours, enabled: false }]), "ooospooky.port-labels"), false);
  assert.equal(pluginIsEnabled(listWith([{ ...ours, plugin_id: "other.plugin" }]), "ooospooky.port-labels"), false);
  assert.equal(pluginIsEnabled(listWith([]), "ooospooky.port-labels"), false);
});
