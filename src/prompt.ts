/** Asking the person running a command. Piped input works too (scripts, CI); hidden answers are never echoed. */
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

export async function ask(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  if (!process.stdin.isTTY) {
    let input = "";
    for await (const chunk of process.stdin) input += String(chunk);
    return input.split(/\r?\n/)[0]!.trim();
  }
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk, encoding);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const answer = new Promise<string>((resolve) => rl.question(question, resolve));
  muted = Boolean(opts.hidden);
  const value = await answer;
  rl.close();
  if (opts.hidden) process.stdout.write("\n");
  return value.trim();
}

export async function confirm(question: string): Promise<boolean> {
  return /^y(es)?$/i.test(await ask(`${question} [y/N] `));
}
