import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { loadConfig, scaffoldGlobalConfig } from '../extensions/lsp/config';

let originalHome = process.env.HOME;
const cleanup: string[] = [];

async function makeTempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

beforeEach(() => {
  originalHome = process.env.HOME;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('config loader', () => {
  test('returns no servers when no config files exist', async () => {
    const home = await makeTempDir('pi-lsp-home-');
    const cwd = await makeTempDir('pi-lsp-cwd-');
    process.env.HOME = home;

    const config = await loadConfig(cwd);
    expect(config.globalDisabled).toBe(false);
    expect(config.servers).toEqual([]);
    expect(config.errors).toEqual([]);
  });

  test('scaffolds starter global config only when neither config exists', async () => {
    const home = await makeTempDir('pi-lsp-home-');
    const cwd = await makeTempDir('pi-lsp-cwd-');
    process.env.HOME = home;

    const created = await scaffoldGlobalConfig(cwd);
    expect(created).toBe(true);

    const globalConfigPath = join(home, '.pi', 'agent', 'extensions', 'lsp', 'config.json');
    const text = await readFile(globalConfigPath, 'utf8');
    expect(text).toContain('typescript-language-server');

    const again = await scaffoldGlobalConfig(cwd);
    expect(again).toBe(false);
  });

  test('does not scaffold when project config exists', async () => {
    const home = await makeTempDir('pi-lsp-home-');
    const cwd = await makeTempDir('pi-lsp-cwd-');
    process.env.HOME = home;

    await mkdir(join(cwd, '.pi'), { recursive: true });
    await writeFile(join(cwd, '.pi', 'lsp.json'), '{"lsp":{}}', 'utf8');

    const created = await scaffoldGlobalConfig(cwd);
    expect(created).toBe(false);
  });

  test('merges global and project config with project override + env merge', async () => {
    const home = await makeTempDir('pi-lsp-home-');
    const cwd = await makeTempDir('pi-lsp-cwd-');
    process.env.HOME = home;

    await writeJson(join(home, '.pi', 'agent', 'extensions', 'lsp', 'config.json'), {
      lsp: {
        rust: {
          command: ['node'],
          extensions: ['.rs'],
          env: { RUST_LOG: 'info', A: '1' },
          initialization: { cargo: { allFeatures: true } },
        },
      },
    });

    await writeJson(join(cwd, '.pi', 'lsp.json'), {
      lsp: {
        rust: {
          extensions: ['.rs', '.ron'],
          env: { RUST_LOG: 'debug', B: '2' },
        },
        javascript: {
          command: ['node'],
          extensions: ['.js'],
        },
      },
    });

    const config = await loadConfig(cwd);
    expect(config.globalDisabled).toBe(false);
    expect(config.servers.map((s) => s.name).sort()).toEqual(['javascript', 'rust']);

    const rust = config.servers.find((s) => s.name === 'rust');
    expect(rust).toBeTruthy();
    expect(rust?.extensions).toEqual(['.rs', '.ron']);
    expect(rust?.env).toEqual({ RUST_LOG: 'debug', A: '1', B: '2' });
    expect(rust?.initializationOptions).toEqual({ cargo: { allFeatures: true } });
  });

  test('lsp false disables everything', async () => {
    const home = await makeTempDir('pi-lsp-home-');
    const cwd = await makeTempDir('pi-lsp-cwd-');
    process.env.HOME = home;

    await writeJson(join(cwd, '.pi', 'lsp.json'), { lsp: false });
    const config = await loadConfig(cwd);
    expect(config.globalDisabled).toBe(true);
    expect(config.servers).toEqual([]);
  });
});
