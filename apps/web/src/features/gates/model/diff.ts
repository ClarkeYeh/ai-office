export type DiffKind = 'same' | 'added' | 'removed';
export interface DiffLine {
  kind: DiffKind;
  text: string;
}
export interface LineDiff {
  lines: DiffLine[];
  /** Either side had more than `maxLines` lines; only the first `maxLines` were compared. */
  truncated: boolean;
  same: boolean;
}

export const DIFF_MAX_LINES = 2000;

const split = (text: string) => text.replace(/\r\n?/g, '\n').split('\n');

/**
 * Line LCS diff from `before` (AI Office original) to `after` (GitHub current):
 * `added` lines exist only on GitHub, `removed` only in the original.
 */
export function lineDiff(
  before: string,
  after: string,
  maxLines = DIFF_MAX_LINES,
): LineDiff {
  const allA = split(before);
  const allB = split(after);
  const a = allA.slice(0, maxLines);
  const b = allB.slice(0, maxLines);
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i..] and b[j..], flattened row-major.
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)
      lines.push({ kind: 'removed', text: a[i++]! });
    else lines.push({ kind: 'added', text: b[j++]! });
  }
  while (i < n) lines.push({ kind: 'removed', text: a[i++]! });
  while (j < m) lines.push({ kind: 'added', text: b[j++]! });
  return {
    lines,
    truncated: allA.length > maxLines || allB.length > maxLines,
    same: lines.every((line) => line.kind === 'same'),
  };
}
