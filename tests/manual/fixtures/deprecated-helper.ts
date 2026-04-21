/**
 * @deprecated Use the new utility modules instead:
 *   - formatDate, formatBytes → src/utils/format.ts
 *   - slugify → src/utils/format.ts
 *   - parseJSON → src/utils/parser.ts
 *
 * This file is scheduled for removal in v2.0.
 */

export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export function parseJSON<T>(input: string): T | null {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}
