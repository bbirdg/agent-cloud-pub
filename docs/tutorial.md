# agent-cloud, step by step

By the end you'll have one private memory that Claude Code, Codex, Antigravity, Cursor, the Claude app and claude.ai
all share, and one folder that sets up every agent the same way on every PC. About 20 minutes the first time.

## 0. What you need

- **Node.js 22.12 or newer** ([nodejs.org](https://nodejs.org)). Check: `node --version`.
- **git** ([git-scm.com](https://git-scm.com)).
- **A Cloudflare account** (free): [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up). Your memory
  server runs here, on the free plan.
- **A GitHub account**, and ideally the **GitHub CLI** ([cli.github.com](https://cli.github.com)), signed in with
  `gh auth login`. Setup uses it to find your account and switch on the nightly backup.
- The agents you use, installed as usual.

## 1. Create your folder

```sh
npx @bbirdg/agent-cloud init my-agent-cloud
cd my-agent-cloud
```

From here on, inside that folder, the command is just `npx agent-cloud`.

This makes a folder with example rules, an example skill, a reviewer subagent, two MCP servers (your memory and
Context7's docs search) and the nightly backup workflow. It's yours: edit anything.

## 2. Create your memory server

```sh
npx agent-cloud setup
```

- A browser window asks you to allow Wrangler (Cloudflare's tool) to use your account. Allow it.
- Setup creates a database and a sign-in store, deploys your server and prints its address, like
  `https://agent-memory.<your-account>.workers.dev`.
- It asks for your GitHub account id if the GitHub CLI isn't signed in. Only that account can sign in from claude.ai.
- It gives this PC a device token and saves it in `~/.agent-cloud/secrets.json`.
- It prints a one-time link. Open it and confirm on GitHub: this creates your private sign-in app (no access to your
  repositories).

**Check:** `npx agent-cloud status` shows `ok` for the server and the token.

Want your own domain (say `memory.example.com`)? Your domain must be on Cloudflare. Run
`npx agent-cloud setup --domain memory.example.com`.

## 3. Give every agent your setup

```sh
npx agent-cloud sync                   # preview: what each agent gets
npx agent-cloud sync --apply --adopt   # write it
```

`--adopt` takes over files that already exist (your current `CLAUDE.md`, say), after backing each one up next to
it (`CLAUDE.md.bak-<date>`). Move anything you want to keep into `config/rules/global.md` first.

Restart your agents. **Check:** ask any agent "what's in my memory?". It should call `memory_context`.

The Claude app rewrites its own settings while it runs. If it's open, the sync tells you; quit it from the tray or
menu bar and its servers are written as it closes (on macOS, run the printed command after quitting).

## 4. claude.ai, on the web and your phone

On [claude.ai](https://claude.ai): **Settings > Connectors > Add custom connector**. Paste your server's address
with `/mcp` at the end (`npx agent-cloud status` shows it), connect, and sign in with GitHub. The same memory now
works in claude.ai and the Claude mobile apps.

## 5. Keep your folder safe

Make a **private** GitHub repo and push the folder:

```sh
gh repo create my-agent-cloud --private --source . --push
```

Add `"repo": "<your-github-name>/my-agent-cloud"` to `agent-cloud.json`, then run `npx agent-cloud setup` again.
It switches on the nightly backup: every note goes to the repo's `memory-backup` branch, read with a backup-only
token. Run it once now from the repo's **Actions** tab ("Nightly memory backup" > Run workflow).

## 6. Make it yours

- **Rules:** edit `config/rules/global.md`. Rules for one agent only: `config/rules/agents/<agent>.md`.
- **Your own skills:** a folder in `config/skills/` with a `SKILL.md`. Run `npx agent-cloud deploy` too, so
  claude.ai gets it.
- **Skills from GitHub:** list them in `config/skills-vendor.json`, then `npx agent-cloud skills update --yes --install`.
- **MCP servers:** add them to `config/mcp/catalog.json`. A server you already added straight to an agent:
  `npx agent-cloud adopt-mcp --write` copies it in. A key: write `"${env:MY_KEY}"` in the catalog, then
  `npx agent-cloud secret set MY_KEY`.

After any change: `npx agent-cloud sync` (preview), `--apply`, commit, push.

## 7. Another PC

```sh
git clone https://github.com/<you>/my-agent-cloud && cd my-agent-cloud && npm install
```

On a PC that's already set up: `npx agent-cloud device add <new-pc-name>` (it shows the token once).
On the new PC: `npx agent-cloud secret set AGENT_MEMORY_TOKEN` (paste it), set any other keys the same way, then
`npx agent-cloud skills update --yes --install` and `npx agent-cloud sync --apply --adopt`.

Lost a PC? `npx agent-cloud device revoke <pc-name>`: it can't reach your memory any more.

## 8. Trying an agent without your setup

`npx agent-cloud off all` unplugs this PC: everything agent-cloud wrote is removed (and backed up), so agents run as
if it were never installed. `npx agent-cloud off memory` keeps everything except memory. `npx agent-cloud on`
brings it back exactly as it was.

## Troubleshooting

- **"memory isn't connected" in an agent:** restart the agent; then `npx agent-cloud status`.
- **A server is "left out":** its program isn't installed on this PC, or its secret isn't set here. The warning says
  which.
- **"conflict" in a sync:** you edited a file agent-cloud wrote. Move the change into your folder, delete the file,
  and sync again.
- **After `npm update @bbirdg/agent-cloud`:** run `npx agent-cloud sync` and `npx agent-cloud deploy`.
