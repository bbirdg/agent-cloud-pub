import { SkillCatalog, memorySkillFiles } from "@modelcontextprotocol/server/ext/skills";
import type { Env } from "./env";
import { SKILL_MD } from "./memory-text";

/**
 * The user's skills, written by the CLI at deploy time (skillsJson in skills-select.ts). The assets run behind the
 * Worker (run_worker_first), so this file is reachable only through the binding, never publicly.
 */
const SKILLS_URL = "https://assets.local/skills.json";

let catalog: Promise<SkillCatalog> | undefined;

/** The skills catalog, loaded once per isolate. */
export function skillCatalog(env: Pick<Env, "SKILLS">): Promise<SkillCatalog> {
  catalog ??= loadSkillCatalog(env.SKILLS).catch((error: unknown) => {
    catalog = undefined; // let the next request retry instead of caching the failure for the isolate's life
    throw error;
  });
  return catalog;
}

/**
 * The user's skills plus agent-memory, which is always served from SKILL_MD. Without the binding or the file only
 * agent-memory is served. Strict, so a broken skills.json fails loudly; the CLI already skips skills that would.
 */
export async function loadSkillCatalog(assets: Fetcher | undefined): Promise<SkillCatalog> {
  const files = assets ? await readSkillsJson(assets) : {};
  for (const key of Object.keys(files)) if (key.startsWith("agent-memory/")) delete files[key];
  files["agent-memory/SKILL.md"] = SKILL_MD;
  return SkillCatalog.load(memorySkillFiles(files), { strict: true });
}

async function readSkillsJson(assets: Fetcher): Promise<Record<string, string>> {
  const response = await assets.fetch(SKILLS_URL);
  if (response.status === 404) return {};
  if (!response.ok) throw new Error(`skills.json: HTTP ${response.status}`);
  const { files } = (await response.json()) as { files?: unknown };
  if (typeof files !== "object" || files === null || Array.isArray(files)) throw new Error("skills.json: no files object");
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(files)) {
    if (typeof value !== "string") throw new Error(`skills.json: ${key} is not text`);
    out[key] = value;
  }
  return out;
}
