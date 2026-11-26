# Changelog

## 0.1.3

- Fix: `agent-cloud off memory` now removes the memory skill from Antigravity too. It used to come back as a copy of
  another agent's skills folder in the same run.

## 0.1.2

- The release workflow skips a version that is already on npm.
- No changes to the CLI or the memory server.

## 0.1.1

- The first release built and signed by GitHub Actions: npm shows its provenance (which commit and workflow made it).
  Releases are now staged by the workflow and go live only after a maintainer approves them with a security key.
- No changes to the CLI or the memory server.

## 0.1.0

First public version, under the GNU AGPL-3.0.

- `init`, `setup`, `deploy`, `status`: create your folder, deploy your memory server on your Cloudflare account
  (workers.dev or your own domain), connect a PC, switch on the nightly backup.
- `sync`: rules, skills, subagents, the session hook and MCP servers for Claude Code, Codex, Antigravity, Cursor and
  the Claude app; ownership-safe, preview first.
- `off memory|all` / `on`: unplug a PC and plug it back in.
- `skills`: installed skills kept current from public GitHub repos.
- Secrets per PC in `~/.agent-cloud/secrets.json`; `${home}` and `${memoryUrl}` keep the config portable.
