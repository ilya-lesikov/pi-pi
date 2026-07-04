const BANNER_SEPARATOR = "─".repeat(48);

export function advanceBanner(body: string): string {
  const content = body.startsWith("[PI-PI]") ? body.slice("[PI-PI]".length).trimStart() : body;
  return `[PI-PI]\n${BANNER_SEPARATOR}\n${content}\n${BANNER_SEPARATOR}`;
}
