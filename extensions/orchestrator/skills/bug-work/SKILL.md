---
name: bug-work
description: Load BEFORE fixing or diagnosing something that behaves wrongly — a crash, an error, wrong output, a regression, a flaky test, red CI, a hang, a leak, something that got slow, "it stopped working after", "figure out why", "investigate this issue but don't fix", "падает", "не работает", "сломалось", "ошибка", "почему". Covers reproducing it first, checking whether upstream already hit and fixed it, competing hypotheses, root cause over symptom, regression tests, performance measurement, and review before reporting.
---

**Most bugs in a project's own code are someone else's closed issue.** A crash inside a dependency, an error that started after an upgrade, or a behaviour that differs between versions has usually been reported, diagnosed and fixed upstream, often with the root cause written out in the thread. Look there early, alongside the local investigation rather than after it.

Load `code-rules` before the first edit and `git-work` before the first commit. This skill's `<skill>` tag carries a `dir` attribute; `references/techniques.md` is inside it.

## Settle the stopping point

- "Investigate", "figure out why", "look into", "don't fix yet" about something behaving wrongly mean diagnosis only. The deliverable is the root cause with evidence and the fix you would make. Do not edit code beyond the throwaway instrumentation you remove again. Explaining how something works when nothing is wrong is `investigate`, not this skill.
- Otherwise the deliverable is a fix with a regression test, unless the fix changes behaviour the user would see beyond removing the bug. In that case propose the fix before making it, as the host's phases require.
- When the bug lives on a real machine or cluster rather than in code you can run locally, load `ops-work` as well, and let its gates govern every probe there: read-only diagnosis first, and stress or reproduction only on a target the user has agreed is disposable.

## Reproduce before you theorise

- Get a fast, deterministic signal of pass or fail before forming any hypothesis: a failing test, a script, or a command and its output. A two-second loop that fails every time is worth more than an hour of reading code.
- Use the reporter's exact inputs, versions and environment first. Shrink the reproduction afterwards, never before it has failed once.
- When it will not reproduce, the difference between your environment and the reporter's is the first lead: versions, configuration, data, concurrency, operating system. Say what you tried. "Cannot reproduce" with no list is not a finding.
- For an intermittent failure, raise the failure rate rather than waiting for luck: run it in a loop, in parallel, under load, with timing perturbed. Measure the rate before and after the fix. One green run of a flaky test proves nothing.
- For red CI, start from the failed job's log (`gh run view <run-id> --log-failed`, or on GitLab `glab ci get` and the job trace through `glab api`, as in `references/techniques.md`), and reproduce the failing step locally with CI's own command and environment. Compare the failing run against the last green one on the same branch: the diff between them, the runner image, and the dependency versions resolved.

## Check whether the world already hit it

This applies whenever a dependency, the language runtime, the operating system or an upgrade is anywhere in the picture: in the stack trace, in the error text, or in "it started after". Do it in parallel with the local work: spawn one `librarian` as soon as you have the exact error and the versions involved. `references/techniques.md` has the commands to paste into its prompt. A bug wholly inside this repo's own logic skips this section. Say so in one line.

- Search the issue trackers of the dependencies in the stack trace, with the exact error message and the key frame, open and closed.
- Read the dependency's changelog and the commits between the version you run and the latest. A fix released two versions later settles the question: upgrade, or backport its understanding.
- When it started after an upgrade, the range between the old and new versions of whatever changed is the search space. Bisect that range rather than reading it.
- Read the upstream fix commit and its test even if you will not upgrade. It names the root cause and the case that triggers it.

## Find the root cause, not the place it surfaced

- Write down two or three competing hypotheses before testing any of them. Design each experiment to tell them apart, not to confirm your favourite.
- Trace the bad value backwards to the first point where it is wrong. The line that throws is where the symptom surfaced, not where the bug lives.
- Add instrumentation at the boundaries between components rather than guessing which side is wrong, and remove it before you commit.
- When it started at a known point, bisect it, in a throwaway worktree so the user's uncommitted work is never touched (`git-work`'s `references/history.md` has the procedure). `git bisect run` with the reproduction script settles in minutes what reading takes hours to guess at.
- When a fix attempt fails, the hypothesis behind it was wrong. Do not tune the same fix. Once a real fix attempt has failed, spawn an eligible `deep-debugger`, preferring another vendor, with the reproduction, the evidence and the failed attempt. For a failure that spans subsystems, a second one may run in parallel only if it cannot collide with the first: deep-debuggers may write instrumentation, and every subagent runs in your working tree. Give each a separate scratch copy of the repository and tell it to work only there, or run them one after the other. A `git worktree add /tmp/dbg-<n>` starts at `HEAD` and does not see uncommitted work, so commit the reproduction first or copy the tree instead. Weigh their disagreement rather than averaging it.
- A fix that suppresses the error (a catch, a retry, a null check, a longer timeout) is a symptom fix unless you can say why the error was legitimate. Say so explicitly when that is the honest answer.

## Fix it

- Write the regression test first, from the reproduction, and watch it fail for the reason you diagnosed. If it passes before the fix, it does not test the bug.
- When no automated test is feasible (a race you can only provoke under load, a production-only configuration, a machine), keep the reproduction script or command as the evidence, and say in the report why there is no test.
- Make the smallest change that removes the cause. Check the other callers of what you changed, and search for the same pattern elsewhere: a bug that happened once in this codebase often happened twice.
- Run the reproduction again, then the suite.

## Slow, hungry or leaking

- A performance problem is a bug whose reproduction is a measurement. Pin the workload, measure the baseline several times, and report the variance as well as the mean.
- Profile before you optimise. The profile names the hot path. Do not guess it from reading code.
- Change one thing at a time, measure after each change, and keep the numbers. Report before and after, with the same workload and the same machine.
- Check that the result is still correct after every optimisation. A faster wrong answer is a regression.

## Review before reporting

- One-line fixes are not exempt. "The fix is obvious and the test passes" is the judgement the review exists to test, and a fix that changes what a setting means is a behaviour change however small the diff is.
- Load `review` and run it on your own diff (the outgoing direction). The premise you hand the reviewers is your root-cause diagnosis and the evidence for it: the reproduction, the bisect result, the upstream issue. That is what they should attack first.
- For a diagnosis-only request there is no diff. When the diagnosis is not settled by direct evidence (a bisect result, a reproduction that flips with the cause), have an eligible reviewer, preferring another vendor, attack the written diagnosis and its evidence before you report it. If none is from another vendor, say the check was not independent.
- Fix what holds up, and re-run the reproduction and the suite.

## Report

- The root cause in one or two sentences, and the evidence that proves it: the reproduction, the bisect result, the upstream issue or fix commit (linked and pinned).
- What you changed and why that removes the cause. The regression test, and that it failed before the fix.
- Anything you suspect but could not prove, and what would settle it.
