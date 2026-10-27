import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/with-node.sh", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "with-node-"));
after(() => rmSync(base, { recursive: true, force: true }));
const tools = join(base, "tools");
mkdirSync(tools);
for (const name of ["sh", "sed", "dirname", "sort", "ls", "tr", "cut", "cat"]) {
  const realPath = execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
  symlinkSync(realPath, join(tools, name));
}

const printArguments = 'for argument in "$@"; do printf "%s\\n" "$argument"; done';
const printStdin = 'printf "stdin=[%s]\\n" "$(cat)"';

const fakeNode = (dir: string, version: string, otherwise = printArguments): void => {
  mkdirSync(dir, { recursive: true });
  const body = ["#!/bin/sh", `[ "$1" = "--version" ] && { echo "v${version}"; exit 0; }`, otherwise, ""].join("\n");
  writeFileSync(join(dir, "node"), body, { mode: 0o755 });
};

const run = (
  argv: string[],
  env: Record<string, string>,
  input?: string,
): Promise<{ code: number | null; out: string; err: string }> =>
  new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    if (command === undefined) throw new Error("run needs a command");
    const child = spawn(command, args, { env });
    child.stdin.end(input ?? "");
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });

test("runs the node on PATH when it is new enough and keeps argument boundaries", async () => {
  const home = join(base, "home-path");
  const nodeDir = join(home, "node-bin");
  fakeNode(nodeDir, "22.18.0");
  const result = await run(["sh", script, "src/x.ts", "two words", ""], { HOME: home, PATH: `${tools}:${nodeDir}` });
  assert.equal(result.code, 0);
  assert.equal(result.out, "src/x.ts\ntwo words\n\n");
});

test("skips a node older than 22.18 on PATH and takes a newer one from an extra dir", async () => {
  const home = join(base, "home-extra");
  const nodeDir = join(home, "node-bin");
  const extra = join(home, "extra");
  fakeNode(nodeDir, "22.14.0");
  fakeNode(extra, "24.1.0");
  const result = await run(["sh", script, "--version"], {
    HOME: home,
    PATH: `${tools}:${nodeDir}`,
    WITH_NODE_EXTRA_DIRS: extra,
  });
  assert.equal(result.code, 0);
  assert.equal(result.out.trim(), "v24.1.0");
});

test("skips Node 23.0 to 23.5, which strip types only behind a flag", async () => {
  const home = join(base, "home-23");
  const nodeDir = join(home, "node-bin");
  const extra = join(home, "extra");
  fakeNode(nodeDir, "23.5.0");
  fakeNode(extra, "24.1.0");
  const result = await run(["sh", script, "--version"], {
    HOME: home,
    PATH: `${tools}:${nodeDir}`,
    WITH_NODE_EXTRA_DIRS: extra,
  });
  assert.equal(result.code, 0);
  assert.equal(result.out.trim(), "v24.1.0");
});

test("exits 127 with the version floor when no node qualifies", async () => {
  const home = join(base, "home-none");
  const nodeDir = join(home, "node-bin");
  fakeNode(nodeDir, "20.19.0");
  const result = await run(["sh", script, "--version"], {
    HOME: home,
    PATH: `${tools}:${nodeDir}`,
    WITH_NODE_EXTRA_DIRS: join(home, "missing"),
  });
  assert.equal(result.code, 127);
  assert.equal(result.out, "");
  assert.match(result.err, /Node 22\.18/);
});

test("prefers the highest version among nvm-style version directories", async () => {
  const home = join(base, "home-nvm");
  fakeNode(join(home, ".nvm/versions/node/v22.18.0/bin"), "22.18.0");
  fakeNode(join(home, ".nvm/versions/node/v24.1.0/bin"), "24.1.0");
  const result = await run(["sh", script, "--version"], { HOME: home, PATH: tools });
  assert.equal(result.code, 0);
  assert.equal(result.out.trim(), "v24.1.0");
});

test("finds a node under a home directory whose name has a space", async () => {
  const home = join(base, "alice smith");
  fakeNode(join(home, ".volta/bin"), "22.18.0");
  fakeNode(join(base, "alice"), "9.9.9");
  const result = await run(["sh", script, "--version"], { HOME: home, PATH: tools });
  assert.equal(result.code, 0);
  assert.equal(result.out.trim(), "v22.18.0");
});

test("hands the caller's stdin to a node found in a version directory", async () => {
  const home = join(base, "home-stdin");
  fakeNode(join(home, ".nvm/versions/node/v22.18.0/bin"), "22.18.0", printStdin);
  fakeNode(join(home, ".nvm/versions/node/v24.1.0/bin"), "24.1.0", printStdin);
  const result = await run(["sh", script, "src/x.ts"], { HOME: home, PATH: tools }, "PAYLOAD");
  assert.equal(result.code, 0);
  assert.equal(result.out, "stdin=[PAYLOAD]\n");
});

test("the manifest runs every TypeScript command through with-node.sh and opens the popup without it", () => {
  const manifest = readFileSync(new URL("../herdr-plugin.toml", import.meta.url), "utf8");
  const commands = [...manifest.matchAll(/^command = (\[.*\])$/gm)].map((match) => JSON.parse(match[1] ?? "[]") as string[]);
  assert.equal(commands.length, 5);
  const viaShim = commands.filter((command) => command[0] === "sh" && command[1] === "scripts/with-node.sh");
  for (const command of commands.filter((entry) => entry.some((argument) => argument.endsWith(".ts")))) {
    assert.ok(viaShim.includes(command), `${JSON.stringify(command)} skips with-node.sh`);
  }
  assert.equal(viaShim.filter((command) => command[2] === "src/ensure-watch.ts").length, 2);
  assert.equal(viaShim.filter((command) => command[2] === "src/servers-popup.ts").length, 1);
  assert.equal(viaShim.filter((command) => command[2] === "--version").length, 1);
  const withoutShim = commands.filter((command) => !viaShim.includes(command));
  assert.equal(withoutShim.length, 1);
  assert.match(withoutShim[0]?.join(" ") ?? "", /plugin pane open --plugin ooospooky\.port-labels --entrypoint servers --focus/);
});
