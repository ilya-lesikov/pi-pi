# Where to look, and how to get from a hit to a body

Every command here was run against the live service. Where a route is weaker than it appears, that is stated — the weakness is the reason the reading step exists.

## The install index

`skills.sh` carries the ecosystem's install counts and a semantic search. It needs no CLI and no account:

```
curl -sS -H "accept: application/json" "https://skills.sh/api/search?q=code+review"
```

A hit looks like this, in full:

```json
{"id":"mattpocock/skills/code-review","skillId":"code-review","name":"code-review","installs":603655,"source":"mattpocock/skills"}
```

No description, no body, no stars, no dates. **This is the whole record.** Any ranking built on this endpoint alone is a popularity ranking wearing a rubric, which is what the existing skill-finders are. Use it to enumerate candidates, never to judge them.

`https://skills.sh/api/skill/<id>` answers 401. There is no public detail endpoint; the body has to come from the repository.

## Resolving an id to a file

The id does not encode the path. `mattpocock/skills/code-review` lives at `skills/engineering/code-review/SKILL.md`. Walk the tree:

```
gh api "repos/<owner>/<repo>/git/trees/main?recursive=1" --jq '.tree[].path | select(endswith("SKILL.md"))'
```

Try `master` when `main` 404s. One call returns every skill in the repository, so a repo that publishes dozens costs a single request.

Then fetch the body:

```
gh api "repos/<owner>/<repo>/contents/<path>" --jq '.content' | base64 -d
```

Use `gh`, not plain `curl`, against the GitHub API. Unauthenticated requests are rate-limited to 60/hour and will fail partway through a scouting run; `gh` is authenticated and allows 5000. Check with `gh api rate_limit --jq '.resources.core.remaining'`.

Do not guess `raw.githubusercontent.com` URLs. The branch and the in-repo layout both vary, and a guessed path returns a 404 that is easy to misread as "no such skill".

## Searching GitHub directly

Reaches skills that no index has picked up, including ones inside product repositories:

```
gh api "search/code?q=filename:SKILL.md+<term>&per_page=20" --jq '.items[] | "\(.repository.full_name)  \(.path)"'
```

Code search matches file contents as well as names, so the result count is large and unranked by quality — treat it as a candidate pool, not an ordering. For collections rather than individual skills:

```
gh api "search/repositories?q=agent+skills+SKILL.md&per_page=20" --jq '.items[] | "\(.stargazers_count)\t\(.full_name)\t\(.pushed_at[0:10])"'
```

## Curated lists

Hand-maintained, so they carry editorial judgement the indexes lack, and they surface official vendor skills that rank poorly on installs. They also go stale — verify anything they claim.

- `anthropics/skills` — the official set, and the reference for what the format's authors consider good
- `VoltAgent/awesome-agent-skills`, `heilcheng/awesome-agent-skills` — curated, explicitly anti-bulk-generated
- `ComposioHQ/awesome-claude-skills`, `travisvn/awesome-claude-skills` — broader, more mixed

A name appearing on several independent lists is a real signal. A name appearing on one list with no repository activity is not.

## Maintenance signals

```
gh api "repos/<owner>/<repo>" --jq '"\(.stargazers_count) stars, \(.open_issues_count) open, pushed \(.pushed_at[0:10])"'
```

Scope activity to the skill's own directory when a repository holds many skills — a busy monorepo says nothing about the one file being judged:

```
gh api "repos/<owner>/<repo>/commits?path=<path>&per_page=1" --jq '.[0].commit.committer.date'
```

## Installing

pi-pi loads `<name>.md` and `<dir>/SKILL.md` from `~/.pi/skills` (global) and `<project>/.pi/skills` (project), so an ecosystem skill folder works unmodified — copy the directory in, keeping `SKILL.md` and any `scripts/` and `references/` beside it. Project shadows global shadows bundled, by skill name.

`npx skills add <source>` is the ecosystem's own installer. It targets other agents' directories by default, so prefer copying the folder when installing for pi-pi, and read what it ships before running it either way.
