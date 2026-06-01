/**
 * diff.ts — lightweight word-level diff for the History panel.
 *
 * Produces a sequence of { type, text } ops suitable for rendering
 * coloured before/after views. No external dependency.
 *
 * Algorithm: simple LCS via dynamic programming on word tokens.
 * Fast enough for document-sized text (< ~10k words). For massive
 * files the inner loop is O(n²) — fine for forum artifacts.
 */

export type DiffOp =
  | { type: "equal"; text: string }
  | { type: "insert"; text: string }   // in `next`, not in `prev`
  | { type: "delete"; text: string };  // in `prev`, not in `next`

/** Split text into tokens: words + whitespace runs as separate tokens. */
function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter(t => t.length > 0);
}

/** LCS length table between two token arrays. */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

/** Backtrack LCS table to produce diff ops. */
function backtrack(dp: number[][], a: string[], b: string[], i: number, j: number, ops: DiffOp[]): void {
  if (i === 0 && j === 0) return;
  if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
    backtrack(dp, a, b, i - 1, j - 1, ops);
    ops.push({ type: "equal", text: a[i - 1] });
  } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
    backtrack(dp, a, b, i, j - 1, ops);
    ops.push({ type: "insert", text: b[j - 1] });
  } else {
    backtrack(dp, a, b, i - 1, j, ops);
    ops.push({ type: "delete", text: a[i - 1] });
  }
}

/** Merge consecutive ops of the same type to keep the list compact. */
function merge(ops: DiffOp[]): DiffOp[] {
  const result: DiffOp[] = [];
  for (const op of ops) {
    const last = result[result.length - 1];
    if (last && last.type === op.type) {
      last.text += op.text;
    } else {
      result.push({ ...op });
    }
  }
  return result;
}

/**
 * Compute a word-level diff between `prev` and `next`.
 * Returns a flat array of DiffOp in document order.
 */
export function diffText(prev: string, next: string): DiffOp[] {
  if (prev === next) return [{ type: "equal", text: prev }];
  if (!prev) return [{ type: "insert", text: next }];
  if (!next) return [{ type: "delete", text: prev }];

  const a = tokenize(prev);
  const b = tokenize(next);
  const dp = lcsTable(a, b);
  const ops: DiffOp[] = [];
  backtrack(dp, a, b, a.length, b.length, ops);
  return merge(ops);
}

/**
 * How much of `prev` was changed to produce `next`, as a fraction 0–1.
 * Used for access tier classification (>0.5 = large change = Tier 2).
 */
export function changeMagnitude(prev: string, next: string): number {
  if (!prev && !next) return 0;
  if (!prev) return 1;
  if (!next) return 1;
  const ops = diffText(prev, next);
  const changed = ops
    .filter(o => o.type !== "equal")
    .reduce((sum, o) => sum + o.text.length, 0);
  const total = Math.max(prev.length, next.length);
  return changed / total;
}
