import type { Actor } from "./env";
import { type Note, noteToMarkdown, setMeta } from "./memory";

/**
 * Backup export, pulled nightly by a GitHub Action in the private backup repo (it commits with the
 * repo's own built-in token, so no GitHub credential lives on this server). Files use Claude Code's
 * memory layout: notes/<project>/<id>.md and notes/<project>/MEMORY.md.
 */

const PAGE = 100;

export interface ExportFile {
  path: string;
  content: string;
}

/** One page of notes in every status (the frontmatter records it), ordered by stable row id. */
export async function exportPage(
  db: D1Database,
  after: number,
  limit = PAGE,
): Promise<{ files: ExportFile[]; next: number | null; total: number }> {
  const size = Math.min(Math.max(limit, 1), PAGE);
  const [page, count] = await db.batch([
    db.prepare("SELECT * FROM notes WHERE nid > ? ORDER BY nid LIMIT ?").bind(after, size),
    db.prepare("SELECT COUNT(*) AS total FROM notes"),
  ]);
  const results = (page!.results ?? []) as Note[];
  return {
    files: results.map((n) => ({ path: `notes/${n.project}/${n.id}.md`, content: noteToMarkdown(n) })),
    next: results.length === size ? results.at(-1)!.nid : null,
    total: Number((count!.results?.[0] as { total?: number } | undefined)?.total ?? 0),
  };
}

/** projects.json: every project's title and folder/remote links, so a restore keeps them. */
export async function exportProjects(db: D1Database): Promise<ExportFile> {
  const { results } = await db.prepare("SELECT key, title, aliases FROM projects ORDER BY key").all<{ key: string; title: string; aliases: string }>();
  const projects = Object.fromEntries(results.map((p) => [p.key, { title: p.title, aliases: JSON.parse(p.aliases) as string[] }]));
  return { path: "projects.json", content: JSON.stringify(projects, null, 2) + "\n" };
}

/** A MEMORY.md index per project, listing its active notes. */
export async function exportIndexes(db: D1Database): Promise<ExportFile[]> {
  const { results } = await db
    .prepare("SELECT project, id, name, description FROM notes WHERE status = 'active' ORDER BY project, name")
    .all<{ project: string; id: string; name: string; description: string }>();
  const byProject = new Map<string, string[]>();
  for (const n of results) {
    const lines = byProject.get(n.project) ?? [];
    lines.push(`- [${n.name}](${n.id}.md) — ${n.description}`);
    byProject.set(n.project, lines);
  }
  return [...byProject].map(([project, lines]) => ({ path: `notes/${project}/MEMORY.md`, content: lines.join("\n") + "\n" }));
}

/** Called by the Action after it pushed (or failed), so memory_context can warn when backups stop. */
export async function recordBackup(
  db: D1Database,
  actor: Actor,
  outcome: { ok: true; notes: number } | { ok: false; error: string },
): Promise<void> {
  if (outcome.ok) {
    await setMeta(db, "last_backup_at", new Date().toISOString());
    await setMeta(db, "last_backup_error", null);
  } else {
    await setMeta(db, "last_backup_error", `${new Date().toISOString()} ${outcome.error}`.slice(0, 200));
  }
  await db
    .prepare("INSERT INTO audit (actor, action, detail) VALUES (?, ?, ?)")
    .bind(actor.name, outcome.ok ? "backup-ok" : "backup-failed", outcome.ok ? `${outcome.notes} notes` : outcome.error)
    .run();
}
