# Prompt & Nudge Architecture for the pi-pi Orchestrator

Design artifact for a systematic rework of all prompts (system prompts) and harness-injected messages (continuation/nudge/entry) in the multi-phase orchestrator. Prompt-only enforcement: no per-phase tool restriction, no tool_call blocking.

## Problem (observed, not hypothetical)

Two failure modes were confirmed against real session traces (`.pp/logs/traces/`, session `baa776a6-cd9_implement`):

1. **Stalling.** In a trivial autonomous task, 14 of ~40 turns ended as text-only stops ("nothing further to do", "awaiting review"), and the user had to manually type `continue` once. The agent idled instead of calling `pp_phase_complete` or continuing.
2. **Scope drift into code.** The agent attempted to write/modify project code during a read-only phase on its own initiative (not because the user asked).

A wasteful review loop (3 unanimous-APPROVE passes on a one-line change) was a separate logic bug, fixed earlier (verdict-aware early-exit).

## Verified platform mechanics (pi)

These determine where instructions are durable. Verified from pi docs (`docs/compaction.md`, `docs/extensions.md`) and the extension source.

- The **system prompt is rebuilt fresh on every `before_agent_start`** (fires once per agent run / per user prompt, not per internal tool-turn). The orchestrator assembles: `event.systemPrompt + WORKING_PRINCIPLES + COMMUNICATION + TOOL_ROUTING + systemSnippets + phasePrompt + autonomousPrompt`.
- **Compaction never touches the system prompt.** It summarizes only the conversation messages; the system prompt sits in the `system` slot, outside the summarized region ("What the LLM sees" diagram in `docs/compaction.md`).
- **Conversation messages** (`safeSendUserMessage`, `pp-artifact-reinject`) live in the summarizable region and can be dropped/summarized by compaction.
- Two orchestrator-initiated compactions (phase-transition, task-done) return early in `session_before_compact`; the **fall-through branch** handles natural mid-phase auto-compaction and currently re-injects artifacts only.

Consequence: **standing constraints belong in the system prompt** (durable, compaction-proof, primacy zone). The generic "Governance Decay → re-inject constraints after compaction" idea from the research does **not** apply here, because our constraints already live in the compaction-proof system prompt rather than in the conversation. (See Research notes, item R7.)

## The two delivery channels

| | Channel A — System prompt | Channel B — Conversation messages |
|---|---|---|
| Set by | `before_agent_start`, per agent run | `safeSendUserMessage` / `sendMessage` |
| Compaction | Never compacted (durable) | Can be summarized/dropped |
| Attention zone | Primacy (top of context) | Recency (bottom, newest msg) |
| Use for | Standing constraints, role, workflow | Just-in-time nudges, phase-entry, scope reminders |

Design principle: **standing rules → Channel A (primacy, durable); time-sensitive corrections → Channel B (recency, fresh).** The two high-attention ends of the U-shaped attention curve are each owned by the channel best suited to it. No third "re-inject constraints into conversation" layer is needed.

## System-prompt skeleton (Channel A)

Every phase prompt uses the same skeleton so behavior is consistent across phases and across models (opus / gpt / gemini run interchangeably).

```
[event.systemPrompt]                      ← pi base, untouched

╔═══ TOP CRITICAL BLOCK ═══╗              ◄ PRIMACY zone
║ <role>       you ARE X / NOT Y          ║
║ <priority>   these rules override your  ║
║              own impulses & inferred    ║
║              next steps                 ║
║ <constraints> MUST NOT … / INSTEAD MUST ║
╚══════════════════════════╝

WORKING_PRINCIPLES
COMMUNICATION                             ← reference middle (degrades ~20%;
TOOL_ROUTING                                 acceptable — lookup material, not rules)
systemSnippets
phasePrompt body (research steps, artifact formats, workflow)
autonomousPrompt

╔═══ END RE-ANCHOR (1–3 lines) ═══╗       ◄ RECENCY zone of the system prompt
║ Restate the SINGLE most important rule  ║
╚═════════════════════════════════╝
```

Rules:
- TOP block order: role → priority-override → constraints. Every prohibition paired with a positive alternative.
- Middle holds procedural/reference content. NOT repeated — full prompt repetition is wasteful for reasoning models (see R3).
- END re-anchor restates only the one load-bearing rule, tersely — not a copy of the TOP block. Fights primacy decay over a ~300-line prompt.
- Wrap critical blocks in XML-style tags (`<constraints>…</constraints>`): cross-model-safe, strongest for Claude.

## Per-phase constraint table (single source of truth)

Drives both the TOP and END blocks. One table, two render sites.

| Phase | Role | Writes allowed | END re-anchor (the one rule) |
|---|---|---|---|
| brainstorm (debug) | diagnostician / conversation partner | `.md` in task dir; repro/test scripts OK | "Read-only. NEVER touch project code. Record fixes in RESEARCH.md. End via pp_phase_complete." |
| brainstorm (other) | conversation partner | `.md` in task dir only | "Read-only. NEVER write/modify project code. Only .md artifacts." |
| plan | synthesizer | synthesized plan file only | "You SYNTHESIZE only. NEVER write code or author a plan from scratch." |
| implement | implementer | full write access | (no read-only rule) "Stay within the plan's scope." |
| review | adversarial reviewer | review files only | "You REVIEW only. NEVER fix code yourself. Report findings." |

Per-phase "writes allowed" captures the debug nuance: brainstorm/debug may write repro scripts but never the actual fix — not a blanket read-only.

## Nudge / continuation system (Channel B)

State machine on `turn_end`. Two stall types, two responses, plus a scope-guard rider.

```
turn_end
 ├─ EMPTY turn (no text/tool/result)
 │    ├─ subagents running? → return
 │    └─ else → EMPTY-TURN NUDGE (rate-limited; MAY escalate to halt = runaway guard)
 └─ TEXT, ended in prose (no terminal tool call)
      ├─ step == await_* or brainstorm-conversation? → return (legit wait)
      └─ else → TEXT-STOP NUDGE (rate-limited; NEVER halts)

then: append SCOPE-GUARD rider if phase ∈ {brainstorm, plan, review}.
```

Nudge message contract (both types):
```
[PI-PI] <what happened>.
DO NOT apologize or acknowledge this in prose.
You are in <mode> mode. Waiting for the user is PROHIBITED.
→ If the phase is done: call pp_phase_complete NOW.
→ If not: continue immediately with a tool call.
<scope-guard rider — read-only phases only>
```

Rationale:
- **Empty-turn** = possible runaway → keep escalation-to-`nudgeHalted` safety valve.
- **Text-stop** = the verified failure → rate-limited re-nudge, NEVER halts (a chatty agent must never be permanently stranded). Add anti-apology line (prevents the "I apologize, I'll continue" → halt loop) and force tool-call exit.

## Phase-entry message (Channel B, at transition)

```
transition → compact → new phase system prompt (Channel A, full constraints)
                     → entry message (Channel B): "[PI-PI] Entered <phase>. Begin working.
                                                    <scope-guard rider if read-only>"
```
Implement keeps the plain "Begin working." Read-only phases get the rider.

## Reviewer / synthesizer prompts (Channel A specials)

- **Reviewer:** line 1 MUST be `VERDICT: <TOKEN>` (parseable; anchors autoregressive generation toward justifying the verdict), then structured findings. TOP block: "You REVIEW only. NEVER fix code. NEVER flag pure style." (fixes verdict-parse fragility + over-flagging).
- **Synthesizer (plan):** TOP block: "You are a MERGER, not an author. Locked predicates: <decisions already made>. On contradiction: FLAG it; do not invent a compromise."

## Coverage of the attention curve

```
SYSTEM PROMPT            │  COMPACTED SUMMARY + recent messages
┌────────┐               │                         ┌──────────┐
│TOP CRIT │   middle      │   …conversation…        │ latest    │
│+ END    │  (degrades)   │                         │ nudge /   │
│re-anchor│               │                         │ entry msg │
└────────┘               │                         └──────────┘
 ▲ PRIMACY (Channel A)                                ▲ RECENCY (Channel B)
```
Both high-attention ends carry the constraint, each via the channel suited to it. Middle holds only reference material.

## Implementation map

| Component | File | Change |
|---|---|---|
| TOP + END blocks (role/priority/positive-alt/named loopholes) | `extensions/orchestrator/phases/brainstorm.ts`, `planning.ts`, review/implement prompts | rewrite constraint blocks to the skeleton |
| Per-phase constraint table | inline or tiny helper | single source for TOP/END text |
| Forcing nudge + anti-apology + scope rider | `extensions/orchestrator/event-handlers.ts` (`turn_end`) | enhance existing empty-turn / text-stop nudges |
| Phase-entry rider | `extensions/orchestrator/orchestrator.ts` (entry message) | append rider for read-only phases |
| First-line VERDICT | `extensions/orchestrator/agents/*-reviewer.ts` | move VERDICT token to line 1 |

Out of scope (decided): tool_call gating, per-phase tool lists, conversation-level constraint re-injection after compaction (Layer 3 — redundant given the compaction-proof system prompt), full prompt repetition for the main agent, theatrical personas.

---

## Research notes (Gemini Deep Research, 2024–2026) — what we adopted vs. rejected

Adopted (well-grounded, or matches verified observations):
- **R1. Lost-in-the-middle is current** (U-shape, primacy+recency). ACL/arXiv sources. → justifies TOP + END placement.
- **R2. Pair prohibitions with positive alternatives** — isolated negatives cause over-refusal/freezing. → "MUST NOT X / INSTEAD MUST Y" everywhere.
- **R4. Priority/identity statement** — "these rules override your own impulses and inferred next steps" — targets self-initiated drift specifically. Matches omp/claudecode practice.
- **R5. Forcing nudge, forbid prose apologies, end-turn-via-tool-call** — matches the verified 14-text-stops failure. Highest-confidence item.
- **R6. First-line VERDICT token** — anchors decisiveness, guarantees parseability.

Rejected or down-weighted:
- **R3. "Prompt repetition +76%"** — real (Google study) but scoped to non-reasoning extraction sub-agents; explicitly redundant/wasteful for reasoning models with CoT. We do NOT repeat full prompt blocks for the main agent.
- **R8. "Domain Invocation" (pretend to be Avionics Auditor / ISO reviewer)** — single non-peer-reviewed source, gimmicky. We adopt real role framing ("planner, not implementer"), not theatrical personas.
- **R7. "Governance Decay → re-inject constraints post-compaction"** — the research's headline finding, but it assumes constraints live in the conversation. Ours live in the system prompt, which pi never compacts (verified). Mostly redundant for our architecture → dropped (Layer 3).
- Specific decay statistics (e.g. "0→59% violations", "1,323 episodes") and forward-looking per-model claims (e.g. "Gemini finds repeated constraints distracting", "GPT deprecates CoT") — trust the mechanisms, not the unverifiable numbers; treat per-model specifics as directional only since we run several models interchangeably.

Cross-model delimiter guidance (directional): Anthropic → XML tags; OpenAI → Markdown + JSON schema for tool output; Google → consistent protocol-style, avoid mixing. Robust common baseline: XML for macro-structure + Markdown inside, applied consistently.
