const BANNER_SEPARATOR = "─".repeat(48);

/**
 * Render a `[PI-PI]` advance/continue message as a visually distinct banner so
 * it stands out in the chat transcript instead of blending into inline text.
 * `body` should already include the `[PI-PI]` prefix.
 */
export function advanceBanner(body: string): string {
  return `\n${BANNER_SEPARATOR}\n${body}\n${BANNER_SEPARATOR}`;
}
