# Global instructions

These rules go to every agent (Claude Code, Codex, Antigravity, Cursor) on every PC where you run
`npx agent-cloud sync --apply`. Write them once here; each agent gets them in its own format. Replace this example
with how you want your agents to work.

## Working style
- Lead with the result, then the details. Keep answers short unless asked for depth.
- Read the relevant code and existing patterns before changing anything; reuse what exists.
- Keep each change focused on the task, and fix the root cause, not the symptom.

## Verification
- Before calling work done, run the cheapest check that exercises the change (a test, a type-check, a build).
- If no check could run, say which one and why.

## Safety
- Ask before anything destructive or hard to undo (deleting data, force-pushing, deploying, publishing).
- Never commit secrets.
