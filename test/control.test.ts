import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { controlSocketPath, startControlServer, queryControl, queryServers, requestQuit } from "../src/control.ts";
import type { ControlIdentity, ServerPane } from "../src/control.ts";

const identity: ControlIdentity = { version: "0.1.0", pluginRoot: "/plugins/herdr-port-labels" };
const handles: Array<{ close(): Promise<void> }> = [];

const tmpSocketPath = () => path.join(os.tmpdir(), `herdr-control-${randomBytes(6).toString("hex")}.sock`);

async function startTracked(socketPath: string, onQuit: () => void = () => {}, listServers?: () => ServerPane[]) {
  const handle = await startControlServer(socketPath, identity, onQuit, listServers);
  handles.push(handle);
  return handle;
}

function sendLine(socketPath: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
    });
    socket.write(`${JSON.stringify(payload)}\n`);
  });
}

after(async () => {
  for (const handle of handles) await handle.close();
});

test("controlSocketPath is stable per herdr socket and lives under the state dir", () => {
  const first = controlSocketPath("/state", "/run/herdr-a.sock");
  assert.equal(first, controlSocketPath("/state", "/run/herdr-a.sock"));
  assert.notEqual(first, controlSocketPath("/state", "/run/herdr-b.sock"));
  assert.match(first, /^\/state\/watch-[0-9a-f]{12}\.sock$/);
});

test("controlSocketPath falls back to the temp dir when the state dir path is too long", () => {
  const longStateDir = path.join("/state", "deeply-nested-directory".repeat(6));
  const socketPath = controlSocketPath(longStateDir, "/run/herdr-a.sock");
  assert.equal(path.dirname(socketPath), os.tmpdir());
  assert.match(path.basename(socketPath), /^herdr-port-labels-[0-9a-f]{12}\.sock$/);
  assert.ok(Buffer.byteLength(socketPath) <= 100);
});

test("queryControl returns null when nothing listens", async () => {
  assert.equal(await queryControl(tmpSocketPath()), null);
});

test("queryControl returns null when the socket file is stale", async () => {
  const socketPath = tmpSocketPath();
  const stale = net.createServer();
  await new Promise<void>((resolve) => stale.listen(socketPath, resolve));
  // Closing unlinks the file, so recreate it as a leftover with no listener.
  stale.close();
  await new Promise<void>((resolve) => stale.once("close", resolve));
  fs.writeFileSync(socketPath, "");
  try {
    assert.equal(await queryControl(socketPath), null);
  } finally {
    fs.unlinkSync(socketPath);
  }
});

test("startControlServer answers version and quit", async () => {
  const socketPath = tmpSocketPath();
  let quitCalls = 0;
  await startTracked(socketPath, () => {
    quitCalls += 1;
  });

  assert.deepEqual(await queryControl(socketPath), identity);
  assert.deepEqual(await sendLine(socketPath, { op: "bogus" }), { error: "unknown_op" });
  for (const malformed of [null, 42, "text", [1]]) {
    assert.deepEqual(await sendLine(socketPath, malformed), { error: "unknown_op" });
  }
  assert.equal(quitCalls, 0);
  assert.deepEqual(await sendLine(socketPath, { op: "quit" }), { ok: true });
  assert.equal(quitCalls, 1);
});

test("startControlServer replaces a stale socket file", async () => {
  const socketPath = tmpSocketPath();
  fs.writeFileSync(socketPath, "");
  await startTracked(socketPath);
  assert.deepEqual(await queryControl(socketPath), identity);
});

test("startControlServer refuses a socket a live watcher answers on", async () => {
  const socketPath = tmpSocketPath();
  await startTracked(socketPath);
  await assert.rejects(startControlServer(socketPath, { ...identity, version: "9.9.9" }, () => {}), {
    code: "already_running",
  });
  assert.deepEqual(await queryControl(socketPath), identity);
});

test("close stops listening and removes the socket file", async () => {
  const socketPath = tmpSocketPath();
  const handle = await startControlServer(socketPath, identity, () => {});
  await handle.close();
  assert.equal(fs.existsSync(socketPath), false);
  assert.equal(await queryControl(socketPath), null);
});

test("requestQuit resolves once the server is gone", async () => {
  const socketPath = tmpSocketPath();
  let handle: { close(): Promise<void> } | undefined;
  handle = await startTracked(socketPath, () => void handle?.close());
  await requestQuit(socketPath);
  assert.equal(await queryControl(socketPath), null);
});

test("requestQuit resolves at the timeout when the server stays up", async () => {
  const socketPath = tmpSocketPath();
  await startTracked(socketPath);
  const startedAt = Date.now();
  await requestQuit(socketPath, 300);
  assert.ok(Date.now() - startedAt >= 300);
  assert.deepEqual(await queryControl(socketPath), identity);
});

test("the servers op answers what listServers returns at the time of the request", async () => {
  const socketPath = tmpSocketPath();
  let current: ServerPane[] = [{ pane_id: "w3:p2", ports: [5173, 5174] }];
  await startTracked(socketPath, () => {}, () => current);

  assert.deepEqual(await sendLine(socketPath, { op: "servers" }), { panes: [{ pane_id: "w3:p2", ports: [5173, 5174] }] });
  current = [{ pane_id: "w1:p1", ports: [3000] }];
  assert.deepEqual(await sendLine(socketPath, { op: "servers" }), { panes: [{ pane_id: "w1:p1", ports: [3000] }] });
  assert.deepEqual(await sendLine(socketPath, { op: "bogus" }), { error: "unknown_op" });
});

test("the servers op answers an empty list when the watcher passes no listServers", async () => {
  const socketPath = tmpSocketPath();
  await startTracked(socketPath);
  assert.deepEqual(await sendLine(socketPath, { op: "servers" }), { panes: [] });
});

test("queryServers returns null when nothing listens", async () => {
  assert.equal(await queryServers(tmpSocketPath()), null);
});

test("queryServers returns null for an older watcher that does not know the servers op", async () => {
  const socketPath = tmpSocketPath();
  const olderWatcher = net.createServer((socket) => {
    socket.on("data", () => socket.write(`${JSON.stringify({ error: "unknown_op" })}\n`));
  });
  await new Promise<void>((resolve) => olderWatcher.listen(socketPath, resolve));
  try {
    assert.equal(await queryServers(socketPath), null);
  } finally {
    await new Promise<void>((resolve) => olderWatcher.close(() => resolve()));
  }
});

test("queryServers returns null for a reply that is not a pane list", async () => {
  const socketPath = tmpSocketPath();
  const oddWatcher = net.createServer((socket) => {
    socket.on("data", () => socket.write(`${JSON.stringify({ panes: [{ pane_id: "w1:p1", ports: ["5173"] }] })}\n`));
  });
  await new Promise<void>((resolve) => oddWatcher.listen(socketPath, resolve));
  try {
    assert.equal(await queryServers(socketPath), null);
  } finally {
    await new Promise<void>((resolve) => oddWatcher.close(() => resolve()));
  }
});

test("queryServers returns the panes of a current watcher", async () => {
  const socketPath = tmpSocketPath();
  await startTracked(socketPath, () => {}, () => [{ pane_id: "w3:p2", ports: [5173] }]);
  assert.deepEqual(await queryServers(socketPath), [{ pane_id: "w3:p2", ports: [5173] }]);
});
