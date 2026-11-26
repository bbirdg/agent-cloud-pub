# My agent-cloud

My AI agent setup, in one place: the rules, skills, subagents and MCP servers every agent gets (Claude Code, Codex,
Antigravity, Cursor, the Claude app), on every PC, plus the settings of my private memory server.
Made with [agent-cloud](https://www.npmjs.com/package/agent-cloud).

| What | Where |
|---|---|
| Rules for every agent | `config/rules/global.md` (agent-only extras: `config/rules/agents/<agent>.md`) |
| My own skills | `config/skills/<name>/SKILL.md` |
| Skills installed from GitHub | `config/skills-vendor.json` |
| Subagents | `config/agents/<agent>/` |
| MCP servers | `config/mcp/catalog.json` (secrets as `${env:NAME}`, saved per PC) |
| Which agents get them | `config/harnesses.json` |
| Memory server settings | `agent-cloud.json` |

## Everyday

```sh
npx agent-cloud sync                 # preview what changes in every agent's files
npx agent-cloud sync --apply         # write them, then restart the agents
npx agent-cloud deploy               # after changing config/skills: serve them from the memory server too
npx agent-cloud skills update --yes  # update the installed skills
npx agent-cloud status               # what's set up on this PC
npx agent-cloud off all | on         # unplug this PC and back (e.g. to test an agent without my setup)
npm update agent-cloud               # a new agent-cloud version; then preview with `npx agent-cloud sync`
```

## Another PC

```sh
git clone <this repo> && cd <it> && npm install
npx agent-cloud device add <pc-name>        # on a PC that's already set up; shows the token once
npx agent-cloud secret set AGENT_MEMORY_TOKEN   # on the new PC; paste the token
npx agent-cloud secret set <NAME>           # every other ${env:NAME} in config/mcp/catalog.json
npx agent-cloud skills update --yes --install
npx agent-cloud sync --apply --adopt
```

Lost a PC: `npx agent-cloud device revoke <pc-name>`.
