import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { mcpResourceUrl } from "./auth";
import { BROWSER_HTML } from "./browser-html";
import { type NoteStatus, backupStatus, listNotes, listProjects, searchNotes } from "./memory";

/** The memory browser as an MCP App: a UI resource plus the tool that opens it (text for hosts without Apps). */

export const BROWSER_URI = "ui://memory/browser";

/** Claude's sandbox origin for this server's apps: first 32 hex chars of sha256(server URL) + ".claudemcpcontent.com". */
export async function claudeAppDomain(serverUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serverUrl));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 32)}.claudemcpcontent.com`;
}

let domain: { url: string; value: Promise<string> } | undefined;
function appDomain(): Promise<string> {
  const url = mcpResourceUrl();
  if (domain?.url !== url) domain = { url, value: claudeAppDomain(url) };
  return domain.value;
}

const STATUS_FILTER = { all: undefined, active: ["active"], muted: ["muted"], deleted: ["deleted"] } satisfies Record<string, NoteStatus[] | undefined>;

export async function registerBrowser(server: McpServer, db: D1Database, text: (s: string) => CallToolResult): Promise<void> {
  const ui = { domain: await appDomain(), prefersBorder: true };

  registerAppResource(
    server,
    "Memory browser",
    BROWSER_URI,
    { description: "Browse, search, mute, delete and restore memory notes.", _meta: { ui } },
    async () => ({ contents: [{ uri: BROWSER_URI, mimeType: RESOURCE_MIME_TYPE, text: BROWSER_HTML, _meta: { ui } }] }),
  );

  registerAppTool(
    server,
    "memory_browse",
    {
      title: "Browse memory",
      description:
        "Open the memory browser (search, filter by project or status, view history, mute/delete/restore) for the user. Hosts without app support get the list as text.",
      inputSchema: z.object({
        project: z.string().optional(),
        query: z.string().optional(),
        status: z.enum(["all", "active", "muted", "deleted"]).optional(),
      }),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: BROWSER_URI, visibility: ["model", "app"] } },
    },
    async ({ project, query, status = "all" }) => {
      const statuses = STATUS_FILTER[status];
      const notes = query?.trim()
        ? await searchNotes(db, { query, project, statuses: statuses ?? ["active", "muted", "deleted"], limit: 50 })
        : await listNotes(db, { project, statuses, limit: 50 });
      const projects = (await listProjects(db)).map((p) => ({ key: p.key, title: p.title, notes: p.notes }));
      const backup = await backupStatus(db);
      const lines = [`${notes.length} note(s)${project ? ` in ${project}` : ""}${query ? ` matching "${query}"` : ""}:`];
      for (const n of notes) lines.push(`- [${n.name}](${n.project}/${n.id}) — ${n.description}${n.status !== "active" ? ` (${n.status})` : ""}`);
      if (backup.warning) lines.push("", backup.warning);
      return {
        ...text(lines.join("\n")),
        structuredContent: { project: project ?? null, query: query ?? "", status, notes, projects, backup },
      };
    },
  );
}
