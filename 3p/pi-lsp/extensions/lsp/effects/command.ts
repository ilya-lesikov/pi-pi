/**
 * CommandResolver service — decides how a configured LSP server command can be
 * launched: directly from PATH (`global`), via `npx` as a fallback, or not at
 * all (`null`).
 *
 * Isolated behind an Effect service so config resolution stays pure and tests
 * can inject deterministic availability without shelling out.
 */

import { Context, Effect } from 'effect';
import { execSync } from 'node:child_process';

export type CommandAvailability = 'global' | 'npx' | null;

export interface CommandResolverService {
  readonly resolve: (command: string, cwd: string) => Effect.Effect<CommandAvailability>;
}

export class CommandResolver extends Context.Tag('Lsp/CommandResolver')<
  CommandResolver,
  CommandResolverService
>() {}

function commandAvailableVia(command: string, cwd: string): CommandAvailability {
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    execSync(`${whichCmd} ${command}`, { stdio: 'pipe', timeout: 5_000 });
    return 'global';
  } catch {
    // not on PATH
  }
  try {
    execSync(`npx --yes ${command} --version`, { stdio: 'pipe', cwd, timeout: 15_000 });
    return 'npx';
  } catch {
    return null;
  }
}

export const nodeCommandResolverService: CommandResolverService = {
  resolve: (command, cwd) => Effect.sync(() => commandAvailableVia(command, cwd)),
};
