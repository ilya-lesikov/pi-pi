// Fetches contributors, issue authors, and discussion participants from GitHub.
// Caches the result in-process so it only fetches once per build / dev session.

type Person = { login: string; avatarUrl: string; url: string };

let cached: Person[] | null = null;

export async function getContributors(): Promise<Person[]> {
  if (cached) return cached;

  const people = new Map<string, Person>();
  const token = import.meta.env.GITHUB_TOKEN || process.env.GITHUB_TOKEN;

  try {
    if (token) {
      const query = `{
        repository(owner: "backnotprop", name: "plannotator") {
          contributors: defaultBranchRef {
            target {
              ... on Commit {
                history(first: 100) {
                  nodes { author { user { login avatarUrl url } } }
                }
              }
            }
          }
          issues(first: 100, orderBy: { field: CREATED_AT, direction: DESC }) {
            nodes { author { login avatarUrl url } }
          }
          discussions(first: 100, orderBy: { field: CREATED_AT, direction: DESC }) {
            nodes { author { login avatarUrl url } }
          }
        }
      }`;
      const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { 'Authorization': `bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      if (res.ok) {
        const json = await res.json();
        const repo = json.data?.repository;
        for (const node of repo?.contributors?.target?.history?.nodes || []) {
          const u = node?.author?.user;
          if (u?.login) people.set(u.login, u);
        }
        for (const node of repo?.issues?.nodes || []) {
          const u = node?.author;
          if (u?.login) people.set(u.login, u);
        }
        for (const node of repo?.discussions?.nodes || []) {
          const u = node?.author;
          if (u?.login) people.set(u.login, u);
        }
      }
    } else {
      const res = await fetch('https://api.github.com/repos/backnotprop/plannotator/contributors?per_page=50', {
        headers: { 'Accept': 'application/vnd.github.v3+json' },
      });
      if (res.ok) {
        const data = await res.json();
        for (const c of data) {
          if (c.type === 'User') {
            people.set(c.login, { login: c.login, avatarUrl: c.avatar_url, url: c.html_url });
          }
        }
      }
    }
  } catch {}

  cached = [...people.values()];
  return cached;
}
