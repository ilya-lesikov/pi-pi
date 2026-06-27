function isDateSegment(n: number): boolean {
  return n >= 19700101 && n <= 99991231 && String(n).length === 8;
}

export function compareModelVersion(a: string, b: string): number {
  const aParts = (a.match(/\d+/g) ?? []).map(Number);
  const bParts = (b.match(/\d+/g) ?? []).map(Number);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ai = aParts[i] ?? 0;
    const bi = bParts[i] ?? 0;
    if (ai === bi) continue;
    const aDate = isDateSegment(ai);
    const bDate = isDateSegment(bi);
    if (aDate !== bDate) return aDate ? -1 : 1;
    return ai - bi;
  }
  return a.localeCompare(b);
}
