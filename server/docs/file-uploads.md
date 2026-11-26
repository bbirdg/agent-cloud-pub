# File uploads: design note (not built yet)

How attachments on notes (screenshots, PDFs, exported configs) would be added with the MCP files extension
`io.modelcontextprotocol/files`, and why it waits.

## Why not now

- **Claude would not send us files.** Claude sends files to connectors only when they are listed in the Connectors
  Directory. This server is a private custom connector, so the main client would never use the feature. Re-check
  this in Claude's connector docs before starting.
- **The extension is an experimental draft** (protocol revision 2026-07-28 and later), with no reference
  implementation and open questions (download format, where uploads land). Building on it now means rework.
- **Notes are text on purpose.** Memory is small facts agents read at session start; files would be rare.

## Shape when we build it

### Storage
- An **R2 bucket** `agent-memory-files` bound as `FILES` (D1 stays small; the free plan has 10 GB of R2).
- Migration `000N_note_files.sql`:

  ```sql
  CREATE TABLE note_files (
    file_id     TEXT PRIMARY KEY,        -- random; also the R2 key (files/<file_id>)
    project     TEXT NOT NULL,
    note_id     TEXT NOT NULL,
    name        TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    size        INTEGER NOT NULL,
    sha256      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'stored', 'deleted')),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    created_by  TEXT NOT NULL
  );
  CREATE INDEX note_files_note ON note_files (project, note_id);
  ```

- Files follow their note: moving a note to the bin hides its files; `memory_purge` deletes the R2 objects and rows
  in the same step; the backup exports file metadata, and optionally the objects.

### Tools
- `memory_attach` (new, or a `files` argument on `memory_save`): the file argument carries `x-mcp-file` in the
  input schema with `accept` (allowed MIME types) and `maxSize` (for example 10 MB). Small files may arrive inline
  (base64 `data`, up to the `maxInlineBytes` we advertise); larger ones go out of band.
- Out of band: the tool answers `resultType: "upload_required"` with one upload target per file (`fileId`, `url`,
  `headers`, `expiresAt`) and a signed `requestState`, minted with the same codec and `MCP_STATE_SECRET` as the
  confirmation prompts (`src/elicit.ts`), bound to the caller and the file ids. The client uploads, then retries the
  call with the same arguments plus `requestState`; the server checks the R2 object (size, SHA-256) before marking it
  `stored`.
- Downloads: `memory_read` lists attachments; reading one returns a download target in the result's
  `_meta["io.modelcontextprotocol/files"].downloads` (`name`, `mimeType`, `size`, `url`, `expiresAt`).
- Clients that declare neither `upload` nor `download` see attachments as names only, as today's text tools.

### Signed upload and download URLs
- New routes `PUT /files/<file_id>` and `GET /files/<file_id>`, outside `/mcp`, authorized only by an HMAC-signed
  query (`file_id`, method, expiry of at most 10 minutes, caller), never by a device token, so a URL leaks nothing
  reusable. The upload route streams the body to R2 with a size cap and refuses a second upload of a stored file.
- Downloads set `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`, so a file never renders as
  a page on this origin.
- Backup-scoped device tokens never reach these routes or the tools (same rule as every MCP route today).

### Limits
- Workers free plan: request bodies up to 100 MB, but keep `maxSize` far lower; stream to R2, never buffer a file
  in memory. One upload is one R2 write plus one D1 update, well inside 50 subrequests and 50 D1 queries.
- Secrets scanning (`findSecret`) cannot read binaries: text-like uploads (`text/*`, JSON) are scanned before they
  are marked `stored`; other types are refused unless the user confirms (an elicitation, as in `memory_purge`).

### Tests to write then
Inline upload stored; `upload_required` round trip with a tampered or expired `requestState` refused; oversize and
wrong MIME type refused; signed URL expired or reused refused; purge removes the R2 object; backup token refused.
