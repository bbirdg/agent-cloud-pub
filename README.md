# agent-cloud

**One home for your AI agent setup.** A private memory every agent shares, on your own Cloudflare account, plus
your rules, skills, subagents and MCP servers written into every agent on every PC you use.

- **Shared memory.** Claude Code, Codex, Antigravity, Cursor, the Claude app, and claude.ai on the web and your
  phone all read and write the same notes: your preferences, corrections, decisions and where things live. Teach
  one agent once; every agent knows it.
- **One setup, every agent.** Write your rules, skills, subagents and MCP servers once in a folder you own (a git
  repo). `agent-cloud sync` writes each agent's own files in its own format, on every PC.
- **Yours.** The memory server runs on your own Cloudflare account (the free plan is enough). Nobody else, including
  the authors of this package, can read it. Sign-in from claude.ai only accepts your GitHub account; each PC has its
  own revocable token.
- **Safe by default.** Every sync previews first. It never touches a file it didn't write (unless you let it adopt
  one, after a backup), never overwrites a hand edit, and keeps secrets out of git.

## Quick start

You need Node.js 22.12 or newer, git, a free Cloudflare account and a GitHub account.

```sh
npx @bbirdg/agent-cloud init my-agent-cloud   # your folder: example rules, a skill, a subagent, MCP servers
cd my-agent-cloud
npx agent-cloud setup                   # creates and deploys your memory server, connects this PC
npx agent-cloud sync                    # preview what every agent gets
npx agent-cloud sync --apply --adopt    # write it (existing files are backed up first), then restart your agents
```

Then put the folder in a **private** GitHub repo (it holds your rules; its `memory-backup` branch will hold every
note) and run `npx agent-cloud setup` once more to switch on the nightly backup.

New to this? [The step-by-step tutorial](https://github.com/bbirdg/agent-cloud-pub/blob/main/docs/tutorial.md) walks through every click.

## What goes where

| Your folder | What it is | Agents get it as |
|---|---|---|
| `config/rules/global.md` | rules for every agent | `CLAUDE.md`, `AGENTS.md` (Codex, Antigravity), Cursor's User Rules |
| `config/rules/agents/<agent>.md` | extras for one agent | appended to that agent's rules |
| `config/skills/<name>/` | your own skills (Agent Skills format) | each agent's skills folder, and served over MCP |
| `config/skills-vendor.json` | skills from public GitHub repos | installed and kept current |
| `config/agents/<agent>/` | subagents | each agent's subagents folder |
| `config/mcp/catalog.json` | MCP servers | each agent's MCP config, in its format |
| `config/harnesses.json` | which agents to write to | |
| `agent-cloud.json` | your memory server's settings | |

Secrets never go in the folder: the catalog says `${env:NAME}` and each PC keeps its values in
`~/.agent-cloud/secrets.json` (`npx agent-cloud secret set NAME`).

## Commands

```text
init <folder>             create your agent-cloud folder
setup                     create and deploy your memory server, connect this PC, set up the backup
status                    what's set up on this PC and what's missing
sync [--apply] [--adopt]  preview / write every agent's files
deploy [--dry-run]        redeploy the memory server (after changing config/skills or updating agent-cloud)
skills [update [--yes]]   check / update the skills in config/skills-vendor.json
off [memory|all] / on     unplug this PC (test an agent without your setup) and plug it back in
device add|list|revoke    device tokens: one per PC, or a backup-only one
secret set|list           secrets on this PC
adopt-mcp [--write]       bring MCP servers you added straight to an agent into the catalog
restore                   restore memory from the backup branch
```

## Testing an agent without your setup

`npx agent-cloud off all` removes everything agent-cloud wrote on this PC (backed up), including the setting that
turns Claude Code's built-in memory off, so agents run as if agent-cloud were never installed.
`npx agent-cloud off memory` keeps your rules, skills and servers but leaves memory out. `npx agent-cloud on`
brings it all back. It only affects this PC. Connectors you added on claude.ai belong to your account, not the PC:
for a one-off clean Claude Code session, `claude --safe-mode` with `ENABLE_CLAUDEAI_MCP_SERVERS=false`.

## How it works

- **Memory server**: a Cloudflare Worker with a D1 database, speaking MCP over Streamable HTTP. PCs use device
  tokens (only their SHA-256 is stored); claude.ai signs in through your own private GitHub App (OAuth 2.1, created
  with one click during setup, no repository access). Deleting a note moves it to a bin; erasing for good asks you
  to confirm. A memory browser opens in agents that support MCP Apps.
- **Sync**: ownership-safe. A manifest in `~/.agent-cloud` records a hash of everything it wrote; it only changes
  or removes those entries, reports hand edits as conflicts, and backs up a file before its first write. Paths in
  your folder use `${home}`, so one config works for any user name; a server whose program isn't installed on a
  PC is left out there, with a warning.
- **Session hook** (Claude Code): loads the memory index for the folder you're in, says when config changes or an
  agent-cloud update wait to be applied, and updates the skills you marked `auto` once a day.
- **Backup**: a GitHub Action in your private repo exports every note nightly to the `memory-backup` branch, with a
  backup-only token. Sessions warn when backups stop.

## Platforms

CI runs the CLI and the sync on Windows, macOS and Linux (Node 22 and 24), the memory server in the Workers runtime,
and an install from the packed package. `setup` and `deploy` have been run against a real Cloudflare account from
Windows. Not checked by hand yet: the real agent apps on macOS and Linux, and the Claude app's config path on Linux
(it follows the Electron default).
On Windows with the Store build of the Claude app, a program you install under `AppData` from a terminal inside a
Claude session lands in the app's private copy of `AppData`, where other agents can't see it; `agent-cloud status`
points these out.

## Updating

`npm update @bbirdg/agent-cloud` in your folder, then `npx agent-cloud sync` to preview what changes and
`npx agent-cloud deploy` for the memory server. The session hook tells you when an update waits.

## License

Copyright 2026 bbirdg. [GNU AGPL-3.0](LICENSE).

Using agent-cloud for yourself, unchanged, asks nothing of you. If you change the memory server and let others use
your changed version over a network (a hosted service, say), the AGPL requires you to offer them its source code under
the same license.
