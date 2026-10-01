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

No description, no body, no stars, no dates. **This is the whole record.** Any ranking built on this endpoint alone is a popularity ranking wearing a rubric. Use it to enumerate candidates, never to judge them.

Stars and commit dates are real signals, but they come from the repository (see Maintenance signals below), not from this index.

`https://skills.sh/api/skill/<id>` answers 401, so that route gives no detail either. Treat the body as something only the repository can supply.

## Resolving an id to a file

The id does not encode the path. `mattpocock/skills/code-review` lives at `skills/engineering/code-review/SKILL.md`. Walk the tree:

```
branch=$(gh api "repos/<owner>/<repo>" --jq '.default_branch')
gh api "repos/<owner>/<repo>/git/trees/$branch?recursive=1" --jq '.tree[].path | select(endswith("SKILL.md"))'
```

Ask for the default branch rather than guessing `main` or `master` — a guess that misses returns a 404 that reads like "no such skill". One tree call returns every skill in the repository, so a repo publishing dozens costs a single request. Check `.truncated` on a very large repository.

Then fetch the body, asking for it raw:

```
gh api "repos/<owner>/<repo>/contents/<path>" -H "Accept: application/vnd.github.raw"
```

The raw header avoids the base64 round-trip, whose decoder differs between GNU and BSD.

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

pi-pi loads `<name>.md` and `<dir>/SKILL.md` from `~/.pi/skills` (global) and `<project>/.pi/skills` (project), so an ecosystem skill folder is copied in as-is — `SKILL.md` with any `scripts/` and `references/` beside it. Project shadows global shadows bundled, by skill name.

The layout ports; the frontmatter does not all port. pi-pi's loader reads `name` and `description` and nothing else, so a key the author relied on is dropped in silence:

- `disable-model-invocation: true` means "load only when asked". Upstream pi honours it; pi-pi does not, so such a skill becomes model-invocable here and will fire on its description alone. Check for it, and say so — a skill deliberately built to stay quiet behaves differently under pi-pi than its author intended.
- Any other non-standard key is inert rather than honoured. Judge a candidate on what pi-pi will actually do with it, not on what its frontmatter asks for.

A skill body that instructs the agent to read its own `references/` can rely on the `dir` attribute of the `<skill>` tag `load_skill` returns: it holds the absolute directory the skill was loaded from. A skill written for another host may instead name bare relative paths, which resolve against the working directory and will not be found — when adapting one, anchor those paths on `dir`.

`npx skills add <source>` is the ecosystem's own installer. It targets other agents' directories by default, so prefer copying the folder when installing for pi-pi, and read what it ships before running it either way.
