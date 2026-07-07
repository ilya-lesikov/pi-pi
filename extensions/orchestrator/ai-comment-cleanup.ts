export const AI_COMMENT_TOKEN = "AI_COMMENT:";

// Remove reviewer→user `AI_COMMENT:` markers from a single file's content.
// - A line whose comment content is ONLY an AI_COMMENT marker is dropped entirely
//   (covers `// AI_COMMENT: ...`, `#`, `--`, `;`, `<!-- ... -->`, `/* ... */`).
// - A code line with a trailing `<comment-open> AI_COMMENT: ...` is stripped back
//   to the code, dropping the trailing marker only.
// Anything else containing the token is left untouched (do not corrupt prose).
// True when `prefix` ends inside an unclosed string literal (single, double, or
// backtick quote). Used to avoid stripping a `// AI_COMMENT:` that lives inside a
// string rather than being a real trailing comment. Escaped quotes are honored.
function insideStringLiteral(prefix: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    }
  }
  return quote !== null;
}

export function stripAiCommentsFromContent(content: string): { content: string; removed: number } {
  if (!content.includes(AI_COMMENT_TOKEN)) return { content, removed: 0 };
  const lines = content.split("\n");
  const out: string[] = [];
  let removed = 0;

  const fullLineComment = /^\s*(?:\/\/+|#+|--|;+|\/\*|<!--)\s*AI_COMMENT:.*?(?:\*\/|-->)?\s*$/;
  const trailingComment = /(\s*(?:\/\/+|#+|--|;+|\/\*|<!--)\s*AI_COMMENT:.*?(?:\*\/|-->)?)\s*$/;

  for (const line of lines) {
    if (!line.includes(AI_COMMENT_TOKEN)) {
      out.push(line);
      continue;
    }
    if (fullLineComment.test(line)) {
      removed += 1;
      continue;
    }
    const match = trailingComment.exec(line);
    // Only strip a trailing marker when the code BEFORE the comment opener has
    // balanced quotes — otherwise the "// AI_COMMENT:" is inside a string literal
    // (e.g. `const s = "// AI_COMMENT: x"`) and stripping it would corrupt source.
    if (match && !insideStringLiteral(line.slice(0, match.index))) {
      const stripped = line.slice(0, match.index);
      if (stripped.trim().length > 0) {
        out.push(stripped);
        removed += 1;
        continue;
      }
    }
    // Token present but not in a strippable trailing-comment position — leave as-is.
    out.push(line);
  }

  return { content: out.join("\n"), removed };
}

// True when the change from `before` to `after` only inserts and/or removes
// `AI_COMMENT:` markers — i.e. stripping all such markers from both sides yields
// identical text. Used to enforce the review-phase read-only exception at the
// tool-call gate (the agent may touch AI_COMMENT markers and nothing else).
export function isAiCommentOnlyChange(before: string, after: string): boolean {
  if (before === after) return true;
  return stripAiCommentsFromContent(before).content === stripAiCommentsFromContent(after).content;
}
