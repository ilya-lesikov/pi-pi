---
title: "Continuously Improve Claude Code Plans"
description: "Use your denial history to find feedback patterns, generate a personalized report, and automatically improve every future plan."
date: 2026-04-01
author: "backnotprop"
tags: ["compound-planning", "plan-mode", "claude-code"]
---

**Compound Planning.** If you've been actively using plan mode in Claude Code, there's an opportunity to improve how your agents plan for you. Here is a skill that analyzes your plan denial history, surfaces your own feedback patterns, and creates an automated loop that refines planning over time (at your request). The point is to consistently optimize what works best for you.

<video width="100%" style="aspect-ratio: 16/9; border-radius: 8px; margin-bottom: 1.5rem;" autoplay loop muted playsinline controls>
  <source src="https://d17ygohy796f9l.cloudfront.net/videos/compound-planning.mp4" type="video/mp4" />
</video>

If you use plan mode and deny plans, you already have the data. The skill reads it and puts it to work. It works day one for any Claude Code user who has been actively using plan mode. [Plannotator](https://github.com/backnotprop/plannotator) users get an even richer analysis since Plannotator captures full plan text and inline annotations with every denial. Plannotator is [open source](https://github.com/backnotprop/plannotator) and free.

[Install Plannotator](https://github.com/backnotprop/plannotator?tab=readme-ov-file#install-for-claude-code), then run:

```
/plannotator-compound
```

## How it works

When you deny a plan in Claude Code, that interaction gets logged. If you're a Plannotator user, it's even better. The more you use it, the richer your archive gets. Full plan text, inline annotations, structural feedback, all saved as markdown files that build up over time.

Compound Planning reads that archive in three steps:

1. **Analyze** all your plan denials and approvals, surfacing insight patterns
2. **Report** generates a personalized report so you can view your own findings and insights
3. **Hook** creates an improvement hook that gets injected on plan enter mode, carrying forward the insights from the last time you ran the skill

The report is personalized. Every quote is pulled from your actual feedback. Every percentage is calculated from your real data. The corrective instructions at the end trace directly back to your most frequent denial reasons.

<video width="100%" style="aspect-ratio: 16/9; border-radius: 8px; margin-bottom: 1.5rem;" autoplay loop muted playsinline controls>
  <source src="https://d17ygohy796f9l.cloudfront.net/videos/compound-planning-report.mp4" type="video/mp4" />
</video>

## Works for all Claude Code users

Plannotator users get the richest analysis since the archive contains full plan text and inline annotations. But you don't need Plannotator.

If you use Claude Code with plan mode, your denial reasons live in `~/.claude/projects/`. The skill includes a Python parser that extracts your `ExitPlanMode` outcomes, filters out boilerplate, and produces clean records of your human-authored feedback. The same analysis pipeline runs on this data and produces the same report.

## The feedback loop

The real value is the improvement hook. The corrective instructions from your report can be saved to a file that gets injected into every future planning session automatically. Claude sees your feedback patterns before writing any plan.

Your denied plans aren't wasted work. They're the specification for better plans going forward.

## Try it

If you have [Plannotator](https://github.com/backnotprop/plannotator) installed, it works out of the box. If you're using Claude Code without Plannotator, the skill works with your existing session logs, no additional setup.

The more denial history you have, the richer the analysis. Start with the [installation guide](/docs/getting-started/installation/) or check out the [repo](https://github.com/backnotprop/plannotator).
