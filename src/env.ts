import path from "node:path";
import { readFileSync } from "node:fs";

const MISSING_ENV_EXIT_CODE = 2;
const REQUIRED_ENV = ["HERDR_SOCKET_PATH", "HERDR_PLUGIN_STATE_DIR", "HERDR_PLUGIN_ROOT"];

export interface PluginEnv {
  herdrSocketPath: string;
  stateDir: string;
  pluginRoot: string;
  version: string;
}

function readPackageVersion(pluginRoot: string): string {
  const parsed: unknown = JSON.parse(readFileSync(path.join(pluginRoot, "package.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || typeof parsed.version !== "string") {
    throw new Error(`port-labels: ${pluginRoot}/package.json has no string version`);
  }
  return parsed.version;
}

export function loadPluginEnv(): PluginEnv {
  const herdrSocketPath = process.env.HERDR_SOCKET_PATH;
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  const pluginRoot = process.env.HERDR_PLUGIN_ROOT;
  if (!herdrSocketPath || !stateDir || !pluginRoot) {
    const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
    console.error(`port-labels: missing ${missing.join(", ")}; run this through herdr`);
    process.exit(MISSING_ENV_EXIT_CODE);
  }
  return { herdrSocketPath, stateDir, pluginRoot, version: readPackageVersion(pluginRoot) };
}
