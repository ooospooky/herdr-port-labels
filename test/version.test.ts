import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readRepoFile = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

test("herdr-plugin.toml and package.json carry the same version", () => {
  const manifestVersion = readRepoFile("herdr-plugin.toml").match(/^version = "([^"]+)"$/m)?.[1];
  const { version: packageVersion } = JSON.parse(readRepoFile("package.json"));
  assert.equal(manifestVersion, packageVersion);
});

test("package.json, with-node.sh and the README agree on the Node floor", () => {
  const { engines } = JSON.parse(readRepoFile("package.json")) as { engines: { node: string } };
  assert.equal(engines.node, ">=22.18");
  assert.match(readRepoFile("scripts/with-node.sh"), /^MIN_NODE_VERSION="22\.18"$/m);
  assert.match(readRepoFile("README.md"), /Node\.js 22\.18 or later/);
});
