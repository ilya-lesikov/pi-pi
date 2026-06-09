/**
 * FileSystem service — the only place the LSP extension touches disk.
 *
 * Wrapping Node's `fs/promises` behind an Effect service keeps config loading
 * pure and injectable: tests can swap in an in-memory implementation, and
 * failures surface as typed `ConfigReadError` / `ConfigWriteError` values.
 */

import { Context, Effect } from 'effect';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ConfigReadError, ConfigWriteError } from '../errors';

export interface FileSystemService {
  /** Read a UTF-8 file, failing with ConfigReadError when unreadable/missing. */
  readonly readTextFile: (path: string) => Effect.Effect<string, ConfigReadError>;
  /** Whether a path exists. Never fails. */
  readonly fileExists: (path: string) => Effect.Effect<boolean>;
  /** Write a UTF-8 file, creating parent directories first. */
  readonly writeTextFile: (path: string, content: string) => Effect.Effect<void, ConfigWriteError>;
}

export class FileSystem extends Context.Tag('Lsp/FileSystem')<FileSystem, FileSystemService>() {}

export const nodeFileSystemService: FileSystemService = {
  readTextFile: (path) =>
    Effect.tryPromise({
      try: () => readFile(path, 'utf8'),
      catch: (cause) => new ConfigReadError({ path, cause }),
    }),

  fileExists: (path) =>
    Effect.tryPromise({
      try: () => access(path),
      catch: (cause) => cause,
    }).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
    ),

  writeTextFile: (path, content) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, 'utf8');
      },
      catch: (cause) => new ConfigWriteError({ path, cause }),
    }),
};
