import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** Runs npm or npx through Node itself (Windows can't start their .cmd shims without a shell, which mangles arguments). */
export function npmRun(tool: "npm" | "npx", args: string[], opts: ExecFileSyncOptions = {}) {
  const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", `${tool}-cli.js`);
  const base: ExecFileSyncOptions = { windowsHide: true, timeout: 600_000, ...opts };
  return existsSync(cli) ? execFileSync(process.execPath, [cli, ...args], base) : execFileSync(tool, args, base);
}
