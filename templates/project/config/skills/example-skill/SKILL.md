---
name: example-skill
description: An example of your own skill. Replace or delete it. Use when the user asks how agent-cloud skills work.
---

# Example skill

Every folder in `config/skills` is one of your own skills (the open Agent Skills format: a `SKILL.md` with a name
and a description, plus any files it needs). `npx agent-cloud sync --apply` copies it to every agent on this PC, and
`npx agent-cloud deploy` also serves it over MCP from your memory server, so claude.ai and other remote clients can
use it too.

To make your own: copy this folder, rename it, and write the instructions an agent should follow.
