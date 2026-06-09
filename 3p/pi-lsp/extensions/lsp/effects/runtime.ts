/**
 * Live Effect layer for the LSP extension.
 *
 * Merges the disk-facing FileSystem service and the command-availability
 * CommandResolver service. Build it once per extension activation and reuse it
 * for every config/scaffold program.
 */

import { Layer } from 'effect';

import { CommandResolver, nodeCommandResolverService } from './command';
import { FileSystem, nodeFileSystemService } from './filesystem';

export function makeRuntimeLayer() {
  return Layer.mergeAll(
    Layer.succeed(FileSystem, nodeFileSystemService),
    Layer.succeed(CommandResolver, nodeCommandResolverService),
  );
}

export type LspServices = FileSystem | CommandResolver;
