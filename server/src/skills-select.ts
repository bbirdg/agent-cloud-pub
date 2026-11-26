// Pure skill selection (no Node APIs, no file system): the CLI runs it before a deploy to build skills.json, and the
// Workers test runtime tests it too.
import { SkillCatalog, memorySkillFiles } from "@modelcontextprotocol/server/ext/skills";
import { findSecret } from "./secrets.ts";

export const MAX_SKILL_BYTES = 400 * 1024;
export const MAX_FILE_BYTES = 100 * 1024;
/** Served by the server itself (agent-memory) or built from global.md; a user skill with one of these names is skipped. */
export const RESERVED_SKILLS = ["agent-memory", "global-rules"];

/** One file of a skill; `path` is relative to the skill folder. */
export interface SkillFile {
  path: string;
  bytes: Uint8Array;
}

/** `builtIn` marks the skills the CLI makes itself (global-rules), which may use a reserved name. */
export interface SkillInput {
  name: string;
  files: SkillFile[];
  builtIn?: boolean;
}

/** How one skill is shaped for serving: excluded folders ("engine/") or files, and a note at the top of SKILL.md. */
export interface ServeRule {
  exclude?: string[];
  note?: string;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/**
 * Text with LF line ends (so a Windows checkout produces the same catalog and valid frontmatter), or null for
 * binary content (a NUL byte or invalid UTF-8).
 */
function asText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return utf8.decode(bytes).replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}

const slashes = (p: string) => p.replace(/\\/g, "/");

/** Picks the skills that can be served, keyed "<skill>/<path>". */
export async function selectSkills(
  skills: SkillInput[],
): Promise<{ files: Record<string, string>; skipped: { name: string; reason: string }[] }> {
  const files: Record<string, string> = {};
  const skipped: { name: string; reason: string }[] = [];
  for (const skill of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
    const checked = await checkSkill(skill);
    if (typeof checked === "string") skipped.push({ name: skill.name, reason: checked });
    else Object.assign(files, checked);
  }
  return { files, skipped };
}

/** The skill's text files, or why it can't be served. */
async function checkSkill({ name, files, builtIn }: SkillInput): Promise<Record<string, string> | string> {
  if (!builtIn && RESERVED_SKILLS.includes(name)) return "reserved name";
  if (!files.some((f) => f.path === "SKILL.md")) return "no SKILL.md";
  let total = 0;
  const text: Record<string, string> = {};
  for (const file of files) {
    total += file.bytes.byteLength;
    // Dotfiles (.env, .npmrc, ...) are never served.
    if (file.path.split(/[\\/]/).some((part) => part.startsWith("."))) return `${file.path} is a hidden file`;
    if (file.bytes.byteLength > MAX_FILE_BYTES) return `${file.path} is over ${MAX_FILE_BYTES / 1024} KB`;
    const content = asText(file.bytes);
    if (content === null) return `${file.path} is binary`;
    const secret = findSecret(content);
    if (secret) return `${file.path} looks like it contains a ${secret}`;
    text[`${name}/${slashes(file.path)}`] = content;
  }
  if (total > MAX_SKILL_BYTES) return `over ${MAX_SKILL_BYTES / 1024} KB in total`;
  // The server loads the catalog in strict mode: one bad skill there would fail every request, so check it here.
  try {
    await SkillCatalog.load(memorySkillFiles(text), { strict: true, onWarning: () => {} });
  } catch (error) {
    return `invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
  return text;
}

/** Shapes one skill for serving by its rule. Skills without a rule are returned unchanged. */
export function applyServeRule<S extends { files: SkillFile[] }>(skill: S, rule: ServeRule | undefined): S {
  if (!rule) return skill;
  const excluded = (p: string) => (rule.exclude ?? []).some((x) => (x.endsWith("/") ? p.startsWith(x) : p === x));
  const files = skill.files
    .map((f) => ({ ...f, path: slashes(f.path) }))
    .filter((f) => !excluded(f.path))
    .map((f) => {
      if (f.path !== "SKILL.md" || !rule.note) return f;
      const text = new TextDecoder().decode(f.bytes).replace(/\r\n/g, "\n");
      const m = /^---\n[\s\S]*?\n---\n/.exec(text);
      const out = m ? `${m[0]}\n> ${rule.note}\n${text.slice(m[0].length)}` : `> ${rule.note}\n\n${text}`;
      return { ...f, bytes: new TextEncoder().encode(out) };
    });
  return { ...skill, files };
}

/** The global-rules skill: the user's global.md with skill frontmatter. */
export function globalRulesSkill(markdown: string): string {
  const body = markdown.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  return [
    "---",
    "name: global-rules",
    "description: The user's global working rules for every agent (autonomy, engineering, verification, communication). Read them at the start of work and follow them in every project.",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

/** The skills.json the server reads from its SKILLS assets binding; keys sorted, so the same skills give the same text. */
export function skillsJson(files: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(files).sort()) sorted[key] = files[key]!;
  return JSON.stringify({ files: sorted });
}
