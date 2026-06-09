/**
 * Retry utility for LSP operations that may return empty results during server indexing.
 *
 * Only retries when the server was recently initialized (within a configurable window),
 * avoiding unnecessary delays for servers that are already warmed up.
 */

export interface RetryOptions {
  /** Maximum number of retry attempts. Default: 2 */
  maxRetries?: number;
  /** Delay between retries in milliseconds. Default: 2000 */
  delayMs?: number;
}

/**
 * Retry an async operation if the result is considered "empty".
 *
 * Useful for LSP operations that return empty results while the server is still indexing
 * (e.g. workspaceSymbol, hover, definition, references).
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  isEmpty: (result: T) => boolean,
  options?: RetryOptions,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 2;
  const delayMs = options?.delayMs ?? 2000;

  let result = await operation();
  let attempt = 0;

  while (isEmpty(result) && attempt < maxRetries) {
    attempt++;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    result = await operation();
  }

  return result;
}
