# Proving a skill works

A skill that reads well is not a skill that works. Three things have to be shown: it fires when it should, it stays quiet when it should not, and it improves the result. Every command here was run against this harness before being written down.

## Run it in the environment it will live in

`pi -p` runs a full non-interactive session, with the same extensions, skills and prompt a real one gets:

```
pi -p --thinking off --mode json "<prompt>"
```

Test with the real environment — every extension, every other skill. A skill proven with `--no-skills --no-extensions` proves nothing about whether it triggers in practice, because triggering is a competition: the model picks among all the descriptions in front of it, and yours has to win against them.

To test a skill that is not installed yet, put it where the loader looks rather than reaching for `--skill`. That flag is upstream pi's; pi-pi builds its catalog only from the project, global and bundled skill directories, so a `--skill` path never enters the catalog and can never be loaded. Copy the folder into a scratch project instead:

```
mkdir -p /tmp/scratch/.pi/skills && cp -r <skill-dir> /tmp/scratch/.pi/skills/ && cd /tmp/scratch
```

A project directory also keeps the candidate out of every other session while you test it.

`--provider`/`--model` pin the run — pin them, because a nested `pi` can hit a billing limit the parent does not and the failure looks exactly like the skill not firing. `--no-session` keeps the run out of session history.

## Did it fire?

Parse the event stream for the `load_skill` call. Text output does not show tool calls, so a skill can fire invisibly and look like a failure:

```
pi -p --thinking off --mode json "<prompt>" | python3 -c "
import json,sys
loaded, failed, sawEnd = [], [], False
for line in sys.stdin:
    try: e=json.loads(line)
    except: continue
    if e.get('type')!='message_end': continue
    m=e['message']; sawEnd=True
    if m.get('stopReason')=='error': failed.append(m.get('errorMessage') or 'error')
    for c in m.get('content',[]) if isinstance(m.get('content'),list) else []:
        if c.get('type')=='toolCall' and c.get('name')=='load_skill':
            loaded.append((c.get('arguments') or {}).get('name'))
if failed or not sawEnd: print('INVALID RUN:', failed or 'no output')
else: print('loaded:', loaded or ['NONE'])"
```

Separate an **invalid run** from a real negative. A session that errored — billing, network, a bad flag — produces no `load_skill` call and is indistinguishable from a skill that declined to fire unless you check. Only a run that completed is evidence about the description.

Add `do not actually do the work, just state your plan` to the prompt. The trigger is the measurement; letting the run proceed costs minutes and tests nothing extra.

## The matrix

Write the prompts before the skill, and use the user's vocabulary, not the skill's own words — a description tested against its own phrasing always passes.

- **Positives**, one per occasion the description claims. Each must load the skill.
- **Negatives**, and make them adversarial: a prompt containing the trigger words in a different sense, and a prompt from the neighbouring task the skill must not capture. These catch a description written so pushy it fires on everything, which is as broken as one that never fires.

Both halves are required. A skill that always loads has a useless trigger, not a strong one.

## When a positive fails

The description is wrong, not the model. Models under-trigger: they skip a skill whose description does not visibly match the words in front of them. Widen it with the phrasings a user would actually type, and state the occasions explicitly rather than abstractly. Retest — do not reason about whether the new wording is better.

## Does it change the output?

Triggering proves the skill loads. It does not prove the skill helps.

Run the same task twice, once with the skill and once without, on a prompt drawn from real work rather than the skill's examples. Then have a reviewer subagent compare the two outputs **without being told which is which**, and say which is better and why. Prefer a reviewer from a different model family than the one that wrote the skill.

This half actually executes the task, on instructions someone else wrote. Run it in a disposable copy, never the user's working tree, and reset to the same starting state between the two runs — otherwise the first run changes what the second one meets, and the comparison measures the order rather than the skill.

If the reviewer cannot tell them apart, the skill is not earning its place in the catalog — every description is paid for in every session whether it loads or not.

For a skill whose body must demonstrably be read, put a distinctive phrase in it and assert the phrase appears. A correct answer alone proves nothing: the model may already know it.

## Judgement the author cannot supply

Delegate what you cannot see about your own draft:

- A **reviewer** reads it cold, the way the model will, and finds what only makes sense if you already know what you meant.
- An **advisor** argues the design: whether the split is right, whether a section earns its length, whether the trigger is honest.

Both beat re-reading your own text, and cross-family beats same-family — a sibling model shares your blind spots.
