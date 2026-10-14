# Finding when and why something changed

Each command below was run against git 2.54. Pick by the question you are answering.

## When did this string or pattern appear or disappear?

```
git log -S '<exact string>' --oneline              # commits that changed how many times it occurs
git log -G '<regex>' --oneline                     # commits whose diff touches a matching line
git log -S '<string>' --oneline --all              # include branches you are not on
```

`-S` lists both the commit that added the string and the one that removed it, so read both before concluding. `-G` also catches lines that changed without the count changing, such as an edited argument list.

## Who wrote this line, looking past moves and reformatting?

```
git blame -w -C -C <file>                          # ignore whitespace, follow lines moved or copied from other files
git blame -w -C -C -L 40,60 <file>                 # a range only
git log --follow -p -- <file>                      # the file's history across renames
```

Plain `blame` credits whoever last reformatted or moved a line, which is usually the wrong commit to read.

## How did this one function evolve?

```
git log -L ':<function name>:<file>' --oneline     # every commit that changed that function, with its diff
git log -L 40,60:<file>                            # a line range, when the language has no function regex git understands
```

## Which commit broke it?

Write a script that exits 0 when the behaviour is good and non-zero when it is bad. Exit 125 means "cannot test this commit, skip it". Keep it outside the repository, so that checking out old commits cannot change it. Then bisect in a throwaway worktree, so that the user's uncommitted work is never touched:

```
git worktree add --detach /tmp/bisect <bad>
cd /tmp/bisect
git bisect start <bad> <good>
git bisect run /tmp/check.sh
git bisect reset
cd - && git worktree remove /tmp/bisect
```

- Prove the script first: run it on the known-good and known-bad commits by hand, and confirm it returns 0 and non-zero. A script that fails on both makes bisect blame the first commit it tries.
- Make the check fast and deterministic. For a flaky failure, loop the check inside the script until the failure rate is clear.
- A dependency upgrade counts too: bisect across the lockfile history, or across the dependency's own versions, the same way.
- Never bisect in the user's working tree: it checks out old commits over whatever is there.

## Why was it changed?

The commit message is the first answer, but rarely the whole one.

```
git show <commit>                                  # the full message and diff
git log --format='%H %s' --grep='<issue id or keyword>'
gh pr list --search '<commit sha>' --state merged  # the PR that brought it in, and its discussion
gh api repos/<owner>/<repo>/commits/<sha>/pulls --jq '.[].html_url'
```

The PR discussion and the linked issue usually hold the reason the message left out. Quote it rather than paraphrasing it.
