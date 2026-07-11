import { createHash } from "node:crypto";

// Ported from pi-claude-auth (src/signing.ts + transforms.ts). Routes
// subscription (OAuth-stealth) Claude requests to the Pro/Max PLAN instead of
// the "extra usage" bucket, working around the 400 "Third-party apps now draw
// from extra usage, not plan limits" rejection.
//
// pi-pi decision (see design-options.md): the billing header is injected as
// system[0] via the `before_provider_request` payload hook; the system-prompt
// RELOCATION that pi-claude-auth also does is SKIPPED (unproven for our gateway
// 400, invasive). The full-form user-agent is set separately through the
// subscription provider's model.headers (that hook has no header surface). The
// billing header's cc_version MUST match the user-agent version, so both derive
// from the single CC_VERSION constant here.

const BILLING_SALT = "59cf53e54c78";
export const CC_VERSION = process.env.ANTHROPIC_CLI_VERSION ?? "2.1.160";
export const CC_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT ?? "sdk-cli";
const BILLING_PREFIX = "x-anthropic-billing-header";
const CC_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

// The full-form Claude Code user-agent. pi-ai sends a bare `claude-cli/<ver>`;
// Anthropic's plan-billing validation expects this form.
export function buildUserAgent(): string {
  return process.env.ANTHROPIC_USER_AGENT ?? `claude-cli/${CC_VERSION} (external, ${CC_ENTRYPOINT})`;
}

type SystemEntry = { type?: string; text?: string } & Record<string, unknown>;
interface AnthropicPayload {
  model?: unknown;
  system?: unknown;
  messages?: unknown;
}

function isClaudeModel(model: unknown): model is string {
  return typeof model === "string" && model.toLowerCase().includes("claude");
}

function entryText(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const text = (entry as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

// Text of the first user message's first text block — the input Claude Code
// hashes for the billing header (mirrors its selection exactly).
function extractFirstUserMessageText(messages: Array<{ role?: string; content?: unknown }>): string {
  const userMsg = messages.find((m) => m.role === "user");
  if (!userMsg) return "";
  const content = userMsg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textBlock = content.find((b) => (b as { type?: string }).type === "text") as { text?: string } | undefined;
    if (textBlock?.text) return textBlock.text;
  }
  return "";
}

function computeCch(messageText: string): string {
  return createHash("sha256").update(messageText).digest("hex").slice(0, 5);
}

function computeVersionSuffix(messageText: string, version: string): string {
  const sampled = [4, 7, 20].map((i) => (i < messageText.length ? messageText[i] : "0")).join("");
  return createHash("sha256").update(`${BILLING_SALT}${sampled}${version}`).digest("hex").slice(0, 3);
}

function buildBillingHeaderValue(messages: Array<{ role?: string; content?: unknown }>): string {
  const text = extractFirstUserMessageText(messages);
  const suffix = computeVersionSuffix(text, CC_VERSION);
  const cch = computeCch(text);
  return `${BILLING_PREFIX}: cc_version=${CC_VERSION}.${suffix}; cc_entrypoint=${CC_ENTRYPOINT}; cch=${cch};`;
}

// Prepend the billing header as system[0] of an OAuth-stealth Anthropic payload.
// Idempotent, gated to Claude models whose system[] carries pi-ai's Claude Code
// identity block (so plain API-key requests are never touched). Mutates and
// returns the payload when injected; returns false otherwise. NO relocation:
// pi's other system content stays in place and cch is computed on the existing
// first user message as-is.
export function injectBillingHeader(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as AnthropicPayload;
  if (!isClaudeModel(p.model)) return false;
  if (!Array.isArray(p.messages)) return false;
  const system: SystemEntry[] = Array.isArray(p.system) ? (p.system as SystemEntry[]) : [];
  if (!system.some((e) => entryText(e).startsWith(CC_IDENTITY))) return false;
  if (system.some((e) => entryText(e).startsWith(BILLING_PREFIX))) return false;
  const billingHeader = buildBillingHeaderValue(p.messages as Array<{ role?: string; content?: unknown }>);
  p.system = [{ type: "text", text: billingHeader }, ...system];
  return true;
}
