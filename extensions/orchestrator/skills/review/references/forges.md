# Fetching a change from a forge, and posting the review back

Every command here was run against live services — GitHub and a self-hosted GitLab — including the posting paths, which were exercised with drafts and then deleted. Where a route does not work, that is stated with its failure.

The two CLIs do not take the same flags, and the mismatch is the first thing that bites. `glab api` takes `--hostname` and has no `--jq`; pipe it to `jq` instead. Every other `glab` subcommand rejects `--hostname` outright (`Unknown flag`) and selects the host through `--repo` with a full URL.

## Access

- GitHub needs `gh` authenticated with `repo` scope; that scope covers submitting reviews. Check with `gh auth status`.
- GitLab needs `glab`. Confirm it is on `PATH` before composing a command — when it is installed through a version manager the shims directory is often absent from a non-interactive shell's `PATH`, and the failure reads as the tool not existing.
- `glab` authenticates from `GITLAB_TOKEN` or its own config. Where the token lives in a file the shell does not read by default, source it into the environment (`set -a; source <file>; set +a`) and never echo it. Every self-hosted call needs the host named explicitly; without it `glab` talks to `gitlab.com`, where that token is unauthorised.
- A fine-grained GitLab token reports scope problems as `403 insufficient_granular_scope` naming the permission it wants. That is a token problem, not a wiring problem — read the message rather than re-authenticating.

## Locate the change

```
gh pr list --repo <owner>/<repo> --state open
gh pr view <n|url> --repo <owner>/<repo> --json title,body,state,headRefName,baseRefName,author,statusCheckRollup
gh search prs --review-requested=@me --state=open
```

```
glab mr list --repo https://<gitlab host>/<group>/<project>
glab mr view <iid> --repo https://<gitlab host>/<group>/<project>
glab api "merge_requests?scope=assigned_to_me&state=opened" --hostname <gitlab host>
```

`glab api` takes a project by numeric id or URL-encoded path — `projects/<id>/...` or `projects/<group>%2F<project>/...`. The numeric id is in `glab mr view`'s JSON and is the stabler of the two.

## Fetch what you need to judge it

GitHub — the diff, the per-file patches, CI, and the discussion that already happened:

```
gh pr diff <n> --repo <owner>/<repo>
gh api "repos/<owner>/<repo>/pulls/<n>/files" --paginate --jq '.[] | "\(.filename)\t\(.status)\t+\(.additions)-\(.deletions)"'
gh pr checks <n> --repo <owner>/<repo>
gh api "repos/<owner>/<repo>/pulls/<n>/reviews" --paginate   # past review summaries and verdicts
gh api "repos/<owner>/<repo>/pulls/<n>/comments" --paginate  # inline review comments
gh api "repos/<owner>/<repo>/issues/<n>/comments" --paginate  # conversation comments
```

All three comment routes are distinct and none contains the others: a constraint the author agreed to in a review summary is invisible to the inline and conversation endpoints. Paginate every one of them — the default page is 30, and a long-running PR silently truncates to its oldest third.

GitLab:

```
glab mr diff <iid> --repo https://<gitlab host>/<group>/<project>
glab api "projects/<id>/merge_requests/<iid>/diffs" --hostname <gitlab host>
glab api --paginate "projects/<id>/merge_requests/<iid>/discussions" --hostname <gitlab host>
glab api --paginate "projects/<id>/merge_requests/<iid>/notes" --hostname <gitlab host>
glab api "projects/<id>/merge_requests/<iid>/pipelines" --hostname <gitlab host>
```

Prefer `discussions` over `notes`: it carries the thread grouping and the resolution state, so you can tell a settled objection from a live one. `notes` flattens both away.

Prefer checking out the branch and reviewing locally (`gh pr checkout`, `glab mr checkout`) whenever you need the language server: `lsp diagnostics` and `findReferences` need the real tree, and a diff alone cannot tell you who calls what.

## Post to GitHub

`gh pr review` posts a body-only review and cannot carry inline comments. For anchored findings, create the review through the API with its comments in one call.

Omitting `event` creates the review in `PENDING` state — visible only to you, no notification — which is what you want before approval:

```
cat > /tmp/review.json <<'EOF'
{"commit_id":"<head sha>","body":"<summary>","comments":[
  {"path":"src/thing.ts","line":42,"side":"RIGHT","body":"<finding>"}
]}
EOF
gh api "repos/<owner>/<repo>/pulls/<n>/reviews" --input /tmp/review.json --jq '.id, .state'
```

- `line` is the line number in the file at `commit_id`, and `side` is `RIGHT` for the post-change file, `LEFT` for the pre-change one. A multi-line finding takes `start_line` with `line` as its end.
- An anchor outside the diff's hunks is rejected. When a finding sits in untouched code, anchor it to the nearest changed line and say where it really lives.

Then either discard or submit:

```
gh api -X DELETE "repos/<owner>/<repo>/pulls/<n>/reviews/<review id>"
gh api -X POST "repos/<owner>/<repo>/pulls/<n>/reviews/<review id>/events" -f event=COMMENT
```

`event` is `COMMENT`, `APPROVE`, or `REQUEST_CHANGES`. Deleting works only while the review is `PENDING`; once submitted it can be dismissed but never removed.

Replying inside an existing thread goes to the thread, not the conversation:

```
gh api -X POST "repos/<owner>/<repo>/pulls/<n>/comments/<comment id>/replies" -f body="<reply>"
```

This one has no draft state — the reply is public the instant the call returns. It needs the same approval as a submit, not the laxness its small size suggests.

## Post to GitLab

Draft notes are the equivalent of a pending review: author-only until published.

The three SHAs come from the MR's `diff_refs` — fetch them rather than inventing them:

```
glab api "projects/<id>/merge_requests/<iid>" --hostname <gitlab host> | jq '.diff_refs'
```

```
cat > /tmp/draft.json <<'EOF'
{"note":"<finding>","position":{"position_type":"text",
 "base_sha":"<base>","start_sha":"<start>","head_sha":"<head>",
 "old_path":"src/thing.sh","new_path":"src/thing.sh","new_line":4}}
EOF
glab api -X POST "projects/<id>/merge_requests/<iid>/draft_notes" \
  --hostname <gitlab host> -H "Content-Type: application/json" --input /tmp/draft.json
```

- **`-H "Content-Type: application/json"` is mandatory.** `glab api --input` does not set it, and GitLab answers `415 The provided content-type '' is not supported` — which reads like a malformed body and is not.
- `new_line` for an added or context line, `old_line` for a removed one, both for an unchanged line. `old_path` is required even when the file was not renamed.
- Omit `position` entirely for a discussion note that is not anchored to a line.

Then discard or publish:

```
glab api "projects/<id>/merge_requests/<iid>/draft_notes" --hostname <gitlab host>
glab api -X DELETE "projects/<id>/merge_requests/<iid>/draft_notes/<draft id>" --hostname <gitlab host>
glab api -X PUT "projects/<id>/merge_requests/<iid>/draft_notes/<draft id>/publish" --hostname <gitlab host>
```

Keep the id of every draft you create and publish them one by one with that `PUT`. `POST .../draft_notes/bulk_publish` exists and is shorter, but it publishes **every** pending draft of yours on that MR — including ones left from an earlier session that were never shown for approval. Approval of the MR itself is separate from notes: `glab mr approve <iid> --repo https://<gitlab host>/<group>/<project>`.

## The gate

Build the whole review as drafts, show it, and publish only on an explicit yes. Drafts cost nothing to throw away; a published comment notifies everyone watching and cannot be unsent.
