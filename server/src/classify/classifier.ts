export interface LabelSets {
  topics: string[];
  emotions: string[];
}

export interface ClassifyInput {
  text: string;
  language?: string;
  vocabulary: LabelSets;
  rejected: LabelSets;
}

export interface Classifier {
  readonly name: string;
  readonly model: string;
  /** Raw model proposal; callers must run postValidate() on it. */
  classify(input: ClassifyInput, signal?: AbortSignal): Promise<LabelSets>;
}

export const MAX_LABELS = 3;
const MAX_LABEL_CHARS = 40;

/** Case-, accent- and whitespace-insensitive key used for equivalence and rejection checks. */
export function labelKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function capitalize(s: string): string {
  return s.charAt(0).toLocaleUpperCase() + s.slice(1);
}

function cleanGroup(raw: unknown, vocabulary: string[], rejected: string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const vocab = new Map(vocabulary.map((v) => [labelKey(v), v]));
  const banned = new Set(rejected.map(labelKey));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    // Models sometimes answer "Salud/Health": every variant is checked against rejections.
    const variants = item.split('/').map((v) => v.replace(/\s+/g, ' ').trim().replace(/^[#"'«]+|[."'»]+$/g, '')).filter(Boolean);
    if (variants.some((v) => banned.has(labelKey(v)))) continue;
    const trimmed = variants.find((v) => vocab.has(labelKey(v))) ?? variants[0] ?? '';
    const k = labelKey(trimmed);
    if (!k || trimmed.length > MAX_LABEL_CHARS || seen.has(k)) continue;
    seen.add(k);
    out.push(vocab.get(k) ?? capitalize(trimmed));
    if (out.length === MAX_LABELS) break;
  }
  return out;
}

/**
 * Enforces the contract regardless of what the model returned: dedupe, reuse vocabulary
 * spelling, never return rejected labels, cap at 3 + 3, and a label can't be both.
 */
export function postValidate(raw: Partial<Record<keyof LabelSets, unknown>>, input: Pick<ClassifyInput, 'vocabulary' | 'rejected'>): LabelSets {
  const topics = cleanGroup(raw.topics, input.vocabulary.topics, input.rejected.topics);
  const topicKeys = new Set(topics.map(labelKey));
  const emotions = cleanGroup(raw.emotions, input.vocabulary.emotions, input.rejected.emotions).filter(
    (e) => !topicKeys.has(labelKey(e)),
  );
  return { topics, emotions };
}
