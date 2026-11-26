/**
 * Keeps installed skills (config/skills-vendor.json) current from their public sources, in ~/.claude/skills.
 *
 *   agent-cloud skills                       # check: what has an update (changes nothing)
 *   agent-cloud skills update                # preview what would change
 *   agent-cloud skills update --yes          # update every source (each replaced skill is backed up first)
 *   agent-cloud skills update --auto         # check everything, update only "auto" sources (the session hook runs this)
 *   agent-cloud skills update --yes <name...>    # only these skills (also installs a missing one)
 *   agent-cloud skills update --yes --install    # also install every listed skill that's missing (a new PC)
 *   agent-cloud skills update --cli          # also run `npx skills update -g -y` for skills CLI installs
 *   options: --home <dir> (test runs), --project <dir>, --quiet, --no-mirror
 *
 * Safety: a skill whose files changed since this tool last wrote it (edited by hand) is never overwritten; an
 * "auto" update needs a known baseline (one reviewed update first); new skills are only installed when named.
 * After an update the sync copies the changed skills to Antigravity and Codex (--mirror-only, never anything else).
 * State: ~/.agent-cloud/skills-state.json (the session hook reads it to say what waits for review).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { npmRun as runNpm } from "../npm.ts";
import { cliCommand, readPcState, requireProject } from "../project.ts";

/** A name, or { name, path? (upstream folder), renamedFrom? (old local names, retired when this one is installed) }. */
type SkillRef = string | { name: string; path?: string; renamedFrom?: string[] };
type Source = { repo: string; ref: string; auto: boolean; prefix?: string; skills: SkillRef[] };
type Tool = { name: string; npm?: string; git?: string; update: string };
type Vendor = { sources: Source[]; skillsCli?: { skills: string[] }; external?: { name: string }[]; ignore?: string[]; tools?: { list: Tool[] } };
type Record_ = { repo: string; sha: string; hash: string };
type State = {
  checkedAt?: string;
  skills: Record<string, Record_>;
  waiting: { name: string; repo: string; state: string }[];
  edited: string[];
  errors: string[];
  untracked: string[];
  mirrorPending?: boolean;
  /** Local tools (config/skills-vendor.json "tools") with a newer version: reported only. */
  tools?: { name: string; detail: string; update: string }[];
};

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const value = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const home = path.resolve(value("--home") ?? os.homedir());
const project = requireProject(value("--project"), home);
const command = args[0] === "update" ? "update" : "check";
const names = args.slice(1).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--home" && all[i - 1] !== "--project");
const auto = flag("--auto");
const yes = flag("--yes");
const quiet = flag("--quiet");
const log = (s: string) => quiet || console.log(s);

const installDir = path.join(home, ".claude", "skills");
const stateDir = path.join(home, ".agent-cloud");
const statePath = path.join(stateDir, "skills-state.json");
const lockPath = path.join(stateDir, "skills.lock");
const vendorFile = path.join(project, "config", "skills-vendor.json");
const vendor: Vendor = existsSync(vendorFile) ? (JSON.parse(readFileSync(vendorFile, "utf8")) as Vendor) : { sources: [] };
// Unplugged (`agent-cloud off all`): nothing is installed or updated until `agent-cloud on`.
if (readPcState(home).off === "all") {
  log("agent-cloud is off on this PC; skills aren't checked or updated (`agent-cloud on` turns it back on).");
  process.exit(0);
}

// ---------- helpers ----------
function treeHash(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const n of readdirSync(d).sort()) {
      const full = path.join(d, n);
      const r = rel ? `${rel}/${n}` : n;
      if (statSync(full).isDirectory()) walk(full, r);
      else files.push(`${r}\n${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  };
  walk(dir, "");
  return createHash("sha256").update(files.join("\n")).digest("hex");
}

const skillName = (s: SkillRef) => (typeof s === "string" ? s : s.name);
const skillPath = (src: Source, s: SkillRef) => (typeof s !== "string" && s.path !== undefined ? s.path : `${src.prefix ?? "skills/"}${skillName(s)}`);
const renamedFrom = (s: SkillRef) => (typeof s === "string" ? [] : (s.renamedFrom ?? []));

// Background runs have no console: never let a child open a window.
const quietRun = { windowsHide: true, timeout: 120_000 } as const;
// Windows' own bsdtar refuses links in an archive (an error, never a copy of a local file); GNU tar from Git Bash
// would turn an absolute link into a copy of that file.
const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

function latestSha(repo: string, ref: string): string {
  const out = execFileSync("git", ["ls-remote", `https://github.com/${repo}.git`, ref], { ...quietRun, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] });
  const sha = out.split(/\s+/)[0];
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`no commit found for ${repo}@${ref}`);
  return sha;
}

const temp = mkdtempSync(path.join(os.tmpdir(), "agent-cloud-skills-"));
const archives = new Map<string, string>();
/**
 * Downloads repo@sha once and unpacks only the given skill folders (some repos hold symlinks Windows tar can't
 * create). Returns the archive's root folder.
 */
async function archive(repo: string, sha: string, paths: string[]): Promise<string> {
  const key = `${repo}@${sha}`;
  if (archives.has(key)) return archives.get(key)!;
  const dir = mkdtempSync(path.join(temp, "src-"));
  const res = await fetch(`https://codeload.github.com/${repo}/tar.gz/${sha}`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`download of ${repo} failed (HTTP ${res.status})`);
  writeFileSync(path.join(dir, "src.tgz"), Buffer.from(await res.arrayBuffer()));
  // codeload names the root folder <repo>-<sha>. Relative archive name: Windows tar reads "C:" as a remote host.
  const root = `${repo.split("/")[1]}-${sha}`;
  // Unpack only the folders that exist upstream (a missing one is reported as "not found" by the caller). Any other
  // tar failure (a link, a timeout) fails the whole source, so a half-unpacked skill is never installed.
  const listing = new Set(
    execFileSync(tar, ["-tzf", "src.tgz"], { ...quietRun, cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
      .split(/\r?\n/)
      .map((l) => l.replace(/\/$/, "")),
  );
  const members = paths.map((p) => (p ? `${root}/${p.replace(/\/$/, "")}` : root)).filter((m) => listing.has(m));
  if (members.length) {
    try {
      execFileSync(tar, ["-xzf", "src.tgz", ...members], { ...quietRun, cwd: dir, stdio: "ignore" });
    } catch {
      throw new Error(`unpacking ${repo} failed (links or unreadable files in the skill folders?); nothing from it was installed`);
    }
  }
  archives.set(key, path.join(dir, root));
  return archives.get(key)!;
}

let backupDir: string | null = null;
/** Moves an installed skill folder into this run's backup folder; returns where it went. */
function retire(name: string): string | null {
  const target = path.join(installDir, name);
  if (!existsSync(target)) return null;
  if (lstatSync(target).isSymbolicLink()) throw new Error(`${name} is a linked folder; not replaced`);
  backupDir ??= path.join(stateDir, "backups", "skills", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, name);
  renameSync(target, backup);
  return backup;
}

const npmRun = (tool: "npm" | "npx", a: string[], opts: Parameters<typeof execFileSync>[2] = {}) => runNpm(tool, a, { ...quietRun, ...opts });

/** Which local tools have a newer version (npm global packages, git checkouts). Never updates them. */
function outdatedTools(): NonNullable<State["tools"]> {
  const out: NonNullable<State["tools"]> = [];
  for (const t of vendor.tools?.list ?? []) {
    try {
      if (t.npm) {
        let json = "";
        try {
          json = String(npmRun("npm", ["outdated", "-g", "--json", t.npm], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
        } catch (e) {
          json = String((e as { stdout?: string }).stdout ?? ""); // npm exits 1 when something is outdated
        }
        const info = (JSON.parse(json || "{}") as Record<string, { current?: string; latest?: string }>)[t.npm];
        if (info?.current && info.latest && info.current !== info.latest) out.push({ name: t.name, detail: `${info.current} -> ${info.latest}`, update: t.update });
      } else if (t.git) {
        const dir = t.git.replace(/^~/, home);
        if (!existsSync(dir)) continue;
        execFileSync("git", ["-C", dir, "fetch", "--quiet"], { ...quietRun, stdio: "ignore" });
        const behind = Number(execFileSync("git", ["-C", dir, "rev-list", "--count", "HEAD..@{u}"], { ...quietRun, encoding: "utf8" }).trim());
        if (behind > 0) out.push({ name: t.name, detail: `${behind} commit(s) behind`, update: t.update });
      }
    } catch (e) {
      state.errors.push(`${t.name}: version check failed (${(e as Error).message.split("\n")[0]})`);
    }
  }
  return out;
}

/** Puts the new version in place; on any failure the old folder comes back, so a skill is never left missing. */
function replace(name: string, from: string): string | null {
  const stage = path.join(temp, `stage-${name}`);
  cpSync(from, stage, { recursive: true });
  const target = path.join(installDir, name);
  const backup = retire(name);
  try {
    try {
      renameSync(stage, target);
    } catch {
      cpSync(stage, target, { recursive: true }); // temp may sit on another drive
    }
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    if (backup) renameSync(backup, target);
    throw error;
  }
  return backup;
}

// ---------- run ----------
// A lock older than this belongs to a run that died (sleep, logoff); the session hook uses the same limit.
const STALE_LOCK_MS = 15 * 60_000;
mkdirSync(stateDir, { recursive: true });
try {
  if (Date.now() - statSync(lockPath).mtimeMs >= STALE_LOCK_MS) rmSync(lockPath, { force: true });
} catch {
  // no lock
}
try {
  writeFileSync(lockPath, String(process.pid), { flag: "wx" });
} catch {
  log(`Another skills update is running (${lockPath}).`);
  process.exit(0);
}
// Never hang a background run: give up after 10 minutes.
setTimeout(() => {
  console.error("skills update: timed out after 10 minutes");
  // Record what was replaced so far, or those skills would later look edited by hand.
  state.errors.push("timed out after 10 minutes");
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  cleanup();
  process.exit(3);
}, 10 * 60_000).unref();
function cleanup() {
  rmSync(temp, { recursive: true, force: true });
  try {
    if (readFileSync(lockPath, "utf8") === String(process.pid)) rmSync(lockPath, { force: true });
  } catch {
    // already gone
  }
}

const previous: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { skills: {} };
const state: State = {
  checkedAt: new Date().toISOString(),
  skills: { ...previous.skills },
  waiting: [],
  edited: [],
  errors: [],
  untracked: [],
  // Changed skills not yet copied to the other agents (a failed mirror is retried on the next run).
  mirrorPending: previous.mirrorPending ?? false,
};
const changed: string[] = [];

try {
  for (const src of vendor.sources) {
    const wanted = src.skills.filter((s) => names.length === 0 || names.includes(skillName(s)));
    if (wanted.length === 0) continue;
    let sha: string;
    try {
      sha = latestSha(src.repo, src.ref);
    } catch (e) {
      state.errors.push(`${src.repo}: ${(e as Error).message}`);
      continue;
    }
    for (const s of wanted) {
      const name = skillName(s);
      try {
        if ((await updateOne(src, sha, s, wanted)) === "source-failed") break;
      } catch (e) {
        // One skill failing (a file open in an editor, a linked folder) never stops the rest.
        state.errors.push(`${name}: ${(e as Error).message}`);
      }
    }
  }

  if (command === "update" && flag("--cli") && vendor.skillsCli?.skills.length) {
    log(`Updating skills CLI installs (${vendor.skillsCli.skills.join(", ")})...`);
    try {
      npmRun("npx", ["--yes", "skills", "update", "-g", "-y"], { stdio: quiet ? "ignore" : "inherit", timeout: 300_000 });
    } catch (e) {
      state.errors.push(`skills CLI update: ${(e as Error).message}`);
    }
  }

  // Installed folders nothing here or in config/skills knows about.
  const known = new Set([
    ...vendor.sources.flatMap((s) => s.skills.flatMap((x) => [skillName(x), ...renamedFrom(x)])),
    ...(vendor.skillsCli?.skills ?? []),
    ...(vendor.external ?? []).map((e) => e.name),
    ...(vendor.ignore ?? []),
    "agent-memory",
    ...(existsSync(path.join(project, "config", "skills")) ? readdirSync(path.join(project, "config", "skills")) : []),
  ]);
  if (existsSync(installDir)) {
    state.untracked = readdirSync(installDir).filter((n) => !n.startsWith(".") && !known.has(n) && statSync(path.join(installDir, n)).isDirectory());
  }
  state.tools = names.length ? previous.tools : outdatedTools();
  if (names.length) {
    // A partial run keeps what the last full check found for the other skills.
    state.waiting.push(...(previous.waiting ?? []).filter((w) => !names.includes(w.name)));
    state.edited.push(...(previous.edited ?? []).filter((n) => !names.includes(n)));
  }

  if (changed.length) state.mirrorPending = true;
  if (state.mirrorPending && !flag("--no-mirror")) {
    try {
      const [node, cli] = cliCommand;
      execFileSync(node, [cli!, "sync", "--apply", "--mirror-only", "--project", project, ...(value("--home") ? ["--home", home] : [])], {
        ...quietRun,
        stdio: quiet ? "ignore" : "inherit",
        timeout: 300_000,
      });
      state.mirrorPending = false;
    } catch (e) {
      state.errors.push(`copying to the other agents failed (retried next run): ${(e as Error).message.split("\n")[0]}`);
    }
  }
} catch (e) {
  state.errors.push((e as Error).message);
} finally {
  // Always recorded, so skills replaced before an error keep their new baseline.
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  cleanup();
}

/** Checks one skill and updates it when allowed. "source-failed": the source couldn't be fetched; skip the rest of it. */
async function updateOne(src: Source, sha: string, s: SkillRef, wanted: SkillRef[]): Promise<"source-failed" | void> {
  const name = skillName(s);
  const local = path.join(installDir, name);
  const localHash = treeHash(local);
  const rec = previous.skills[name];
  // Same commit and untouched since we wrote it: nothing to download.
  if (rec && rec.sha === sha && rec.hash === localHash) return;
  let upstream: string;
  try {
    upstream = path.join(await archive(src.repo, sha, wanted.map((w) => skillPath(src, w))), skillPath(src, s));
  } catch (e) {
    state.errors.push(`${src.repo}: ${(e as Error).message}`);
    return "source-failed";
  }
  const upstreamHash = treeHash(upstream);
  if (!upstreamHash) {
    state.errors.push(`${name}: not found in ${src.repo} (${skillPath(src, s)})`);
    return;
  }
  if (upstreamHash === localHash) {
    state.skills[name] = { repo: src.repo, sha, hash: upstreamHash };
    return;
  }
  if (localHash && rec && rec.hash !== localHash) {
    state.edited.push(name); // edited by hand since we wrote it: never overwritten
    return;
  }
  // A renamed skill replaces its old folders: an update, not a new install.
  const oldNames = renamedFrom(s).filter((n) => existsSync(path.join(installDir, n)));
  const kind = localHash || oldNames.length ? "update" : "missing";
  const mayApply =
    command === "update" &&
    (yes ? kind === "update" || names.includes(name) || flag("--install") : auto && src.auto && kind === "update" && Boolean(rec));
  if (!mayApply) {
    state.waiting.push({ name, repo: src.repo, state: oldNames.length && !localHash ? `renamed from ${oldNames.join(", ")}` : kind });
    return;
  }
  const backup = replace(name, upstream);
  for (const n of oldNames) {
    const retired = retire(n);
    delete state.skills[n];
    changed.push(n);
    log(`retired ${n} (renamed to ${name}); backup: ${retired}`);
  }
  state.skills[name] = { repo: src.repo, sha, hash: upstreamHash };
  changed.push(name);
  log(`${localHash ? "updated" : "installed"} ${name} (${src.repo})${backup ? `; backup: ${backup}` : ""}`);
}

// ---------- report ----------
const byRepo = (list: { name: string; repo: string; state: string }[]) =>
  list.map((w) => `${w.name}${w.state === "update" ? "" : ` (${w.state === "missing" ? "not installed" : w.state})`}`).join(", ");
log(`\n${command === "update" ? (yes || auto ? "Updated" : "Preview") : "Check"}: ${changed.length} changed, ${state.waiting.length} waiting, ${state.edited.length} edited by hand, ${state.errors.length} error(s)`);
if (state.waiting.length) log(`  waiting: ${byRepo(state.waiting)}${command === "update" && !yes ? "  (apply: agent-cloud skills update --yes)" : ""}`);
if (state.edited.length) log(`  edited by hand (left alone): ${state.edited.join(", ")}`);
for (const t of state.tools ?? []) log(`  tool update: ${t.name} ${t.detail}  (${t.update})`);
for (const e of state.errors) log(`  error: ${e}`);
if (state.untracked.length) log(`  installed but not in config/skills-vendor.json (never updated): ${state.untracked.join(", ")}`);
