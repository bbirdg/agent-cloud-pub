/**
 * Device tokens: one per PC (scope "full": agents, the session hook, setup) or for the backup workflow (scope
 * "backup": export routes only). Only a token's SHA-256 is stored; the token is shown once, or saved straight to
 * this PC (--save) or handed to another command (--stdout), never both shown and saved.
 *
 *   agent-cloud device add <name> [--scope backup] [--save | --stdout]
 *   agent-cloud device list
 *   agent-cloud device revoke <name>
 *   add --local to use the local dev database instead of the deployed one.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readSettings, requireProject, saveSecret } from "./project.ts";
import { wrangler, writeWranglerConfig } from "./wrangler.ts";

const sql = (v: string) => `'${v.replace(/'/g, "''")}'`;

export function newToken(): { token: string; hash: string } {
  const token = `amem_${randomBytes(32).toString("base64url")}`;
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

export async function main(args: string[]): Promise<void> {
  const value = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const project = requireProject(value("--project"));
  const settings = readSettings(project);
  writeWranglerConfig(project, settings);
  const target = args.includes("--local") ? "--local" : "--remote";
  const d1 = (command: string) => {
    const out = wrangler(project, ["d1", "execute", settings.memory.d1.name, target, "--json", "--command", command], { input: "" });
    return JSON.parse(out) as { results: Record<string, unknown>[]; meta?: { changes?: number } }[];
  };
  const [action, name] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.match(/^--(scope|project)$/));

  if (action === "add" || action === "issue") {
    if (!name) throw new Error("Name the device: agent-cloud device add <name>");
    const scope = value("--scope") ?? "full";
    if (scope !== "full" && scope !== "backup") throw new Error("--scope is full or backup");
    const token = issue(d1, name, scope);
    if (args.includes("--stdout")) return void process.stdout.write(token);
    if (args.includes("--save")) {
      saveSecret("AGENT_MEMORY_TOKEN", token);
      return console.log(`Device "${name}" added (${scope}) and saved on this PC. Restart your agents.`);
    }
    console.log(`Device "${name}" added (${scope}). Its token, shown only now:\n\n  ${token}\n`);
    console.log("On that PC, save it with:  npx agent-cloud secret set AGENT_MEMORY_TOKEN   (then paste it)");
    return;
  }
  if (action === "list") {
    const rows = d1("SELECT name, scope, created_at, last_used_at, revoked_at FROM devices ORDER BY created_at")[0]?.results ?? [];
    console.table(rows);
    return;
  }
  if (action === "revoke") {
    if (!name) throw new Error("Name the device: agent-cloud device revoke <name>");
    const result = d1(
      `UPDATE devices SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ${sql(name)} AND revoked_at IS NULL; ` +
        `INSERT INTO audit (actor, action, detail) VALUES ('agent-cloud', 'device-revoke', ${sql(name)});`,
    );
    console.log((result[0]?.meta?.changes ?? 0) > 0 ? `Revoked "${name}". It can no longer reach memory.` : `No active device named "${name}".`);
    return;
  }
  throw new Error("Use: agent-cloud device add <name> | list | revoke <name>");
}

/** Adds a device and returns its token. */
export function issue(d1: (command: string) => unknown, name: string, scope: "full" | "backup"): string {
  const { token, hash } = newToken();
  d1(
    `INSERT INTO devices (id, name, token_hash, scope) VALUES (${sql(randomUUID())}, ${sql(name)}, '${hash}', '${scope}'); ` +
      `INSERT INTO audit (actor, action, detail) VALUES ('agent-cloud', 'device-issue', ${sql(`${name} (${scope})`)});`,
  );
  return token;
}
