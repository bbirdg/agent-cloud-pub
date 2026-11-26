# Changelog

## 0.1.0

First public version.

- `init`, `setup`, `deploy`, `status`: create your folder, deploy your memory server on your Cloudflare account
  (workers.dev or your own domain), connect a PC, switch on the nightly backup.
- `sync`: rules, skills, subagents, the session hook and MCP servers for Claude Code, Codex, Antigravity, Cursor and
  the Claude app; ownership-safe, preview first.
- `off memory|all` / `on`: unplug a PC and plug it back in.
- `skills`: installed skills kept current from public GitHub repos.
- Secrets per PC in `~/.agent-cloud/secrets.json`; `${home}` and `${memoryUrl}` keep the config portable.
