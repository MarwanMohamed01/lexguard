// The reduce step (M4 step 6, D39): turn per-chunk clauses into document-level clauses.
//
// Each extractor sees one chunk, so the raw list has pieces:
//   - a clause cut by a chunk boundary comes back as two quotes of the same type that touch
//     at the boundary (chunks cover the text with no gap or overlap, D15);
//   - the same passage may be quoted twice in overlapping ways ("governed by NY law" and
//     "This Agreement is governed by NY law").
// Rule: clauses of the SAME type whose spans overlap, or are separated only by whitespace,
// become one clause covering both. Different types never merge; same-type clauses with real
// text between them stay separate (e.g. Parties in the preamble and in the signature block).
// Details are combined without duplicates. Offsets are document offsets; the merged quote is
// cut from the document text by the caller (T3: never assembled from model output).

export interface ClausePiece {
  type: string;
  start: number;
  end: number;
  chunk: number;
  parties: readonly string[];
  obligations: readonly { party: string; action: string }[];
  dates: readonly string[];
  riskFlags: readonly string[];
}

export interface MergedClause {
  type: string;
  start: number;
  end: number;
  /** Chunks the merged span draws on, ascending. */
  chunks: number[];
  /** How many per-chunk clauses were merged into this one. */
  pieces: number;
  parties: string[];
  obligations: { party: string; action: string }[];
  dates: string[];
  riskFlags: string[];
}

const unique = <T>(items: Iterable<T>, key: (item: T) => string): T[] => {
  const seen = new Map<string, T>();
  for (const item of items) if (!seen.has(key(item))) seen.set(key(item), item);
  return [...seen.values()];
};

/**
 * Document-level clauses, sorted by start offset (then type). `gapIsMergeable(from, to)` says
 * whether the text between two spans is only whitespace; the caller answers from the
 * document text, so this function stays pure and needs no text of its own.
 */
export function mergeClauses(
  pieces: readonly ClausePiece[],
  gapIsMergeable: (from: number, to: number) => boolean,
): MergedClause[] {
  const byType = new Map<string, ClausePiece[]>();
  for (const p of pieces) {
    if (!(p.end > p.start)) continue; // an empty span is no evidence
    const list = byType.get(p.type) ?? [];
    list.push(p);
    byType.set(p.type, list);
  }

  const merged: MergedClause[] = [];
  for (const [type, list] of byType) {
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    let group: ClausePiece[] = [];
    let groupEnd = -1;
    const flush = () => {
      const first = group[0];
      if (first === undefined) return;
      merged.push({
        type,
        start: first.start,
        end: groupEnd,
        chunks: [...new Set(group.map((g) => g.chunk))].sort((a, b) => a - b),
        pieces: group.length,
        parties: unique(
          group.flatMap((g) => g.parties),
          (p) => p.toLowerCase(),
        ),
        obligations: unique(
          group.flatMap((g) => g.obligations),
          (o) => `${o.party.toLowerCase()}\u0000${o.action.toLowerCase()}`,
        ),
        dates: unique(
          group.flatMap((g) => g.dates),
          (d) => d.toLowerCase(),
        ),
        riskFlags: unique(
          group.flatMap((g) => g.riskFlags),
          (f) => f,
        ).sort(),
      });
    };
    for (const p of list) {
      const joins = group.length > 0 && (p.start <= groupEnd || gapIsMergeable(groupEnd, p.start));
      if (!joins) {
        flush();
        group = [];
        groupEnd = -1;
      }
      group.push(p);
      groupEnd = Math.max(groupEnd, p.end);
    }
    flush();
  }
  return merged.sort((a, b) => a.start - b.start || (a.type < b.type ? -1 : 1));
}
