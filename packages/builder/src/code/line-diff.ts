/**
 * Line diff for the "review changes" dialog — LCS over lines, grouped into
 * hunks with context. Pure; sized for source files (falls back to a whole-file
 * replacement beyond ~4M cell comparisons).
 */

export interface DiffLine {
  kind: 'ctx' | 'add' | 'del';
  text: string;
  /** 1-based line numbers in the old / new file. */
  a?: number;
  b?: number;
}

export interface Hunk {
  lines: DiffLine[];
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  // Trim the common prefix/suffix first — most edits are local.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const out: DiffLine[] = [];
  for (let i = 0; i < pre; i++) out.push({ kind: 'ctx', text: a[i], a: i + 1, b: i + 1 });

  if (am.length * bm.length > 4_000_000) {
    am.forEach((t, i) => out.push({ kind: 'del', text: t, a: pre + i + 1 }));
    bm.forEach((t, i) => out.push({ kind: 'add', text: t, b: pre + i + 1 }));
  } else {
    const n = am.length, m = bm.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) { out.push({ kind: 'ctx', text: am[i], a: pre + i + 1, b: pre + j + 1 }); i++; j++; }
      else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) { out.push({ kind: 'add', text: bm[j], b: pre + j + 1 }); j++; }
      else { out.push({ kind: 'del', text: am[i], a: pre + i + 1 }); i++; }
    }
  }
  for (let k = 0; k < suf; k++) out.push({ kind: 'ctx', text: a[a.length - suf + k], a: a.length - suf + k + 1, b: b.length - suf + k + 1 });
  return out;
}

/** Changed regions with `context` unchanged lines around each. */
export function hunks(lines: DiffLine[], context = 3): Hunk[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === 'ctx') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: Hunk[] = [];
  let cur: DiffLine[] | null = null;
  lines.forEach((l, i) => {
    if (keep[i]) (cur ??= []).push(l);
    else if (cur) { out.push({ lines: cur }); cur = null; }
  });
  if (cur) out.push({ lines: cur });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter((l) => l.kind === 'add').length, removed: lines.filter((l) => l.kind === 'del').length };
}
