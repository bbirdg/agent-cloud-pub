/**
 * The note file format (pure: no Workers APIs), shared by the server and the CLI's restore.
 */

export const NOTE_TYPES = ["user", "feedback", "project", "reference"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export function extractLinks(body: string): string[] {
  return [...new Set([...body.matchAll(/\[\[([^\]\n]+)\]\]/g)].map((m) => m[1]!.trim()))];
}

export interface ParsedNote {
  name: string;
  description: string;
  type: string;
  status?: string;
  statusReason?: string;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
  version?: number;
  body: string;
}

function unquoteYaml(value: string): string {
  const v = value.trim();
  if (v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/**
 * Reads a note file: the backup's own format, and Claude Code memory files (type at top level or under
 * metadata, quoted or plain values, CRLF or LF). `exportedBody` strips the one newline noteToMarkdown adds.
 */
export function parseNoteMarkdown(text: string, exportedBody = false): ParsedNote {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!m) throw new Error("no frontmatter");
  const fields: Record<string, string> = {};
  let parent = "";
  for (const line of m[1]!.split("\n")) {
    const kv = /^(\s*)([\w-]+):\s?(.*)$/.exec(line);
    if (!kv) continue;
    const [, indent, key, value] = kv;
    if (!indent) parent = value!.trim() === "" ? key! : "";
    fields[indent && parent ? `${parent}.${key}` : key!] = unquoteYaml(value!);
  }
  let body = m[2]!;
  if (exportedBody) body = body.endsWith("\n") ? body.slice(0, -1) : body;
  else body = body.replace(/^\n+/, "");
  return {
    name: fields.name ?? "",
    description: (fields.description ?? "").replace(/\s*\n\s*/g, " ").trim(),
    type: fields["metadata.type"] ?? fields.type ?? "",
    status: fields.status,
    statusReason: fields.status_reason,
    createdAt: fields.created_at,
    updatedAt: fields.updated_at,
    updatedBy: fields.updated_by,
    version: fields.version && /^\d+$/.test(fields.version) ? Number(fields.version) : undefined,
    body,
  };
}
