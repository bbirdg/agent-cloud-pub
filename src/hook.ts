/**
 * Claude Code SessionStart hook (`agent-cloud hook`):
 * 1. loads the shared memory index for the session's folder into context,
 * 2. says in one line when project config changes or a new agent-cloud version wait to be applied, and
 * 3. once a day starts the installed-skills update in the background and says which updates wait for review.
 * Never blocks a session: problems become one line, 3 s max for the memory call.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { cliCommand, findProject, packageVersion, pcDir, readPcState, readSecretsFile, readSettings } from "./project.ts";

export async function main(): Promise<void> {
  const notes: string[] = [];
  const emit = (text: string) => {
    const all = [text, ...notes].filter(Boolean).join("\n\n");
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: all } }));
  };

  const pc = readPcState();
  const project = findProject(pc.project);
  if (!project) return emit("agent-cloud: no project found on this PC (`npx agent-cloud status` explains).");

  // ---------- waiting changes (reported, never applied) ----------
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", project, ...args], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
    const upstream = git("rev-parse", "@{u}");
    if (pc.appliedCommit && upstream && upstream !== pc.appliedCommit) {
      // Only commits that change what the sync writes count.
      const count = Number(git("rev-list", "--count", `${pc.appliedCommit}..${upstream}`, "--", "config", "agent-cloud.json"));
      if (count > 0) notes.push(`agent-cloud: ${count} config change(s) are waiting. Tell the user; they review and apply them with \`npx agent-cloud sync\` in ${project}. Don't apply them yourself unless asked.`);
    }
    // Refresh the upstream for the next session, in the background.
    spawn("git", ["-C", project, "fetch", "--quiet"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    // not a git repo, no upstream, or offline: say nothing
  }
  if (pc.appliedVersion && pc.appliedVersion !== packageVersion) {
    notes.push(`agent-cloud was updated (${pc.appliedVersion} -> ${packageVersion}). Tell the user; they preview what changes with \`npx agent-cloud sync\` in ${project}.`);
  }
  skillUpdates(project, notes);

  // ---------- shared memory ----------
  if (pc.off === "memory") return emit("agent-cloud: shared memory is off on this PC (`npx agent-cloud on` turns it back on). Don't use any memory tools.");
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  let cwd = process.cwd();
  try {
    cwd = (JSON.parse(input) as { cwd?: string }).cwd || cwd;
  } catch {
    // no or invalid input: use the process folder
  }

  let url = "";
  try {
    url = readSettings(project).memory.url;
  } catch {
    // reported below
  }
  // The token: the environment first (an agent started with it), then this PC's secrets file.
  const token = process.env.AGENT_MEMORY_TOKEN || readSecretsFile().AGENT_MEMORY_TOKEN || "";
  if (!url || !token) return emit("agent-memory: not set up on this PC (no memory address or device token). `npx agent-cloud status` in the agent-cloud folder says what's missing.");

  let remote = "";
  try {
    remote = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
    remote = remote.replace(/^([a-z+]+:\/\/)[^@/]+@/i, "$1"); // never send embedded credentials
  } catch {
    // not a git repo, or no origin
  }

  const query = new URLSearchParams({ cwd });
  if (remote) query.set("remote", remote);
  try {
    const response = await fetch(`${url}/context?${query}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
    if (!response.ok) return emit(`agent-memory: could not load memory (HTTP ${response.status}). Call memory_context once it is reachable.`);
    emit(await response.text());
  } catch (error) {
    emit(`agent-memory: could not load memory (${(error as Error).name === "TimeoutError" ? "timed out" : "offline?"}). Call memory_context when online.`);
  }
}

/** Installed skills: "auto" vendors update on their own once a day; the rest are reported. */
function skillUpdates(project: string, notes: string[]): void {
  const dir = pcDir();
  type SkillsState = { checkedAt?: string; waiting?: { name: string }[]; edited?: string[]; tools?: { name: string; detail: string; update: string }[]; errors?: string[] };
  let state: SkillsState = {};
  try {
    state = JSON.parse(readFileSync(path.join(dir, "skills-state.json"), "utf8")) as SkillsState;
  } catch {
    // never run yet
  }
  const where = `in ${project}`;
  if (state.waiting?.length) notes.push(`agent-cloud: ${state.waiting.length} installed skill update(s) wait for review (${state.waiting.map((w) => w.name).join(", ")}). Tell the user; they preview with \`npx agent-cloud skills update\` and apply with \`--yes\` ${where}.`);
  if (state.edited?.length) notes.push(`agent-cloud: installed skill(s) edited by hand, so never updated: ${state.edited.join(", ")}. Mention it once; the user can keep the edit or delete the folder and run \`npx agent-cloud skills update --yes --install\` ${where}.`);
  if (state.tools?.length) notes.push(`agent-cloud: newer versions of local tools: ${state.tools.map((t) => `${t.name} ${t.detail} (${t.update})`).join("; ")}. Mention it once; update only if the user says so.`);
  if (state.errors?.length) notes.push(`agent-cloud: the last skills update had ${state.errors.length} error(s); \`npx agent-cloud skills\` ${where} shows them.`);
  const lock = path.join(dir, "skills.lock");
  const due = !state.checkedAt || Date.now() - Date.parse(state.checkedAt) > 20 * 3600_000;
  // A lock older than 15 minutes is left by a run that died (sleep, logoff): the update replaces it.
  const running = existsSync(lock) && Date.now() - statSync(lock).mtimeMs < 15 * 60_000;
  if (due && !running) {
    const [node, cli] = cliCommand;
    spawn(node, [cli!, "skills", "update", "--auto", "--quiet", "--project", project], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }
}
