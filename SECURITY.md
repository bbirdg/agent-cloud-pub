# Security

agent-cloud holds people's memory, so security reports are welcome and handled first.

**Report a vulnerability privately** through GitHub's "Report a vulnerability" button on this repository's Security
tab. Please don't open a public issue for it.

## What protects your memory

- Your memory server runs on your own Cloudflare account; nobody else has access to it.
- PCs use device tokens; only their SHA-256 is stored, and each can be revoked (`agent-cloud device revoke`).
- claude.ai signs in through your own private GitHub App; the server only accepts the one GitHub account set at
  setup (`ALLOWED_GITHUB_USER_ID`).
- The nightly backup uses a token that can only export.
- The server refuses to store text that looks like a key or password; served skills are checked the same way.
- Secrets stay out of your config folder and off command lines. Each PC keeps them in `~/.agent-cloud/secrets.json`
  (readable only by you on macOS and Linux). Claude Code gets `${NAME}` references, filled from its environment (a
  Windows user variable, or `~/.agent-cloud/env.sh` on macOS and Linux). Codex, Cursor, Antigravity and the Claude app
  can't read references, so their local config files hold the values; on macOS and Linux those files and their
  backups are made readable only by you.
