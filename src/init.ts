/**
 * `npx @bbirdg/agent-cloud init <folder>`: creates your agent-cloud folder from the template (example rules, a skill, a
 * subagent, MCP servers, the nightly backup workflow), with agent-cloud installed in it, as a new git repo.
 *   options: --worker <name> (default agent-memory), --repo <owner/name> (its private GitHub repo, for the backup),
 *            --no-install (skip `npm install`)
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { npmRun } from "./npm.ts";
import { PACKAGE_NAME, packageRoot, packageVersion, SETTINGS_FILE, type Settings } from "./project.ts";

export async function main(args: string[]): Promise<void> {
  const value = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const target = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (!target) throw new Error(`Use: npx ${PACKAGE_NAME} init <folder>`);
  const dir = path.resolve(target);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} isn't empty; pick a new folder.`);

  cpSync(path.join(packageRoot, "templates", "project"), dir, { recursive: true });
  // npm drops dotfiles like .gitignore from packages, so the template stores them without the dot.
  for (const f of ["gitignore", "gitattributes"]) renameSync(path.join(dir, f), path.join(dir, `.${f}`));

  const worker = value("--worker") ?? "agent-memory";
  const settings: Settings & { $comment: string } = {
    $comment: "Your memory server. `npx agent-cloud setup` fills in the ids and the address. For a custom domain (a domain on your Cloudflare account), set memory.domain, or run `setup --domain <name>`. Set repo (owner/name of this folder's private GitHub repo) for the nightly backup.",
    memory: { url: "", worker, domain: null, d1: { name: worker, id: "" }, kv: { id: "" } },
    ...(value("--repo") ? { repo: value("--repo") } : {}),
  };
  writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(settings, null, 2) + "\n");
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: path.basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "my-agent-cloud",
        private: true,
        type: "module",
        devDependencies: { [PACKAGE_NAME]: `^${packageVersion}` },
        // npm 11 runs install scripts only for approved packages: esbuild and workerd ship Wrangler's binaries.
        allowScripts: { esbuild: true, workerd: true, "core-js-pure": false },
      },
      null,
      2,
    ) + "\n",
  );

  const run = (cmd: string, cmdArgs: string[]) => execFileSync(cmd, cmdArgs, { cwd: dir, stdio: "inherit", windowsHide: true });
  if (args.includes("--no-install")) console.log(`Created ${dir}. Run \`npm install\` in it before anything else.`);
  else {
    console.log(`Created ${dir}. Installing agent-cloud...`);
    npmRun("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit" });
  }
  try {
    run("git", ["init", "-q", "-b", "main"]);
    run("git", ["add", "-A"]);
    run("git", ["commit", "-q", "-m", "Start my agent-cloud"]);
  } catch {
    console.log("(git isn't set up here; commit the folder yourself.)");
  }
  console.log(`\nNext:\n  cd ${target}\n  npx agent-cloud setup     # creates your memory server on your Cloudflare account\n`);
}
