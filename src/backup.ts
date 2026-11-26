/**
 * The nightly backup workflow's two steps (run in a checkout of the memory-backup branch):
 *   agent-cloud backup pull     rewrites notes/ and projects.json from the memory server
 *   agent-cloud backup report   tells the server how the run went, so every agent session warns if backups stop
 * Needs AGENT_MEMORY_URL (repo variable) and AGENT_MEMORY_TOKEN (a backup-scoped device token, repo secret).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

type ExportFile = { path: string; content: string };

export async function main(args: string[]): Promise<void> {
  const url = (process.env.AGENT_MEMORY_URL || "").replace(/\/+$/, "");
  const token = process.env.AGENT_MEMORY_TOKEN || "";
  if (!url || !token) throw new Error("AGENT_MEMORY_URL (repo variable) and AGENT_MEMORY_TOKEN (repo secret) are required.");
  if (args[0] === "pull") return pull(url, token);
  if (args[0] === "report") return report(url, token);
  throw new Error("Use: agent-cloud backup pull | backup report");
}

async function pull(url: string, token: string): Promise<void> {
  const get = async <T,>(pathAndQuery: string): Promise<T> => {
    const response = await fetch(`${url}${pathAndQuery}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`GET ${pathAndQuery} failed: ${response.status}`);
    return (await response.json()) as T;
  };
  const files: ExportFile[] = [];
  let after = 0;
  let total: number | null = null;
  for (let page = 0; page < 1000; page++) {
    const result = await get<{ files: ExportFile[]; next: number | null; total: number }>(`/export?after=${after}`);
    total ??= result.total;
    files.push(...result.files);
    if (result.next === null) break;
    after = result.next;
  }
  const notes = files.length;
  if (total !== null && notes !== total) throw new Error(`Expected ${total} notes but received ${notes}; not committing.`);
  files.push(...(await get<{ files: ExportFile[] }>("/export/indexes")).files);

  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) throw new Error(`Two files share the path ${file.path}; not committing.`);
    seen.add(file.path);
  }

  const root = path.resolve("notes");
  // A sudden large drop looks like a wrong server or an emptied database, not real deletions.
  const countNotes = (dir: string): number =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? countNotes(path.join(dir, e.name)) : e.name.endsWith(".md") && e.name !== "MEMORY.md" ? 1 : 0), 0)
      : 0;
  const previous = countNotes(root);
  if (previous >= 20 && notes < previous * 0.5 && process.env.ALLOW_LARGE_DROP !== "1") {
    throw new Error(`Backup would drop from ${previous} to ${notes} notes; refusing. Re-run with ALLOW_LARGE_DROP=1 if that is intended.`);
  }
  const projectsFile = path.resolve("projects.json");
  rmSync(root, { recursive: true, force: true });
  for (const file of files) {
    const target = path.resolve(file.path);
    if (target !== projectsFile && !target.startsWith(root + path.sep)) throw new Error(`Refusing to write outside notes/: ${file.path}`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
  }
  writeFileSync(path.join(process.env.RUNNER_TEMP || ".", "backup-count"), String(notes));
  console.log(`Pulled ${notes} notes and ${files.length - notes} indexes.`);
}

/** Sends only fixed fields; the server writes the warning text itself. */
async function report(url: string, token: string): Promise<void> {
  const ok = process.env.JOB_STATUS === "success";
  let notes = 0;
  try {
    notes = Number(readFileSync(path.join(process.env.RUNNER_TEMP || ".", "backup-count"), "utf8")) || 0;
  } catch {
    // the pull step never got that far
  }
  const response = await fetch(`${url}/export/result`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ok, notes, run_id: process.env.GITHUB_RUN_ID }),
  });
  console.log(`Reported ${ok ? "success" : "failure"} (${notes} notes): HTTP ${response.status}`);
  if (!response.ok) process.exitCode = 1;
}
