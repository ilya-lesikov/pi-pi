// Local-delta coverage for the pi-pi fork's platform-aware server detection.
//
// The fork's zero-config rewrite resolves every built-in by looking its command up on PATH. That
// lookup is `which` on posix and `where` on win32: cmd.exe ships no `which`, so the POSIX-only
// form the rewrite originally carried failed for EVERY built-in on native Windows, leaving a
// session with no language server at all and an `lsp` tool that could only answer "no server".
//
// Sibling to config.local.test.ts, kept out of the vendored suite so upstream rebases re-apply
// cleanly. Mirrors extensions/orchestrator/cbm.which.test.ts, which guards the same split.

import { afterEach, describe, expect, mock, test } from 'bun:test';

const calls: Array<{ command: string; args: string[]; viaShell: boolean }> = [];
let response: (command: string, args: string[]) => string = () => '';

// Both forms are stubbed on purpose. execSync is what the POSIX-only original
// used, so it stays reachable here: a regression back to it must fail these
// tests on an assertion, not on a missing export.
mock.module('node:child_process', () => ({
  execFileSync: (command: string, args: string[]) => {
    calls.push({ command, args, viaShell: false });
    return response(command, args);
  },
  execSync: (line: string) => {
    const [command, ...args] = line.split(' ');
    calls.push({ command: command ?? '', args, viaShell: true });
    return response(command ?? '', args);
  },
}));

const { loadConfig, inspectBuiltinServers } = await import('../extensions/lsp/config');

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

const originalPlatform = process.platform;

afterEach(() => {
  setPlatform(originalPlatform);
  calls.length = 0;
  response = () => '';
});

describe('platform-aware server detection (local fork)', () => {
  test('looks commands up with `which` on posix and keeps the resolved path', async () => {
    setPlatform('linux');
    response = (command, args) => {
      if (command === 'which' && args[0] === 'rust-analyzer') return '/home/u/.cargo/bin/rust-analyzer\n';
      throw new Error('not found');
    };

    const config = await loadConfig('/repo');

    expect(calls.every((call) => call.command === 'which')).toBe(true);
    expect(config.servers.map((server) => server.name)).toEqual(['rust']);
    expect(config.servers[0]?.resolvedPath).toBe('/home/u/.cargo/bin/rust-analyzer');
  });

  test('looks commands up with `where` on win32 — the lookup cmd.exe actually has', async () => {
    setPlatform('win32');
    response = (command, args) => {
      if (command === 'where' && args[0] === 'rust-analyzer') {
        return 'C:\\Users\\u\\.cargo\\bin\\rust-analyzer.exe\r\nC:\\other\\rust-analyzer.exe\r\n';
      }
      throw new Error('INFO: Could not find files');
    };

    const config = await loadConfig('/repo');

    expect(calls.every((call) => call.command === 'where')).toBe(true);
    expect(config.servers.map((server) => server.name)).toEqual(['rust']);
    // `where` lists every match; the first is the one that would actually run.
    expect(config.servers[0]?.resolvedPath).toBe('C:\\Users\\u\\.cargo\\bin\\rust-analyzer.exe');
  });

  test('passes the command as an argv entry, never as a shell string', async () => {
    setPlatform('linux');
    response = () => {
      throw new Error('not found');
    };

    await loadConfig('/repo');

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.viaShell).toBe(false);
      expect(call.args).toHaveLength(1);
    }
  });

  test('a built-in whose binary is absent is left out of the detected set', async () => {
    setPlatform('linux');
    response = () => {
      throw new Error('not found');
    };

    const config = await loadConfig('/repo');

    expect(config.servers).toEqual([]);
    expect(config.globalDisabled).toBe(false);
    expect(config.errors).toEqual([]);
  });

  test('inspectBuiltinServers reports every built-in with its verdict, found or not', async () => {
    setPlatform('linux');
    response = (command, args) => {
      if (args[0] === 'gopls') return '/usr/local/bin/gopls\n';
      throw new Error('not found');
    };

    const builtins = inspectBuiltinServers();
    const go = builtins.find((builtin) => builtin.name === 'go');
    const rust = builtins.find((builtin) => builtin.name === 'rust');

    // The point of the doctor surface: a language with no server still appears,
    // naming the binary it wanted, instead of silently vanishing from the set.
    expect(builtins.length).toBeGreaterThan(1);
    expect(go?.resolvedPath).toBe('/usr/local/bin/gopls');
    expect(rust?.resolvedPath).toBeNull();
    expect(rust?.command).toEqual(['rust-analyzer']);
    expect(rust?.extensions).toEqual(['.rs']);
  });
});
