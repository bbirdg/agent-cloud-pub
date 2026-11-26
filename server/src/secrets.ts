/** Patterns for things that must never be stored in memory or served as a skill. No imports: shared by build scripts. */
const SECRET_PATTERNS: [string, RegExp][] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["OpenAI/Anthropic-style key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["Stripe key", /\b[sr]k_live_[A-Za-z0-9]{20,}/],
  ["Context7 key", /\bctx7sk-[A-Za-z0-9-]{20,}/],
  ["agent-memory device token", /\bamem_[A-Za-z0-9_-]{20,}/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  [
    "password or secret value",
    /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?[^\s"']{12,}/i,
  ],
];

/** Returns what kind of secret the text seems to contain, or null. */
export function findSecret(text: string): string | null {
  for (const [label, pattern] of SECRET_PATTERNS) if (pattern.test(text)) return label;
  return null;
}
