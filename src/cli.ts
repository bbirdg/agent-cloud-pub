#!/usr/bin/env node
/**
 * agent-cloud: one home for your AI agent setup.
 * Every command loads only its own module, so the session hook starts fast.
 */
import { packageVersion } from "./project.ts";

const HELP = `agent-cloud ${packageVersion}: your shared agent memory and setup, on your own Cloudflare account

Start
  init <folder>              create your agent-cloud folder (config, settings, backup workflow)
  setup                      create and deploy your memory server, and connect this PC
  status                     what's set up on this PC and what's missing

Everyday (run inside your agent-cloud folder)
  sync                       preview what would change in every agent's files
  sync --apply [--adopt]     write them (--adopt takes over files that already exist, after a backup)
  sync --pull [--apply]      copy your own skills edited in an agent's folder back into config/skills
  sync --cursor-rules        print the rules to paste into Cursor > Settings > Rules
  skills [update [--yes]]    check or update the installed skills in config/skills-vendor.json
  deploy [--dry-run]         redeploy the memory server (after editing config/skills or an agent-cloud update)
  off [memory|all]           unplug this PC: leave out memory, or everything agent-cloud wrote (backed up)
  on                         plug it back in

Devices and secrets
  device add <name> [--scope backup] [--save] [--stdout]   a token for a PC (--save: this PC) or the backup
  device list | device revoke <name>
  secret set <NAME>          save a secret on this PC (read from the input, never echoed)
  secret list                names of the secrets saved on this PC

Other
  adopt-mcp [--write]        bring MCP servers added straight to an agent into config/mcp/catalog.json
  backup pull | backup report      used by the nightly backup workflow
  restore --from <dir> --local|--remote [--force]   restore memory from a backup checkout

Options: --project <folder> (default: the folder you're in, then the last one used on this PC)`;

const [command, ...rest] = process.argv.slice(2);

/** Runs a module written as a script (it reads process.argv itself). */
async function script(file: string, args: string[]): Promise<void> {
  process.argv = [process.argv[0]!, file, ...args];
  await import(file);
}

const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";

try {
  switch (command) {
    case "sync":
      await (await import(`./sync/sync${ext}`)).main(rest);
      break;
    case "skills":
      await script(`./skills/update${ext}`, rest);
      break;
    case "adopt-mcp":
      await script(`./sync/adopt-mcp${ext}`, rest);
      break;
    case "restore":
      await script(`./restore${ext}`, rest);
      break;
    case "hook":
      await (await import(`./hook${ext}`)).main();
      break;
    case "off":
    case "on":
      await (await import(`./off${ext}`)).main(command, rest);
      break;
    case "deploy":
      await (await import(`./deploy${ext}`)).main(rest);
      break;
    case "setup":
      await (await import(`./setup${ext}`)).main(rest);
      break;
    case "init":
      await (await import(`./init${ext}`)).main(rest);
      break;
    case "status":
      await (await import(`./status${ext}`)).main(rest);
      break;
    case "device":
    case "devices":
      await (await import(`./devices${ext}`)).main(rest);
      break;
    case "secret":
    case "secrets":
      await (await import(`./secret${ext}`)).main(rest);
      break;
    case "backup":
      await (await import(`./backup${ext}`)).main(rest);
      break;
    case "--version":
    case "-v":
      console.log(packageVersion);
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
} catch (error) {
  console.error(`agent-cloud ${command}: ${(error as Error).message}`);
  process.exitCode = 1;
}
