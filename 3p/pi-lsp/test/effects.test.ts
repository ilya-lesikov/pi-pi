import { describe, expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';

import { loadConfigEffect, scaffoldGlobalConfigEffect } from '../extensions/lsp/config';
import { CommandResolver, type CommandAvailability } from '../extensions/lsp/effects/command';
import { FileSystem, type FileSystemService } from '../extensions/lsp/effects/filesystem';
import { ConfigReadError } from '../extensions/lsp/errors';

/** Build an in-memory FileSystem service over a path→content map. */
function fakeFs(files: Record<string, string>, writes?: Record<string, string>): FileSystemService {
  return {
    readTextFile: (path) =>
      path in files
        ? Effect.succeed(files[path])
        : Effect.fail(new ConfigReadError({ path, cause: new Error('ENOENT') })),
    fileExists: (path) => Effect.succeed(path in files),
    writeTextFile: (path, content) =>
      Effect.sync(() => {
        if (writes) writes[path] = content;
        files[path] = content;
      }),
  };
}

function fakeResolver(availability: CommandAvailability) {
  return Layer.succeed(CommandResolver, { resolve: () => Effect.succeed(availability) });
}

describe('effect services', () => {
  test('loadConfigEffect resolves servers via injected services (no disk, no shell)', async () => {
    const home = process.env.HOME ?? '';
    const globalPath = `${home}/.pi/agent/extensions/lsp/config.json`;
    const fs = fakeFs({
      [globalPath]: JSON.stringify({
        lsp: { ts: { command: ['ts-ls', '--stdio'], extensions: ['.ts'] } },
      }),
    });

    const layer = Layer.merge(Layer.succeed(FileSystem, fs), fakeResolver('global'));
    const config = await Effect.runPromise(
      loadConfigEffect('/workspace').pipe(Effect.provide(layer)),
    );

    expect(config.globalDisabled).toBe(false);
    expect(config.servers).toEqual([
      {
        name: 'ts',
        command: 'ts-ls',
        args: ['--stdio'],
        extensions: ['.ts'],
        env: {},
        initializationOptions: {},
      },
    ]);
  });

  test('loadConfigEffect rewrites command to npx when only available via npx', async () => {
    const home = process.env.HOME ?? '';
    const globalPath = `${home}/.pi/agent/extensions/lsp/config.json`;
    const fs = fakeFs({
      [globalPath]: JSON.stringify({
        lsp: { ts: { command: ['ts-ls', '--stdio'], extensions: ['.ts'] } },
      }),
    });

    const layer = Layer.merge(Layer.succeed(FileSystem, fs), fakeResolver('npx'));
    const config = await Effect.runPromise(
      loadConfigEffect('/workspace').pipe(Effect.provide(layer)),
    );

    expect(config.servers[0]?.command).toBe('npx');
    expect(config.servers[0]?.args).toEqual(['--yes', 'ts-ls', '--stdio']);
  });

  test('loadConfigEffect drops servers whose command cannot be resolved', async () => {
    const home = process.env.HOME ?? '';
    const globalPath = `${home}/.pi/agent/extensions/lsp/config.json`;
    const fs = fakeFs({
      [globalPath]: JSON.stringify({
        lsp: { ts: { command: ['missing-ls'], extensions: ['.ts'] } },
      }),
    });

    const layer = Layer.merge(Layer.succeed(FileSystem, fs), fakeResolver(null));
    const config = await Effect.runPromise(
      loadConfigEffect('/workspace').pipe(Effect.provide(layer)),
    );

    expect(config.servers).toEqual([]);
  });

  test('scaffoldGlobalConfigEffect writes the starter template when nothing exists', async () => {
    const writes: Record<string, string> = {};
    const fs = fakeFs({}, writes);

    const created = await Effect.runPromise(
      scaffoldGlobalConfigEffect('/workspace').pipe(Effect.provideService(FileSystem, fs)),
    );

    expect(created).toBe(true);
    const written = Object.values(writes)[0] ?? '';
    const parsed = JSON.parse(written);
    for (const server of Object.values(parsed.lsp as Record<string, { disabled?: boolean }>)) {
      expect(server.disabled).toBe(true);
    }
  });
});
