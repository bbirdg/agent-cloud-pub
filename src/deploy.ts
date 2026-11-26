/**
 * `agent-cloud deploy [--dry-run]`: (re)deploys your memory server.
 * 1. Bundles config/skills (shaped by config/skills-serve.json) and config/rules/global.md into the private skills
 *    file the server serves over MCP (a skill that is too large, binary or holds something like a key is skipped).
 * 2. Writes the Worker config from agent-cloud.json.
 * 3. Applies database migrations, then deploys. --dry-run only bundles and checks (no Cloudflare account needed).
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyServeRule, globalRulesSkill, selectSkills, skillsJson, type ServeRule, type SkillInput } from "../server/src/skills-select.ts";
import { readSettings, requireProject, type Settings } from "./project.ts";
import { assetsDir, buildDir, wrangler, writeWranglerConfig } from "./wrangler.ts";

export async function main(args: string[]): Promise<void> {
  const value = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const project = requireProject(value("--project"));
  const dryRun = args.includes("--dry-run");
  await deploy(project, readSettings(project, { allowNoUrl: dryRun }), { dryRun });
}

export async function deploy(project: string, settings: Settings, opts: { dryRun?: boolean } = {}): Promise<string> {
  if (!opts.dryRun && (!settings.memory.d1.id || !settings.memory.kv.id)) throw new Error("agent-cloud.json has no database yet: run `npx agent-cloud setup` first.");
  await bundleSkills(project);
  if (opts.dryRun) {
    // Before setup there are no ids yet: placeholders let Wrangler bundle and check everything else.
    const m = settings.memory;
    writeWranglerConfig(project, { ...settings, memory: { ...m, url: m.url || "https://example.invalid", d1: { ...m.d1, id: m.d1.id || "00000000-0000-0000-0000-000000000000" }, kv: { id: m.kv.id || "00000000000000000000000000000000" } } });
    wrangler(project, ["deploy", "--dry-run", "--outdir", path.join(buildDir(project), "dist")], { inherit: true });
    console.log("Dry run: bundled and checked; nothing was deployed.");
    return "";
  }
  writeWranglerConfig(project, settings);
  wrangler(project, ["d1", "migrations", "apply", settings.memory.d1.name, "--remote"], { inherit: true, input: "y\n" });
  const out = wrangler(project, ["deploy"], { input: "" });
  process.stdout.write(out);
  return out;
}

/** Writes the skills file the server serves; returns the served skill names. */
export async function bundleSkills(project: string): Promise<string[]> {
  const config = path.join(project, "config");
  const readJson = <T,>(p: string, fallback: T): T => {
    try {
      return JSON.parse(readFileSync(p, "utf8")) as T;
    } catch {
      return fallback;
    }
  };
  const rules = readJson<{ skills?: Record<string, ServeRule> }>(path.join(config, "skills-serve.json"), {}).skills ?? {};
  const skills: SkillInput[] = [];
  const skillsDir = path.join(config, "skills");
  for (const name of safeList(skillsDir)) {
    if (statSync(path.join(skillsDir, name)).isDirectory()) skills.push(applyServeRule({ name, files: walk(path.join(skillsDir, name)) }, rules[name]));
  }
  for (const name of Object.keys(rules)) {
    if (!skills.some((s) => s.name === name)) console.warn(`deploy: config/skills-serve.json names "${name}", which is not in config/skills (renamed or removed?)`);
  }
  try {
    const globalMd = readFileSync(path.join(config, "rules", "global.md"), "utf8");
    skills.push({ name: "global-rules", builtIn: true, files: [{ path: "SKILL.md", bytes: new TextEncoder().encode(globalRulesSkill(globalMd)) }] });
  } catch {
    // no global rules
  }
  const { files, skipped } = await selectSkills(skills);
  for (const s of skipped) console.warn(`deploy: skill ${s.name} not served: ${s.reason}`);
  mkdirSync(assetsDir(project), { recursive: true });
  writeFileSync(path.join(assetsDir(project), "skills.json"), skillsJson(files));
  const served = ["agent-memory", ...new Set(Object.keys(files).map((k) => k.split("/")[0]!))];
  console.log(`Skills served over MCP: ${served.join(", ")}`);
  return served;
}

const safeList = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** Every file under `dir` (paths with `/`); a link or special file is passed on as binary, so it is skipped. */
function walk(dir: string, prefix = ""): { path: string; bytes: Uint8Array }[] {
  const out: { path: string; bytes: Uint8Array }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push({ path: rel, bytes: new Uint8Array(readFileSync(path.join(dir, entry.name))) });
    else out.push({ path: rel, bytes: new Uint8Array([0]) });
  }
  return out;
}
