import type { Message } from "@earendil-works/pi-ai";
import type { RenderedEntry } from "./render-entries";
import { textOf, thinkingOf } from "./content";

export interface SearchHit extends RenderedEntry {
  /** Context snippet around the first matched term (only when query provided) */
  snippet?: string;
  /** Number of query terms matched (for ranking) */
  matchCount?: number;
}

const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── British/American spelling variant expansion ──

// Suffix replacement pairs for Commonwealth/US spelling variants.
// When a query term ends with one suffix, the regex is expanded to match
// either variant. This ensures that searching "authorization" finds
// "authorisation" and vice-versa.
//
// CRITICAL: replacements must avoid unbounded quantifiers and nested
// optional groups to prevent regex backtracking (ReDoS). Every optional
// group (e.g. (?:ue)?) is fine because the content is a fixed literal
// followed by an anchor implied by the term boundary. However, open-ended
// quantifiers like + or * must never appear in these replacements.
const SUFFIX_VARIANT_PAIRS: [RegExp, string][] = [
  // -isation ↔ -ization (must come before -ise/-ize)
  [/isation$/i, "i[sz]ation"],
  [/ization$/i, "i[sz]ation"],
  // -yse ↔ -yze
  [/yse$/i, "y[zs]e"],
  [/yze$/i, "y[zs]e"],
  // -our ↔ -or — use possessive-style fixed alternation instead of
  // optional quantifier to avoid backtracking on repeated "or" sequences.
  // ou?r can backtrack on "orororor..." — use (?:our|or) instead which
  // commits after matching one alternative.
  [/our$/i, "(?:our|or)"],
  [/or$/i, "(?:our|or)"],
  // -ise ↔ -ize
  [/ise$/i, "i[zs]e"],
  [/ize$/i, "i[zs]e"],
  // -ogue ↔ -og — (?:ue)? is safe: fixed literal, no repetition
  [/ogue$/i, "og(?:ue)?"],
  // -mme ↔ -m (programme/program)
  [/mme$/i, "m(?:me)?"],
  // -ence ↔ -ense (defence/defense, offence/offence, licence/license)
  [/ence$/i, "en[cs]e"],
  [/ense$/i, "en[cs]e"],
];

/**
 * Expand a literal query term into a regex that matches both British
 * and American spelling variants. Returns the original escaped term
 * if no variant pattern applies.
 *
 * Only applies to simple word terms (no existing regex metacharacters).
 */
const expandSpellingVariants = (term: string): string => {
  // Don't expand terms that already look like regex
  if (/[|*+?{}()[\]\\^$.]/.test(term)) return term;
  // Too short to plausibly be a suffix variant
  if (term.length < 4) return term;

  for (const [suffix, replacement] of SUFFIX_VARIANT_PAIRS) {
    if (suffix.test(term)) {
      const base = term.replace(suffix, "");
      return escapeRegex(base) + replacement;
    }
  }
  return term; // no variant found
};

// ── Regex safety ──

// Maximum length for a compiled regex source. Prevents pathological
// patterns (e.g. deeply nested groups) from consuming compilation time.
const MAX_REGEX_SOURCE_LEN = 256;

/** Try to compile as regex; fall back to escaped literal.
 *  Rejects patterns that are too long or fail to compile. */
const safeRegex = (pattern: string): RegExp => {
  if (pattern.length > MAX_REGEX_SOURCE_LEN) {
    return new RegExp(escapeRegex(pattern.slice(0, 64)), "i");
  }
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(escapeRegex(pattern), "i");
  }
};

/** Detect if the query looks like a single regex pattern (contains regex metacharacters). */
const looksLikeRegex = (query: string): boolean =>
  /[|*+?{}()[\]\\^$.]/.test(query);

// ── Precompiled term cache ──

// Avoids recompiling the same term regex across countMatches, BM25,
// and snippet generation. Keyed by the original term string.
/** Compile all query term regexes once into a cache.
 *  Uses the 'gi' flag so the same compiled regex can be used for both
 *  .test() and termFreq (matchAll). Helpers that use .test() must
 *  reset lastIndex before each call to avoid stale state from the 'g' flag. */
const compileTerms = (terms: string[]): Map<string, RegExp> => {
  const cache = new Map<string, RegExp>();
  for (const t of terms) {
    const expanded = expandSpellingVariants(t);
    const source = expanded.length > MAX_REGEX_SOURCE_LEN
      ? escapeRegex(expanded.slice(0, 64))
      : expanded;
    try {
      cache.set(t, new RegExp(source, "gi"));
    } catch {
      cache.set(t, new RegExp(escapeRegex(t), "gi"));
    }
  }
  return cache;
};

/** Test whether a compiled (global) regex matches the haystack.
 *  Resets lastIndex before testing to avoid stale state from the 'g' flag. */
const reTest = (re: RegExp, hay: string): boolean => {
  re.lastIndex = 0;
  return re.test(hay);
};

/** Build a regex for snippet highlighting — matches first available term
 *  (with spelling variant expansion). Uses atomic-group-safe alternation.
 *  Snippet regex only needs 'i' (not 'g') since it's used for .test()
 *  on individual lines. */
const snippetRegex = (terms: string[], termCache: Map<string, RegExp>): RegExp => {
  const alts = terms.map((t) => {
    const re = termCache.get(t);
    // Use the already-compiled/validated pattern source
    return re ? re.source : escapeRegex(t);
  });
  return new RegExp(alts.join("|"), "i");
};

// ── Stopwords for natural language queries ──
const STOPWORDS = new Set([
  // English
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "of", "in", "to", "for",
  "with", "on", "at", "from", "by", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "out", "off", "over",
  "under", "again", "further", "then", "once", "here", "there", "when",
  "where", "why", "how", "all", "both", "each", "few", "more", "most",
  "other", "some", "such", "no", "nor", "not", "only", "own", "same",
  "so", "than", "too", "very", "just", "about", "it", "its", "that",
  "this", "what", "which", "who", "whom", "these", "those",
]);

/** Remove stopwords, keep meaningful terms. */
const filterStopwords = (terms: string[]): string[] => {
  const meaningful = terms.filter((t) => !STOPWORDS.has(t.toLowerCase()) && t.length > 1);
  // If all terms were stopwords, return original (don't lose everything)
  return meaningful.length > 0 ? meaningful : terms;
};

/** Count how many distinct terms match the haystack. Uses precompiled cache. */
const countMatches = (hay: string, termCache: Map<string, RegExp>): number => {
  let count = 0;
  for (const re of termCache.values()) {
    if (reTest(re, hay)) count++;
  }
  return count;
};

// ── BM25-lite scoring ──
const BM25_K = 1.2;
const BM25_B = 0.75;

// ── Search result caps ──

/** Hard cap on total search results to prevent "half the session" returns. */
const MAX_SEARCH_RESULTS = 50;

/** Minimum BM25 score as a fraction of the top-scoring result.
 *  Entries scoring below this ratio of the best hit are excluded
 *  as low-relevance noise. */
const MIN_SCORE_RATIO = 0.1;

/** For multi-term queries (3+ meaningful terms), require at least this
 *  many terms to match. This prevents common domain vocabulary from
 *  matching almost every entry via OR semantics. */
const MIN_TERM_MATCH_FOR_MULTITERM = 2;

/**
 * Count occurrences of a compiled regex pattern in text.
 * Uses matchAll to avoid recompiling the regex for the global flag.
 */
const termFreq = (text: string, pattern: RegExp): number => {
  let count = 0;
  for (const _ of text.matchAll(pattern)) count++;
  return count;
};

interface BM25Context {
  n: number;         // total docs
  avgDl: number;     // average doc length (words)
  df: Map<string, number>; // term -> number of docs containing it
}

/** Precompute IDF and avgDl across all docs. Uses precompiled term cache. */
const buildBM25Context = (docs: string[], termCache: Map<string, RegExp>): BM25Context => {
  const n = docs.length;
  const df = new Map<string, number>();
  let totalLen = 0;

  for (const doc of docs) {
    totalLen += doc.split(/\s+/).length;
    for (const [t, re] of termCache) {
      if (reTest(re, doc)) {
        df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
  }

  return { n, avgDl: totalLen / Math.max(n, 1), df };
};

/** BM25 score for a single doc against query terms. Uses precompiled cache. */
const bm25Score = (doc: string, termCache: Map<string, RegExp>, ctx: BM25Context): number => {
  const dl = doc.split(/\s+/).length;
  let score = 0;

  for (const [t, re] of termCache) {
    const tf = termFreq(doc, re);
    if (tf === 0) continue;

    const docFreq = ctx.df.get(t) ?? 0;
    // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    const idf = Math.log((ctx.n - docFreq + 0.5) / (docFreq + 0.5) + 1);
    // TF saturation with length normalization
    const tfNorm = (tf * (BM25_K + 1)) / (tf + BM25_K * (1 - BM25_B + BM25_B * dl / ctx.avgDl));
    score += idf * tfNorm;
  }

  return score;
};

/** Line-based snippet: ±contextLines around first regex match. */
const lineSnippet = (text: string, regex: RegExp, contextLines = 2): string | undefined => {
  const lines = text.split("\n");
  let matchIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      matchIdx = i;
      break;
    }
  }
  if (matchIdx === -1) return undefined;

  const start = Math.max(0, matchIdx - contextLines);
  const end = Math.min(lines.length, matchIdx + contextLines + 1);
  const slice = lines.slice(start, end);

  const parts: string[] = [];
  if (start > 0) parts.push(`...(${start} lines above)`);
  parts.push(...slice);
  if (end < lines.length) parts.push(`...(${lines.length - end} lines below)`);
  return parts.join("\n");
};

/** Build full searchable text for a message. */
const fullText = (msg: Message): string => {
  if ((msg as any).role === "bashExecution") {
    return `${(msg as any).command ?? ""} ${(msg as any).output ?? ""}`;
  }
  // Include thinking content so recall can match against model reasoning
  let text = textOf(msg.content);
  const thinking = thinkingOf(msg.content);
  if (thinking) text = thinking + "\n" + text;
  return text;
};

export const searchEntries = (
  entries: RenderedEntry[],
  messages: Message[],
  query?: string,
): SearchHit[] => {
  if (!query?.trim()) return entries;

  const rawQuery = query.trim();

  // If query looks like a single regex pattern (contains metacharacters),
  // treat the whole thing as one pattern — don't split into terms.
  // Apply a source length cap to prevent pathological patterns.
  if (looksLikeRegex(rawQuery)) {
    const regex = safeRegex(rawQuery);
    const hits: SearchHit[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const msg = messages[i];
      const text = msg ? fullText(msg) : e.summary;
      const filePart = e.files?.join(" ") ?? "";
      const hay = `${e.role} ${text} ${filePart}`;
      if (regex.test(hay)) {
        const snip = lineSnippet(text, regex);
        hits.push({ ...e, snippet: snip, matchCount: 1 });
        if (hits.length >= MAX_SEARCH_RESULTS) break;
      }
    }
    return hits;
  }

  // Natural language / multi-word query: BM25 scoring

  // Precompile all term regexes once — used across countMatches,
  // buildBM25Context, bm25Score, and snippet generation.
  const rawTerms = rawQuery.split(/\s+/);
  const terms = filterStopwords(rawTerms);
  const termCache = compileTerms(terms);
  const snipRe = snippetRegex(terms, termCache);

  // Build all docs for BM25 context
  const docs: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const msg = messages[i];
    const text = msg ? fullText(msg) : e.summary;
    const filePart = e.files?.join(" ") ?? "";
    docs.push(`${e.role} ${text} ${filePart}`);
  }

  const ctx = buildBM25Context(docs, termCache);

  // For multi-term queries, require a minimum number of terms to match.
  // This prevents common domain vocabulary (e.g. "document", "policy",
  // "review" in government/corporate sessions) from matching nearly
  // every entry via pure OR semantics.
  const minMatchCount = terms.length >= 3 ? MIN_TERM_MATCH_FOR_MULTITERM : 1;

  const scored: Array<{ hit: SearchHit; score: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const hay = docs[i];
    const mc = countMatches(hay, termCache);
    if (mc < minMatchCount) continue;
    const score = bm25Score(hay, termCache, ctx);
    const text = messages[i] ? fullText(messages[i]) : e.summary;
    const snip = lineSnippet(text, snipRe);
    scored.push({
      hit: { ...e, snippet: snip, matchCount: mc },
      score,
    });
  }

  // Sort by BM25 score desc
  scored.sort((a, b) => b.score - a.score);

  // Apply score ratio threshold: drop entries scoring below a fraction
  // of the top result. These are low-relevance noise matches.
  // Only applies when there are multiple terms (where OR semantics
  // can pull in tangential matches). Single-term queries have no
  // noise floor — the term either matches or it doesn't.
  if (scored.length > 1 && terms.length >= 2) {
    const topScore = scored[0].score;
    if (topScore > 0) {
      const threshold = topScore * MIN_SCORE_RATIO;
      const cutIdx = scored.findIndex((s) => s.score < threshold);
      if (cutIdx > 0) scored.length = cutIdx;
    }
  }

  // Hard cap on total results
  if (scored.length > MAX_SEARCH_RESULTS) {
    scored.length = MAX_SEARCH_RESULTS;
  }

  return scored.map((s) => s.hit);
};
