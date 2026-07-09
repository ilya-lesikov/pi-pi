export function isReviewFileForRound(filename: string, pass: number): boolean {
  return new RegExp(`_round-${pass}\\.md$`).test(filename);
}
