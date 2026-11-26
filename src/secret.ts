/**
 * Secrets on this PC (~/.agent-cloud/secrets.json): what config/mcp/catalog.json's ${env:NAME} values resolve to,
 * and the memory device token (AGENT_MEMORY_TOKEN). An environment variable of the same name wins.
 *
 *   agent-cloud secret set <NAME>     # asks for the value (or reads it from piped input); never echoed
 *   agent-cloud secret list           # names only
 */
import { ask } from "./prompt.ts";
import { readSecretsFile, saveSecret } from "./project.ts";

export async function main(args: string[]): Promise<void> {
  const [action, name] = args;
  if (action === "set") {
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Use: agent-cloud secret set <NAME> (letters, digits, _)");
    const value = await ask(`${name}: `, { hidden: true });
    if (!value) throw new Error("No value given; nothing saved.");
    saveSecret(name, value);
    return console.log(`Saved ${name} on this PC. Run \`agent-cloud sync --apply\` so your agents get it, then restart them.`);
  }
  if (action === "list") {
    const names = Object.keys(readSecretsFile()).sort();
    return console.log(names.length ? names.join("\n") : "No secrets saved on this PC.");
  }
  throw new Error("Use: agent-cloud secret set <NAME> | secret list");
}
