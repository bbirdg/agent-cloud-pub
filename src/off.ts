/**
 * Unplug this PC (`agent-cloud off [memory|all]`) and plug it back in (`agent-cloud on`).
 * - memory: every agent keeps your rules, skills and MCP servers, but not the shared memory (its server, its rules
 *   section, its skill and the session hook's memory loading).
 * - all: everything agent-cloud wrote on this PC is removed (backed up first), including Claude Code's setting that
 *   turns its built-in memory off, so agents run as if agent-cloud were never installed. The installed skills it
 *   keeps current are moved aside, and the daily update stops.
 * Only this PC: the state lives in ~/.agent-cloud/state.json, never in your shared config.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pcDir, readPcState, requireProject, writePcState } from "./project.ts";
import { main as sync } from "./sync/sync.ts";

export async function main(command: "off" | "on", args: string[]): Promise<void> {
  const value = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const testHome = value("--home"); // test runs
  const home = testHome ? path.resolve(testHome) : os.homedir();
  const project = requireProject(value("--project"), home);
  const pc = readPcState(home);

  if (command === "off") {
    const level = (args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? "all") as "memory" | "all";
    if (level !== "memory" && level !== "all") throw new Error("Use: agent-cloud off [memory|all]");
    // Running it again always finishes the job (a run that stopped halfway leaves the state already set).
    if (pc.off === "all" && level === "memory") restoreSkills(home); // narrowing from all to memory
    writePcState({ ...pc, project, off: level }, home);
    if (level === "all") moveSkillsAside(home);
  } else {
    writePcState({ ...pc, project, off: undefined }, home);
    restoreSkills(home);
  }

  // The same sync that writes everything removes it while off (and the Claude app's part waits for it to close).
  await sync(["--apply", "--project", project, ...(testHome ? ["--home", home] : [])]);

  const now = readPcState(home).off;
  if (now === "all") {
    console.log("\nagent-cloud is off on this PC: agents run without your rules, skills, MCP servers and memory. `agent-cloud on` brings it all back.");
  } else if (now === "memory") {
    console.log("\nShared memory is off on this PC. `agent-cloud on` turns it back on.");
  } else {
    console.log("\nagent-cloud is on again on this PC.");
  }
  if (now) {
    console.log(
      "Not covered (they belong to your accounts, not this PC): connectors added on claude.ai, including a memory connector. " +
        "To keep them out of Claude Code too, start it with ENABLE_CLAUDEAI_MCP_SERVERS=false, or for a one-off test run `claude --safe-mode`.",
    );
  }
  console.log("Restart your agents so they reload their settings.");
}

// ---------- installed skills (kept current by `agent-cloud skills`) ----------
const asideDir = (home: string) => path.join(pcDir(home), "off", "skills");

function moveSkillsAside(home: string): void {
  let names: string[] = [];
  try {
    names = Object.keys((JSON.parse(readFileSync(path.join(pcDir(home), "skills-state.json"), "utf8")) as { skills?: Record<string, unknown> }).skills ?? {});
  } catch {
    return; // never installed any
  }
  const installed = path.join(home, ".claude", "skills");
  let moved = 0;
  for (const name of names) {
    const from = path.join(installed, name);
    if (!existsSync(from)) continue;
    const to = path.join(asideDir(home), name);
    mkdirSync(asideDir(home), { recursive: true });
    // An older copy kept aside (a skill reinstalled meanwhile) keeps its own dated name.
    if (existsSync(to)) renameSync(to, `${to}.kept-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    renameSync(from, to);
    moved++;
  }
  if (moved) console.log(`Moved ${moved} installed skill(s) aside to ${asideDir(home)}`);
}

function restoreSkills(home: string): void {
  const dir = asideDir(home);
  if (!existsSync(dir)) return;
  const installed = path.join(home, ".claude", "skills");
  mkdirSync(installed, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (name.includes(".kept-")) continue;
    const to = path.join(installed, name);
    // Something installed meanwhile under the same name wins; the old copy stays aside for the user to decide.
    if (existsSync(to)) {
      console.log(`kept aside: ${name} (a skill with that name is installed again; the old copy is in ${dir})`);
      continue;
    }
    renameSync(path.join(dir, name), to);
  }
  if (readdirSync(dir).length === 0) rmSync(path.join(pcDir(home), "off"), { recursive: true, force: true });
}
