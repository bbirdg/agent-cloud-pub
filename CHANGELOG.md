# Changelog

## 0.2.0

- The bin empties itself: once a day, notes deleted more than 14 days ago are erased for good. Change it with
  `memory.binDays` in `agent-cloud.json` (0 = never), then `agent-cloud deploy`.
- `memory_purge` works in apps that declare confirmation forms but can't show them (they decline every form unseen):
  the agent confirms with you in chat and calls again with `no_form`, for notes in the bin 24 hours or more.
- `memory_save` won't save over a note in the bin (its new text would be erased with it): restore it first.
- `agent-cloud restore` gives notes restored into the bin their full bin time again.
- Run `agent-cloud sync` (the memory rules mention the bin's time limit) and `agent-cloud deploy` after updating. On
  the next daily run after deploying, notes already in the bin for more than 14 days are erased.

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
