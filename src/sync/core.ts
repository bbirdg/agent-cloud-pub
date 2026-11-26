/**
 * Ownership-safe writer for agent config files.
 * - A manifest (<home>/.agent-cloud/managed.json) records every entry this tool wrote, with a hash.
 * - It only changes or removes entries it wrote. Unmanaged things are never touched, except a whole file
 *   the user explicitly lets it adopt (--adopt), which is backed up first.
 * - If a managed entry was edited by hand since the last sync, it reports a conflict instead of overwriting.
 * - A lock file stops two runs at once.
 */
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

export type Status = "create" | "update" | "unchanged" | "adopt" | "remove" | "conflict" | "unmanaged" | "skip";

export interface Change {
  id: string;
  status: Status;
  detail?: string;
}

export interface Entry {
  /** Stable id, e.g. "codex:rules", "cursor:mcp:context7". */
  id: string;
  /** Current text of what this entry owns, or null if absent. */
  read(): string | null;
  /** Desired text, or null to remove. */
  desired: string | null;
  /** Writes `text` (null = remove). */
  write(text: string | null): void;
  /** Whole-file entries can be adopted (backup + replace) when unmanaged. */
  adoptable?: boolean;
  /** File to back up before the first write or an adoption. */
  backupFile?: string;
  /** Folder copied to ~/.agent-cloud/backups/<run>/ before it is adopted (e.g. a skill folder of the same name). */
  backupDir?: string;
}

interface Manifest {
  version: 1;
  entries: Record<string, { hash: string; at: string }>;
}

export class Sync {
  readonly changes: Change[] = [];
  private manifest: Manifest;
  private readonly manifestPath: string;
  private readonly lockPath: string;
  private readonly backups = new Set<string>();
  private readonly stamp = new Date().toISOString().replace(/[:.]/g, "-");

  readonly home: string;
  readonly options: { apply: boolean; adopt: boolean };

  constructor(home: string, options: { apply: boolean; adopt: boolean }) {
    this.home = home;
    this.options = options;
    const dir = path.join(home, ".agent-cloud");
    this.manifestPath = path.join(dir, "managed.json");
    this.lockPath = path.join(dir, "sync.lock");
    this.manifest = existsSync(this.manifestPath)
      ? (JSON.parse(readFileSync(this.manifestPath, "utf8")) as Manifest)
      : { version: 1, entries: {} };
  }

  lock(): void {
    if (!this.options.apply) return;
    mkdirSync(path.dirname(this.lockPath), { recursive: true });
    if (existsSync(this.lockPath) && Date.now() - statSync(this.lockPath).mtimeMs < 10 * 60_000) {
      throw new Error(`Another sync is running (lock ${this.lockPath}). Delete it if that run crashed.`);
    }
    writeFileSync(this.lockPath, String(process.pid));
  }

  unlock(): void {
    if (this.options.apply && existsSync(this.lockPath)) rmSync(this.lockPath);
  }

  /** Copies a file before its first change in this run; keeps its newest few copies (they can hold secrets). */
  private backup(file: string | undefined): void {
    if (!file || this.backups.has(file) || !existsSync(file)) return;
    const copy = `${file}.bak-${this.stamp}`;
    copyFileSync(file, copy);
    makePrivate(copy);
    this.backups.add(file);
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.bak-`;
    const old = readdirSync(dir).filter((n) => n.startsWith(prefix)).sort().reverse().slice(KEEP_BACKUPS);
    for (const n of old) rmSync(path.join(dir, n), { force: true });
  }

  /** Decides and (when applying) performs one entry. */
  handle(entry: Entry): void {
    const current = entry.read();
    const managed = this.manifest.entries[entry.id];
    const want = entry.desired;

    const record = (status: Status, detail?: string): void => void this.changes.push({ id: entry.id, status, detail });

    if (want === null) {
      if (!managed) return; // never ours, nothing to remove
      if (current === null) {
        if (this.options.apply) delete this.manifest.entries[entry.id];
        return;
      }
      if (hash(current) !== managed.hash) return record("conflict", "edited by hand since the last sync; not removed");
      record("remove");
      if (this.options.apply) {
        this.backup(entry.backupFile);
        entry.write(null);
        delete this.manifest.entries[entry.id];
      }
      return;
    }

    if (current !== null && current === want) {
      if (this.options.apply) this.manifest.entries[entry.id] = { hash: hash(want), at: new Date().toISOString() };
      return record("unchanged");
    }

    let status: Status;
    if (current === null) status = "create";
    else if (managed && hash(current) === managed.hash) status = "update";
    else if (managed) return record("conflict", "edited by hand since the last sync; move the edit into config/ (or delete the file), then sync again");
    else if (entry.adoptable && this.options.adopt) status = "adopt";
    else return record("unmanaged", entry.adoptable ? "exists and isn't managed yet; rerun with --adopt to back it up and take it over" : "a different entry with this name exists; left alone");

    record(status);
    if (this.options.apply) {
      this.backup(entry.backupFile);
      if (status === "adopt" && entry.backupDir && existsSync(entry.backupDir)) {
        const to = path.join(this.home, ".agent-cloud", "backups", this.stamp, path.relative(this.home, entry.backupDir));
        cpSync(entry.backupDir, to, { recursive: true });
      }
      entry.write(want);
      this.manifest.entries[entry.id] = { hash: hash(want), at: new Date().toISOString() };
    }
  }

  /** The hash recorded for an entry at the last sync, if this tool owns it. */
  managedHash(id: string): string | undefined {
    return this.manifest.entries[id]?.hash;
  }

  /** Ids this tool owns under a prefix (to find entries that should be removed). */
  managedIds(prefix: string): string[] {
    return Object.keys(this.manifest.entries).filter((id) => id.startsWith(prefix));
  }

  save(): void {
    if (!this.options.apply) return;
    mkdirSync(path.dirname(this.manifestPath), { recursive: true });
    writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2) + "\n");
  }
}

// ---------- small file helpers ----------

export const readText = (file: string): string | null => (existsSync(file) ? readFileSync(file, "utf8").replace(/\r\n/g, "\n") : null);

export function writeText(file: string, text: string | null, opts: { private?: boolean } = {}): void {
  if (text === null) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
  if (opts.private) makePrivate(file);
}

/**
 * Writes a whole file through a temporary copy and a rename, so a program reading it never sees half a file; a
 * file another program holds open (Windows) is written in place instead.
 */
export function replaceFile(file: string, text: string, opts: { private?: boolean } = {}): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.agent-cloud-${process.pid}`;
  writeFileSync(temp, text, "utf8");
  if (opts.private) makePrivate(temp);
  try {
    renameSync(temp, file);
  } catch {
    rmSync(temp, { force: true });
    writeText(file, text, opts);
  }
}

/** Readable by this user only (macOS/Linux; Windows keeps it in the user's own profile). For files holding secrets. */
export function makePrivate(file: string): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(file, 0o600);
  } catch {
    // not ours to change
  }
}

const KEEP_BACKUPS = 3;

export function expandHome(p: string, home: string): string {
  return p.startsWith("~") ? path.join(home, p.slice(1)) : p;
}
