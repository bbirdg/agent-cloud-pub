/**
 * `agent-cloud setup`: creates and deploys your memory server on your Cloudflare account, and connects this PC.
 * Safe to run again: every step checks what already exists and only does what's missing.
 *
 *   agent-cloud setup [--domain memory.example.com] [--github-user <numeric id>] [--no-backup]
 *
 * 1. Signs Wrangler in to Cloudflare (a browser window) if it isn't yet.
 * 2. Creates the database (D1) and the sign-in store (KV), and records their ids in agent-cloud.json.
 * 3. Deploys; without a custom domain the address is your workers.dev one, recorded in agent-cloud.json.
 * 4. Sets the server's secrets: a random signing key, and the GitHub account allowed to sign in (claude.ai).
 * 5. Gives this PC a device token (saved in ~/.agent-cloud/secrets.json).
 * 6. Prints the one-click link that creates your private GitHub sign-in app (for claude.ai and its mobile app).
 * 7. With the GitHub CLI and a GitHub repo for this folder: sets up the nightly backup (a backup-only token as a
 *    repo secret, the address as a repo variable, and the memory-backup branch).
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deploy } from "./deploy.ts";
import { issue } from "./devices.ts";
import { ask } from "./prompt.ts";
import { readSecretsFile, readSettings, requireProject, saveSecret, type Settings, writeSettings } from "./project.ts";
import { wrangler, writeWranglerConfig } from "./wrangler.ts";

export async function main(args: string[]): Promise<void> {
  const value = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const project = requireProject(value("--project"));
  let s: Settings = readSettings(project, { allowNoUrl: true });
  const save = (next: Settings) => {
    s = next;
    writeSettings(project, s);
  };
  const step = (text: string) => console.log(`\n== ${text}`);
  const cf = (a: string[], input = "") => wrangler(project, a, { config: false, input });

  step("Cloudflare sign-in");
  // `whoami --json` exits non-zero when signed out (plain `whoami` exits 0 either way).
  const signedIn = () => {
    try {
      const me = JSON.parse(cf(["whoami", "--json"])) as { loggedIn?: boolean; email?: string };
      return me.loggedIn === false ? null : (me.email ?? "your account");
    } catch {
      return null;
    }
  };
  let account = signedIn();
  if (!account) {
    wrangler(project, ["login"], { config: false, inherit: true });
    account = signedIn();
    if (!account) throw new Error("Not signed in to Cloudflare. Run `npx wrangler login` in this folder, then setup again.");
  }
  console.log(`Signed in to Cloudflare as ${account}.`);

  const domain = value("--domain") ?? s.memory.domain ?? undefined;
  if (domain && (domain !== s.memory.domain || s.memory.url !== `https://${domain}`)) save({ ...s, memory: { ...s.memory, domain, url: `https://${domain}` } });

  step("Database and sign-in store");
  if (!s.memory.d1.id) {
    let id = "";
    try {
      id = /"?database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/.exec(cf(["d1", "create", s.memory.d1.name]))?.[1] ?? "";
    } catch {
      // already exists: look it up below
    }
    if (!id) {
      try {
        id = (JSON.parse(cf(["d1", "list", "--json"])) as { name: string; uuid: string }[]).find((d) => d.name === s.memory.d1.name)?.uuid ?? "";
      } catch {
        // reported below
      }
    }
    if (!id) throw new Error(`Could not create or find the D1 database "${s.memory.d1.name}" (\`npx wrangler d1 list\` shows what Cloudflare has).`);
    save({ ...s, memory: { ...s.memory, d1: { ...s.memory.d1, id } } });
  }
  console.log(`D1 database ${s.memory.d1.name}: ${s.memory.d1.id}`);
  if (!s.memory.kv.id) {
    const title = `${s.memory.worker}-oauth`;
    let id = "";
    try {
      id = /"?id"?\s*[:=]\s*"([0-9a-f]{32})"/.exec(cf(["kv", "namespace", "create", title]))?.[1] ?? "";
    } catch {
      // already exists: look it up below
    }
    if (!id) {
      try {
        id = (JSON.parse(cf(["kv", "namespace", "list"])) as { id: string; title: string }[]).find((n) => n.title === title || n.title.endsWith(`-${title}`))?.id ?? "";
      } catch {
        // reported below
      }
    }
    if (!id) throw new Error(`Could not create or find the KV namespace "${title}" (\`npx wrangler kv namespace list\` shows what Cloudflare has).`);
    save({ ...s, memory: { ...s.memory, kv: { id } } });
  }
  console.log(`KV namespace: ${s.memory.kv.id}`);

  step("Deploy");
  const out = await deploy(project, s.memory.url ? s : { ...s, memory: { ...s.memory, url: "https://example.invalid" } });
  if (!s.memory.url) {
    const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(out)?.[0];
    if (!url) throw new Error("Deployed, but Wrangler didn't print the workers.dev address. Put it in agent-cloud.json (memory.url) and run setup again.");
    save({ ...s, memory: { ...s.memory, url } });
    await deploy(project, s); // again, now that the server knows its own address
  }

  step("Server secrets");
  writeWranglerConfig(project, s);
  const existing = (() => {
    try {
      return (JSON.parse(wrangler(project, ["secret", "list"], { input: "" })) as { name: string }[]).map((x) => x.name);
    } catch {
      return [];
    }
  })();
  if (!existing.includes("MCP_STATE_SECRET")) {
    wrangler(project, ["secret", "put", "MCP_STATE_SECRET"], { input: randomBytes(48).toString("base64url") });
    console.log("MCP_STATE_SECRET set (a random signing key).");
  }
  if (!existing.includes("ALLOWED_GITHUB_USER_ID")) {
    let id = value("--github-user") ?? "";
    if (!id) {
      try {
        id = execFileSync("gh", ["api", "user", "--jq", ".id"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
        console.log(`Using the GitHub account the GitHub CLI is signed in to (id ${id}).`);
      } catch {
        id = await ask("Your GitHub account's numeric id (https://api.github.com/users/<your-login> shows it as \"id\"): ");
      }
    }
    if (!/^\d+$/.test(id)) throw new Error("A GitHub account id is a number.");
    wrangler(project, ["secret", "put", "ALLOWED_GITHUB_USER_ID"], { input: id });
    console.log("ALLOWED_GITHUB_USER_ID set: only that GitHub account can sign in from claude.ai.");
  }

  step("This PC");
  const d1 = (command: string) => JSON.parse(wrangler(project, ["d1", "execute", s.memory.d1.name, "--remote", "--json", "--command", command], { input: "" }));
  let token = process.env.AGENT_MEMORY_TOKEN || readSecretsFile().AGENT_MEMORY_TOKEN || "";
  if (!token) {
    token = issue(d1, os.hostname().toLowerCase(), "full");
    saveSecret("AGENT_MEMORY_TOKEN", token);
    console.log(`Device "${os.hostname().toLowerCase()}" added; its token is saved on this PC.`);
  } else console.log("This PC already has a device token.");
  const health = await fetch(`${s.memory.url}/health`).then((r) => r.text()).catch(() => "");
  console.log(health === "ok" ? `Memory server is up: ${s.memory.url}` : `Warning: ${s.memory.url}/health didn't answer "ok" yet (a new address can take a minute).`);

  step("Sign-in for claude.ai (one click)");
  const start = await fetch(`${s.memory.url}/setup/github-app/start`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
  const body = (await start?.json().catch(() => ({}))) as { url?: string; error?: string } | undefined;
  if (body?.url) console.log(`Open this link within 15 minutes and confirm on GitHub:\n  ${body.url}\nThen add ${s.memory.url}/mcp as a custom connector on claude.ai.`);
  else if (start?.status === 401) console.log("Skipped: the server refused this PC's device token (revoked, or from another server?). Fix it with `npx agent-cloud device add <name> --save`, then run setup again.");
  else console.log(body?.error ? `Skipped: ${body.error}` : "Skipped: couldn't reach the server; run setup again later.");

  if (!args.includes("--no-backup")) backupSetup(project, s, d1);

  console.log("\nDone. Next: `npx agent-cloud sync` to preview what your agents get, then `npx agent-cloud sync --apply --adopt`.");
}

/** The nightly backup: needs the GitHub CLI (gh) and this folder's GitHub repo (agent-cloud.json "repo"). */
function backupSetup(project: string, s: Settings, d1: (command: string) => unknown): void {
  console.log("\n== Nightly backup");
  const gh = (a: string[], input?: string) => execFileSync("gh", a, { encoding: "utf8", windowsHide: true, input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] }).trim();
  if (!s.repo) return console.log('Skipped: set "repo": "<owner>/<name>" in agent-cloud.json (this folder\'s private GitHub repo), then run setup again.');
  try {
    gh(["--version"]);
  } catch {
    return console.log("Skipped: the GitHub CLI (gh) isn't installed. Install it, run `gh auth login`, then run setup again.");
  }
  try {
    const visibility = gh(["repo", "view", s.repo, "--json", "visibility", "--jq", ".visibility"]);
    if (visibility !== "PRIVATE") return console.log(`Skipped: ${s.repo} is ${visibility.toLowerCase()}. The backup holds every note, so it only goes to a private repo.`);
    const secrets = gh(["secret", "list", "-R", s.repo, "--json", "name", "--jq", ".[].name"]).split("\n");
    if (!secrets.includes("AGENT_MEMORY_TOKEN")) {
      gh(["secret", "set", "AGENT_MEMORY_TOKEN", "-R", s.repo], issue(d1, "github-backup", "backup"));
      console.log("Backup token (export only) saved as the repo secret AGENT_MEMORY_TOKEN.");
    }
    gh(["variable", "set", "AGENT_MEMORY_URL", "-R", s.repo, "--body", s.memory.url]);
    try {
      gh(["api", `repos/${s.repo}/branches/memory-backup`, "--jq", ".name"]);
    } catch {
      // An orphan branch with only a README: the notes never share history with your config.
      const tmp = mkdtempSync(path.join(os.tmpdir(), "agent-cloud-backup-"));
      try {
        const git = (...a: string[]) => execFileSync("git", ["-C", tmp, ...a], { stdio: "ignore", windowsHide: true });
        git("init", "-q", "-b", "memory-backup");
        writeFileSync(path.join(tmp, "README.md"), "# Memory backup\n\nWritten every night by the backup workflow. Restore with `npx agent-cloud restore`.\n");
        git("add", "README.md");
        git("commit", "-q", "-m", "Start the memory backup");
        // Signs in through the GitHub CLI, whatever credential helper git has.
        git("-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "push", "-q", `https://github.com/${s.repo}.git`, "memory-backup");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    console.log(`Backup ready: every night into the memory-backup branch of ${s.repo} (push this folder so the workflow exists).`);
  } catch (e) {
    console.log(`Backup setup stopped: ${(e as Error).message.split("\n")[0]}`);
  }
}
