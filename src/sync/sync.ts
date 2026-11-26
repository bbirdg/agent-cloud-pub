/**
 * Writes every agent harness's rules, skills, subagents, hooks and MCP servers from the project's config/.
 *
 *   agent-cloud sync                      # preview: what would change (default, writes nothing)
 *   agent-cloud sync --apply              # apply after you've seen the preview
 *   agent-cloud sync --apply --adopt      # first run: take over existing files (each is backed up)
 *   agent-cloud sync --pull               # preview, then --pull --apply: copy your own skills edited in an agent's
 *                                         #   folder back into config/skills (review with git diff, commit, sync)
 *   agent-cloud sync --cursor-rules       # print the rules text to paste into Cursor > Settings > Rules
 *   options: --only rules,skills,agents,mcp,hooks   --harness codex,cursor   --project <dir>
 *            --home <dir>: a test run into another home (reads only that home's secrets file, never calls an agent CLI)
 *            --mirror-only: only the mirrored installed skills (run after a skills update; applies nothing else)
 * When this PC is unplugged (`agent-cloud off`), the same run removes what it would otherwise write.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pointerMd, SKILL_MD } from "../../server/src/memory-text.ts";
import { findProject, packageVersion, readPcState, readSettings, requireProject, secretValues, writePcState } from "../project.ts";
import { antigravity, claudeCode, claudeDesktop, codex, type Content, cursor, folderDigest, genericAgentsMd, readFolder, rulesFile, type Skill, SKILL_DIRS, writeFolder } from "./adapters.ts";
import { expandHome, hash, Sync, type Entry } from "./core.ts";
import { desktopPids, startDesktopWaiter } from "./desktop.ts";
import { type Catalog, localize, MEMORY_SERVER } from "./mcp.ts";

export async function main(args: string[]): Promise<void> {
  const flag = (n: string) => args.includes(n);
  const value = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const testHome = value("--home");
  const home = path.resolve(testHome ?? os.homedir());
  const project = testHome ? (findProject(value("--project"), home) ?? requireProject(value("--project"))) : requireProject(value("--project"));
  const settings = readSettings(project);
  const only = value("--only")?.split(",");
  const pickHarness = value("--harness")?.split(",");
  const config = path.join(project, "config");
  const pc = readPcState(home);
  const off = pc.off;
  const warnings: string[] = [];

  const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const listDirs = (p: string) => (existsSync(p) ? readdirSync(p).filter((n) => statSync(path.join(p, n)).isDirectory()) : []);
  const listFiles = (p: string) => (existsSync(p) ? readdirSync(p).filter((n) => statSync(path.join(p, n)).isFile()) : []);
  const readJson = <T,>(p: string, fallback: T): T => (existsSync(p) ? (JSON.parse(read(p)) as T) : fallback);

  // ---------- content from config/ ----------
  type Harness = { enabled: boolean; type?: string; rulesFile?: string; skillsDir?: string; mcp?: string[] };
  const harnesses = readJson<{ harnesses: Record<string, Harness> }>(path.join(config, "harnesses.json"), { harnesses: {} }).harnesses;
  type MirrorSource = { dir: string; exclude?: string[]; only?: string[] };
  const mirror = readJson<{ to: string[]; sources: MirrorSource[] } | null>(path.join(config, "skills-mirror.json"), null);

  /** Expands "~" and a trailing "*" segment (the most recently updated matching folder). */
  function resolveDir(spec: string): string | null {
    const full = expandHome(spec, home);
    if (!full.endsWith(`${path.sep}*`) && !full.endsWith("/*")) return existsSync(full) ? full : null;
    const parent = full.slice(0, -2);
    const candidates = listDirs(parent).map((n) => path.join(parent, n));
    return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
  }

  const memoryOn = off !== "memory";
  const ownSkills: Skill[] = [
    ...(memoryOn ? [{ name: "agent-memory", dir: null, files: { "SKILL.md": Buffer.from(SKILL_MD).toString("base64") } }] : []),
    ...listDirs(path.join(config, "skills")).map((name) => ({ name, dir: path.join(config, "skills", name), files: readFolder(path.join(config, "skills", name)) })),
  ];
  let mirrored: Skill[] | null = null;
  const mirroredSkills = (): Skill[] => {
    if (!mirror) return [];
    if (mirrored) return mirrored;
    const seen = new Set(ownSkills.map((s) => s.name));
    mirrored = [];
    for (const source of mirror.sources) {
      const src = resolveDir(source.dir);
      if (!src) continue;
      for (const name of listDirs(src)) {
        const dir = path.join(src, name);
        // Linked skill folders (junctions/symlinks) belong to another install: never mirror them.
        if (lstatSync(dir).isSymbolicLink() || name.startsWith(".") || seen.has(name)) continue;
        if (source.exclude?.includes(name) || (source.only && !source.only.includes(name)) || !existsSync(path.join(dir, "SKILL.md"))) continue;
        seen.add(name);
        mirrored.push({ name, dir, files: readFolder(dir) });
      }
    }
    return mirrored;
  };

  const raw = readJson<Catalog>(path.join(config, "mcp", "catalog.json"), { servers: {} });
  if (!memoryOn) delete raw.servers[MEMORY_SERVER];
  const secrets = secretValues(home, Boolean(testHome));
  const catalog = localize(raw, { home, memoryUrl: settings.memory.url, secrets }, existsSync, (m) => warnings.push(`mcp: ${m}`));

  const base: Omit<Content, "skills" | "mirrored"> = {
    home,
    secrets,
    globalRules: read(path.join(config, "rules", "global.md")),
    agentRules: (h) => (existsSync(path.join(config, "rules", "agents", `${h}.md`)) ? read(path.join(config, "rules", "agents", `${h}.md`)) : ""),
    memoryBlock: memoryOn ? pointerMd({ url: settings.memory.url }) : "",
    extraRules: listFiles(path.join(config, "rules")).filter((n) => n !== "global.md" && n.endsWith(".md")).map((name) => ({ name, text: read(path.join(config, "rules", name)) })),
    agents: (h) => listFiles(path.join(config, "agents", h)).map((file) => ({ file, text: read(path.join(config, "agents", h, file)) })),
    catalog,
    hookCommand: hookCommand(project),
    // A test run never calls the real `claude` CLI: it writes that home's .claude.json directly.
    claudeMcp: testHome ? "file" : "cli",
  };
  const contentFor = (h: string): Content => {
    if (!mirror?.to.includes(h)) return { ...base, skills: ownSkills, mirrored: [] };
    // Codex reads ~/.agents/skills itself, so only skills not already there go to its own folder.
    if (h === "codex") {
      const agentsDir = path.join(home, SKILL_DIRS.codex!);
      return { ...base, skills: ownSkills, mirrored: mirroredSkills().filter((s) => !existsSync(path.join(agentsDir, s.name))) };
    }
    return { ...base, skills: [...ownSkills, ...mirroredSkills()], mirrored: [] };
  };

  /**
   * --pull: your own skills (config/skills) edited by hand in an agent's skill folder since the last sync are copied
   * back into config/skills. Two agents edited differently: reported, nothing copied.
   */
  function pullOwnSkills(sync: Sync, apply: boolean): void {
    for (const skill of ownSkills) {
      if (!skill.dir) continue; // agent-memory is generated, never edited by hand
      const desired = folderDigest(skill.files);
      const edits = new Map<string, { from: string; dir: string }>();
      for (const [h, rel] of Object.entries(SKILL_DIRS)) {
        if (!harnesses[h]?.enabled) continue;
        const dir = path.join(home, rel, skill.name);
        if (!existsSync(dir) || lstatSync(dir).isSymbolicLink()) continue;
        const digest = folderDigest(readFolder(dir));
        const recorded = sync.managedHash(`${h}:skill:${skill.name}`);
        if (digest === desired || !recorded || hash(digest) === recorded) continue;
        if (!edits.has(digest)) edits.set(digest, { from: h, dir });
      }
      if (edits.size === 0) continue;
      // Never overwrite edits in config/skills that aren't committed yet: they'd be lost and git diff wouldn't show them.
      const uncommitted = git(project, "status", "--porcelain", "--", path.relative(project, skill.dir));
      if (uncommitted) {
        console.log(`conflict  ${skill.name}: config/skills/${skill.name} has uncommitted changes; commit or discard them, then pull again`);
        process.exitCode = 2;
        continue;
      }
      if (edits.size > 1) {
        console.log(`conflict  ${skill.name}: edited differently in ${[...edits.values()].map((e) => e.from).join(" and ")}; copy the right one into config/skills/${skill.name} by hand`);
        process.exitCode = 2;
        continue;
      }
      const { from, dir } = [...edits.values()][0]!;
      console.log(`pull      ${skill.name} from ${from} (${dir})`);
      if (apply) writeFolder(skill.dir, readFolder(dir));
    }
  }

  // Cursor keeps User Rules in its settings, not a file: print the text to paste there.
  if (flag("--cursor-rules")) {
    process.stdout.write(rulesFile(contentFor("cursor"), "cursor", "Global instructions (Cursor)"));
    return;
  }

  // ---------- run ----------
  const apply = flag("--apply");
  const sync = new Sync(home, { apply, adopt: flag("--adopt") });
  const kindOf = (id: string) => {
    const k = id.split(":")[1]!;
    return k === "rule" ? "rules" : k === "skill" || k === "mirror-skill" ? "skills" : k === "agent" || k === "plugin" ? "agents" : k === "hook" || k === "setting" ? "hooks" : k;
  };
  // --mirror-only: mirrored installed skills only. Own skills share Antigravity's folder, so they are picked by name.
  const mirrorOnly = flag("--mirror-only");
  const ownNames = new Set(ownSkills.map((s) => s.name));
  const inScope = (id: string) => {
    if (mirrorOnly) {
      const [, k, name] = id.split(":");
      return k === "mirror-skill" || (k === "skill" && id.startsWith("antigravity:") && !ownNames.has(name!));
    }
    return !only || only.includes(kindOf(id));
  };

  if (flag("--pull")) {
    sync.lock();
    try {
      pullOwnSkills(sync, apply);
    } finally {
      sync.unlock();
    }
    console.log(apply ? "\nPulled. Review with git diff, commit, then: agent-cloud sync --apply" : "\nPreview (nothing copied; add --apply)");
    return;
  }

  let failed = false;
  /** One entry; a failure becomes a warning (its message only, never a command line) and the run goes on. */
  const handle = (s: Sync, e: Entry) => {
    try {
      s.handle(e);
    } catch (error) {
      failed = true;
      warnings.push(`${e.id}: not written (${firstLine(error)})`);
    }
  };
  sync.lock();
  try {
    for (const [name, h] of Object.entries(harnesses)) {
      if (!h.enabled || (pickHarness && !pickHarness.includes(name))) continue;
      const c = contentFor(name);
      let entries: Entry[];
      // One agent's problem (a server it can't take) never stops the others.
      try {
        if (name === "claude-code") entries = claudeCode(sync, c);
        else if (name === "codex") entries = codex(sync, c);
        else if (name === "antigravity") entries = antigravity(sync, c);
        else if (name === "cursor") entries = cursor(sync, c);
        else if (name === "claude-desktop") entries = claudeDesktop(sync, c, h.mcp ?? [], (m) => warnings.push(m));
        else if (h.type === "generic-agents-md" && h.rulesFile) entries = genericAgentsMd(sync, c, name, { rulesFile: h.rulesFile, skillsDir: h.skillsDir });
        else {
          warnings.push(`${name}: no adapter`);
          continue;
        }
      } catch (e) {
        warnings.push(`${name}: skipped (${firstLine(e)})`);
        continue;
      }
      entries = entries.filter((e) => inScope(e.id));
      // Unplugged: everything this tool wrote is removed (hand-edited entries are reported and kept).
      if (off === "all") entries = entries.map((e) => ({ ...e, desired: null }));
      // The desktop app rewrites its config from memory while it runs: never write it then, wait for it to close.
      if (name === "claude-desktop" && apply && !testHome && desktopPids().length) {
        const preview = new Sync(home, { apply: false, adopt: flag("--adopt") });
        for (const e of entries) handle(preview, e);
        const waiting = preview.changes.filter((ch) => ch.status !== "unchanged" && ch.status !== "conflict" && ch.status !== "unmanaged");
        for (const ch of preview.changes) sync.changes.push(waiting.includes(ch) ? { ...ch, status: "skip", detail: `${ch.status} when the Claude app closes` } : ch);
        if (waiting.length) {
          if (flag("--from-waiter")) process.exitCode = 3; // reopened meanwhile: the waiter waits again
          else if (process.platform !== "win32") warnings.push("claude-desktop: quit the Claude app, then run: agent-cloud sync --apply --harness claude-desktop");
          else if (startDesktopWaiter(project, home, flag("--adopt"))) warnings.push("claude-desktop: the Claude app is open; its servers are written as soon as you quit it (tray icon > Quit). Log: ~/.agent-cloud/desktop-sync.log");
          else warnings.push("claude-desktop: already waiting for the Claude app to close");
        }
        continue;
      }
      for (const e of entries) handle(sync, e);
    }
    // A run where something failed isn't recorded as applied, so the session hook keeps saying changes wait.
    if (apply && !mirrorOnly && !only && !pickHarness && !failed) {
      writePcState({ ...pc, project, appliedCommit: git(project, "rev-parse", "HEAD") || undefined, appliedVersion: packageVersion, at: new Date().toISOString() }, home);
    }
  } finally {
    sync.save(); // what was written is always recorded, even if a later entry failed
    sync.unlock();
  }

  // ---------- report ----------
  const counts: Record<string, number> = {};
  for (const ch of sync.changes) counts[ch.status] = (counts[ch.status] ?? 0) + 1;
  for (const ch of sync.changes.filter((x) => x.status !== "unchanged")) console.log(`${ch.status.padEnd(9)} ${ch.id}${ch.detail ? `  (${ch.detail})` : ""}`);
  for (const w of warnings) console.log(`warning   ${w}`);
  if (off) console.log(`\nagent-cloud is off on this PC (${off === "all" ? "everything" : "memory"}); \`agent-cloud on\` turns it back on.`);
  console.log(`\n${apply ? "Applied" : "Preview (nothing written; add --apply)"}: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "nothing to do"}`);
  if (sync.changes.some((c) => c.status === "conflict") || failed) process.exitCode = 2;
}

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.replace(/^Command failed: .*/, "a command failed");

/** The session hook command: this installed package's CLI, run by `node` from the agent's own PATH. */
export function hookCommand(project: string): string {
  const cli = path.join(project, "node_modules", "agent-cloud", "dist", "src", "cli.js");
  return `node "${cli}" hook`;
}

function git(dir: string, ...args: string[]): string {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}
