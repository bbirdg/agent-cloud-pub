/**
 * Restores memory from a checkout of the `memory-backup` branch into a D1 database.
 * Keeps every note's status (active / muted / deleted), reason, dates, version and author, and every
 * project's title and folder links; a note restored into the bin gets the restore time as its date, so the bin
 * gives it its full time again. Edit history (note_versions) is not in the backup and starts fresh.
 *
 *   agent-cloud restore --from <backup clone> --local [--persist-to <dir>]   # test into a local database
 *   agent-cloud restore --from <backup clone> --remote --force               # real restore (empty database only)
 *
 * Refuses to write into a database that already has notes.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractLinks, NOTE_TYPES, parseNoteMarkdown } from "../server/src/note-format.ts";
import { readSettings, requireProject } from "./project.ts";
import { binDays, buildDir, wrangler, writeWranglerConfig } from "./wrangler.ts";

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const from = arg("--from");
const target = args.includes("--remote") ? "--remote" : args.includes("--local") ? "--local" : null;
const persistTo = arg("--persist-to");
if (!from || !target) throw new Error("Usage: agent-cloud restore --from <backup clone> --local|--remote [--persist-to <dir>] [--force]");
if (target === "--remote" && !args.includes("--force")) throw new Error("A remote restore needs --force.");
const project = requireProject(arg("--project"));
const settings = readSettings(project);
writeWranglerConfig(project, settings);

function d1(input: { command?: string; file?: string }): unknown[] {
  const where = input.file ? ["--file", input.file] : ["--command", input.command!];
  const extra = persistTo && target === "--local" ? ["--persist-to", path.resolve(persistTo)] : [];
  const out = wrangler(project, ["d1", "execute", settings.memory.d1.name, target!, "--json", "--yes", ...extra, ...where], { input: "" });
  return input.file ? [] : (JSON.parse(out) as unknown[]);
}

const existing = (d1({ command: "SELECT COUNT(*) AS n FROM notes" })[0] as { results: { n: number }[] }).results[0]!.n;
if (existing > 0) throw new Error(`Target database already has ${existing} notes; restore only into an empty database.`);

const q = (v: string | number | null | undefined) =>
  v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`;
const sql: string[] = [];

const projectsPath = path.join(from, "projects.json");
const projects: Record<string, { title: string; aliases: string[] }> = existsSync(projectsPath)
  ? JSON.parse(readFileSync(projectsPath, "utf8"))
  : {};
const notesDir = path.join(from, "notes");
for (const key of readdirSync(notesDir)) if (!projects[key]) projects[key] = { title: key, aliases: [] };
for (const [key, p] of Object.entries(projects)) {
  sql.push(
    `INSERT INTO projects (key, title, aliases) VALUES (${q(key)}, ${q(p.title)}, ${q(JSON.stringify(p.aliases ?? []))})
     ON CONFLICT(key) DO UPDATE SET title = excluded.title, aliases = excluded.aliases;`,
  );
}

let count = 0;
let binned = 0;
const problems: string[] = [];
// Notes restored into the bin get a fresh bin clock: the bin empties itself, and a restore must leave the user
// time to bring them back rather than erase them at the next daily run.
const restoredAt = new Date().toISOString();
for (const project of readdirSync(notesDir)) {
  for (const file of readdirSync(path.join(notesDir, project)).filter((f) => f.endsWith(".md") && f !== "MEMORY.md")) {
    try {
      const n = parseNoteMarkdown(readFileSync(path.join(notesDir, project, file), "utf8"), true);
      if (!NOTE_TYPES.includes(n.type as never)) throw new Error(`bad type '${n.type}'`);
      const status = n.status === "muted" || n.status === "deleted" ? n.status : "active";
      sql.push(
        `INSERT INTO notes (project, id, name, description, type, body, links, status, status_reason, version, created_at, updated_at, updated_by)
         VALUES (${[project, file.slice(0, -3), n.name, n.description, n.type, n.body, JSON.stringify(extractLinks(n.body)), status, n.statusReason ?? null]
           .map(q)
           .join(", ")}, ${q(n.version ?? 1)}, ${q(n.createdAt ?? n.updatedAt ?? new Date().toISOString())}, ${q(status === "deleted" ? restoredAt : (n.updatedAt ?? restoredAt))}, ${q(n.updatedBy ?? "restore")});`,
      );
      count++;
      if (status === "deleted") binned++;
    } catch (error) {
      problems.push(`${project}/${file}: ${(error as Error).message}`);
    }
  }
}
if (problems.length) {
  for (const p of problems) console.log(`  PROBLEM ${p}`);
  throw new Error("Nothing restored.");
}
sql.push(`INSERT INTO audit (actor, action, detail) VALUES ('restore', 'restore', ${q(`${count} notes restored from backup`)});`);

const sqlFile = path.join(buildDir(project), `restore-${Date.now()}.sql`);
writeFileSync(sqlFile, sql.join("\n"), "utf8");
try {
  d1({ file: sqlFile });
} finally {
  rmSync(sqlFile, { force: true });
}
console.log(`Restored ${count} notes in ${Object.keys(projects).length} projects.`);
if (binned) {
  const days = binDays(settings);
  console.log(
    days > 0
      ? `${binned} of them are in the bin, which empties itself after ${days} days: restore any you want back before then.`
      : `${binned} of them are in the bin.`,
  );
}
