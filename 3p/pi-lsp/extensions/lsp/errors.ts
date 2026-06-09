/**
 * Tagged error types for the LSP extension.
 *
 * Modeled with Effect's `Data.TaggedError` so failures are typed, pattern
 * matchable, and carry structured context. Helpers at the bottom convert these
 * into human-readable messages, tool `details`, and native `Error`s when an
 * Effect needs to cross back into Promise-land.
 */

import { Data } from 'effect';

export class ConfigReadError extends Data.TaggedError('ConfigReadError')<{
  readonly path: string;
  readonly cause: unknown;
}> {
  get message(): string {
    return `Failed to read ${this.path}: ${causeMessage(this.cause)}`;
  }
}

export class ConfigWriteError extends Data.TaggedError('ConfigWriteError')<{
  readonly path: string;
  readonly cause: unknown;
}> {
  get message(): string {
    return `Failed to write ${this.path}: ${causeMessage(this.cause)}`;
  }
}

export class LspValidationError extends Data.TaggedError('LspValidationError')<{
  readonly reason: string;
}> {
  get message(): string {
    return this.reason;
  }
}

export class NoCapableServerError extends Data.TaggedError('NoCapableServerError')<{
  readonly operation: string;
  readonly filePath: string;
}> {
  get message(): string {
    return `No LSP server with '${this.operation}' capability found for ${this.filePath}. Check /lsp status.`;
  }
}

export class NoServerAvailableError extends Data.TaggedError('NoServerAvailableError')<{
  readonly operation: string;
}> {
  get message(): string {
    return `No LSP server available for ${this.operation}.`;
  }
}

export class LspOperationError extends Data.TaggedError('LspOperationError')<{
  readonly operation: string;
  readonly server?: string;
  readonly cause: unknown;
}> {
  get message(): string {
    const server = this.server ? ` (${this.server})` : '';
    return `LSP ${this.operation}${server} failed: ${causeMessage(this.cause)}`;
  }
}

export type LspExtensionError =
  | ConfigReadError
  | ConfigWriteError
  | LspValidationError
  | NoCapableServerError
  | NoServerAvailableError
  | LspOperationError;

// ── Helpers ───────────────────────────────────────────────────────────────

export function causeMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

export function errorDetails(error: unknown): Record<string, unknown> {
  if (typeof error === 'object' && error !== null && '_tag' in error) {
    const tagged = error as { _tag: string } & Record<string, unknown>;
    const details: Record<string, unknown> = { error: tagged._tag };
    for (const [key, value] of Object.entries(tagged)) {
      if (key === '_tag' || key === 'cause') continue;
      details[key] = value;
    }
    details.message = errorMessage(error);
    return details;
  }

  return { error: 'lsp_error', message: errorMessage(error) };
}

/** Convert a tagged/unknown error into a native Error for Promise rejection. */
export function toNativeError(error: unknown): Error {
  if (error instanceof Error) return error;
  const native = new Error(errorMessage(error));
  if (typeof error === 'object' && error !== null && '_tag' in error) {
    native.name = String((error as { _tag: unknown })._tag);
  }
  return native;
}
