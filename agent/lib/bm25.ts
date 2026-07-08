/**
 * Tiny in-memory BM25 index. Pure, dependency-free, built once at cold start.
 *
 * Okapi BM25 with the standard k1=1.5, b=0.75. Good lexical retrieval over
 * short chat messages: relevance ranking (not recency), term saturation, and
 * length normalisation — a real upgrade over substring AND-matching.
 */

const K1 = 1.5;
const B = 0.75;

// Light stopword list so common words don't dominate ranking.
const STOP = new Set(
  "a an and are as at be but by for from has have i if in is it its of on or that the their them they this to was were what when which who will with you your".split(
    " "
  )
);

export const tokenize = (text: string): string[] => {
  const out: string[] = [];
  // oxlint-disable-next-line require-unicode-regexp -- ASCII-only pattern; u flag changes non-BMP behaviour not applicable here
  for (const tok of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (tok.length >= 2 && !STOP.has(tok)) {
      out.push(tok);
    }
  }
  return out;
};

export interface Bm25Index {
  /** Returns doc indices ranked by BM25 score (descending), best first. */
  search: (query: string, limit: number) => { index: number; score: number }[];
}

export const buildBm25 = (docs: string[]): Bm25Index => {
  const N = docs.length;
  // term -> (doc -> tf)
  const postings = new Map<string, Map<number, number>>();
  const docLen = new Float64Array(N);
  let totalLen = 0;

  for (let d = 0; d < N; d += 1) {
    const toks = tokenize(docs[d]);
    docLen[d] = toks.length;
    totalLen += toks.length;
    for (const t of toks) {
      let pl = postings.get(t);
      if (!pl) {
        pl = new Map();
        postings.set(t, pl);
      }
      pl.set(d, (pl.get(d) ?? 0) + 1);
    }
  }
  const avgdl = totalLen / N || 1;

  const idf = (df: number): number => Math.log(1 + (N - df + 0.5) / (df + 0.5));

  return {
    search(query, limit) {
      const terms = [...new Set(tokenize(query))];
      const scores = new Map<number, number>();
      for (const t of terms) {
        const pl = postings.get(t);
        if (!pl) {
          continue;
        }
        const termIdf = idf(pl.size);
        for (const [d, tf] of pl) {
          const denom = tf + K1 * (1 - B + (B * docLen[d]) / avgdl);
          const s = termIdf * ((tf * (K1 + 1)) / denom);
          scores.set(d, (scores.get(d) ?? 0) + s);
        }
      }
      return [...scores.entries()]
        .map(([index, score]) => ({ index, score }))
        .toSorted((a, b) => b.score - a.score)
        .slice(0, limit);
    },
  };
};
