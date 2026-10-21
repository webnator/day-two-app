/** Word/character error rate with an alignment that lists every difference. */

export function normalizeForWer(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(\d)[.,](?=\d{3}\b)/g, '$1') // 1.250 / 1,450 -> 1250 / 1450
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/(^|\s)'|'(\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type Op =
  | { type: 'equal'; ref: string; hyp: string }
  | { type: 'sub'; ref: string; hyp: string }
  | { type: 'del'; ref: string }
  | { type: 'ins'; hyp: string };

/** Levenshtein alignment over tokens, returning the edit script. */
export function align(ref: string[], hyp: string[]): Op[] {
  const n = ref.length;
  const m = hyp.length;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
    }
  }
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      ops.push(ref[i - 1] === hyp[j - 1] ? { type: 'equal', ref: ref[i - 1]!, hyp: hyp[j - 1]! } : { type: 'sub', ref: ref[i - 1]!, hyp: hyp[j - 1]! });
      i--;
      j--;
    } else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) {
      ops.push({ type: 'del', ref: ref[i - 1]! });
      i--;
    } else {
      ops.push({ type: 'ins', hyp: hyp[j - 1]! });
      j--;
    }
  }
  return ops.reverse();
}

export interface ErrorRates {
  wer: number;
  cer: number;
  refWords: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  diffs: string[];
}

export function errorRates(reference: string, hypothesis: string): ErrorRates {
  const r = normalizeForWer(reference);
  const h = normalizeForWer(hypothesis);
  const rw = r ? r.split(' ') : [];
  const hw = h ? h.split(' ') : [];
  const ops = align(rw, hw);
  const count = (t: Op['type']) => ops.filter((o) => o.type === t).length;
  const s = count('sub');
  const del = count('del');
  const ins = count('ins');
  const chars = align([...r], [...h]).filter((o) => o.type !== 'equal').length;
  return {
    wer: rw.length ? (s + del + ins) / rw.length : hw.length ? 1 : 0,
    cer: r.length ? chars / r.length : h.length ? 1 : 0,
    refWords: rw.length,
    substitutions: s,
    deletions: del,
    insertions: ins,
    diffs: ops.flatMap((o) =>
      o.type === 'sub' ? [`"${o.ref}" → "${o.hyp}"`] : o.type === 'del' ? [`− "${o.ref}"`] : o.type === 'ins' ? [`+ "${o.hyp}"`] : [],
    ),
  };
}

const NEGATION_OR_DOUBT = [
  'no', 'nunca', 'jamás', 'tampoco', 'ni', 'nadie', 'nada', 'quizá', 'quizás', 'tal', 'vez', 'creo', 'igual', 'puede',
  'not', "don't", "doesn't", "didn't", "isn't", "wasn't", "won't", "can't", "haven't", 'never', 'maybe', 'perhaps', 'think', 'sure',
];

/**
 * Automatic flags for likely meaning errors. They only point a human reviewer at candidates;
 * the final judgement is manual (see docs/EVAL-TRANSCRIPTION.md).
 */
export function meaningFlags(reference: string, hypothesis: string, names: string[] = []): string[] {
  const flags: string[] = [];
  const rw = normalizeForWer(reference).split(' ');
  const hw = normalizeForWer(hypothesis).split(' ');
  const countOf = (ws: string[], w: string) => ws.filter((x) => x === w).length;
  for (const w of NEGATION_OR_DOUBT) {
    const rc = countOf(rw, w);
    const hc = countOf(hw, w);
    if (rc !== hc) flags.push(`negation/doubt word "${w}": ref ${rc}, hyp ${hc}`);
  }
  const nums = (s: string) => (normalizeForWer(s).match(/\d+/g) ?? []).join(' ');
  if (nums(reference) !== nums(hypothesis)) flags.push(`numbers differ: ref [${nums(reference)}] hyp [${nums(hypothesis)}]`);
  for (const n of names) {
    if (!normalizeForWer(hypothesis).includes(normalizeForWer(n))) flags.push(`name missing/altered: ${n}`);
  }
  return flags;
}
