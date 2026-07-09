// Local-delta coverage for the pi-pi fork's zero-config LSP rewrite.
//
// This file (sibling to the vendored config.test.ts) tests ONLY behavior that differs from
// upstream: config.ts was rewritten to auto-detect built-in servers via `which`, with no config
// files, no scaffolding, no project/global merge, and no disable switch. The upstream cases that
// asserted the old file-driven behavior are FORK:-skipped in config.test.ts. Kept in a separate
// *.local.test.ts file so upstream rebases re-apply the vendored suite cleanly.

import { describe, expect, test } from 'bun:test';

import { loadConfig, scaffoldGlobalConfig, serversForExtension } from '../extensions/lsp/config';
import type { ResolvedServerConfig } from '../extensions/lsp/types';

describe('zero-config loadConfig (local fork)', () => {
  test('never reports globalDisabled or errors — the disable/error surfaces were removed', async () => {
    const config = await loadConfig(process.cwd());
    expect(config.globalDisabled).toBe(false);
    expect(config.errors).toEqual([]);
    expect(Array.isArray(config.servers)).toBe(true);
  });

  test('every auto-detected server is a well-formed built-in with a resolvable command', async () => {
    const knownBuiltins = new Set([
      'typescript',
      'go',
      'rust',
      'python',
      'clangd',
      'bash',
      'lua',
      'zig',
      'kotlin',
      'ruby',
      'csharp',
      'swift',
      'elixir',
      'java',
    ]);

    const config = await loadConfig(process.cwd());
    for (const server of config.servers) {
      expect(knownBuiltins.has(server.name)).toBe(true);
      expect(typeof server.command).toBe('string');
      expect(server.command.length).toBeGreaterThan(0);
      expect(Array.isArray(server.args)).toBe(true);
      expect(server.extensions.length).toBeGreaterThan(0);
      expect(typeof server.env).toBe('object');
      expect(typeof server.initializationOptions).toBe('object');
    }
  });

  test('ignores project .pi/lsp.json entirely (zero-config): a bogus config does not change results', async () => {
    // Upstream read cwd/.pi/lsp.json; the fork ignores it. Passing a temp cwd with no config must
    // yield the same auto-detected set as any other cwd, proving config files are not consulted.
    const a = await loadConfig('/nonexistent-cwd-a');
    const b = await loadConfig('/nonexistent-cwd-b');
    expect(a.servers.map((s) => s.name).sort()).toEqual(b.servers.map((s) => s.name).sort());
    expect(a.globalDisabled).toBe(false);
  });

  test('scaffoldGlobalConfig is a no-op that always resolves false', async () => {
    await expect(scaffoldGlobalConfig(process.cwd())).resolves.toBe(false);
    // Repeated calls stay false — there is no "already scaffolded" transition anymore.
    await expect(scaffoldGlobalConfig(process.cwd())).resolves.toBe(false);
  });
});

describe('serversForExtension (local fork)', () => {
  const server = (name: string, extensions: string[]): ResolvedServerConfig => ({
    name,
    command: name,
    args: [],
    extensions,
    env: {},
    initializationOptions: {},
  });

  const servers: ResolvedServerConfig[] = [
    server('typescript', ['.ts', '.tsx', '.js']),
    server('rust', ['.rs']),
    server('python', ['.py', '.pyi']),
  ];

  test('matches by the file extension of the path', () => {
    expect(serversForExtension(servers, '/proj/src/main.rs').map((s) => s.name)).toEqual(['rust']);
    expect(serversForExtension(servers, 'index.ts').map((s) => s.name)).toEqual(['typescript']);
  });

  test('returns all servers whose extension list includes the file extension', () => {
    const matched = serversForExtension(servers, 'a.js').map((s) => s.name);
    expect(matched).toEqual(['typescript']);
  });

  test('returns empty when no server handles the extension', () => {
    expect(serversForExtension(servers, 'notes.md')).toEqual([]);
  });

  test('extension match uses the final dot segment of the path', () => {
    expect(serversForExtension(servers, '/deep/path.with.dots/file.py').map((s) => s.name)).toEqual([
      'python',
    ]);
  });
});
