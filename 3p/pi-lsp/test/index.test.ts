import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import lspExtension from '../extensions/lsp/index';

type Handler = (event: any, ctx: any) => Promise<any> | any;

interface FakePi {
  handlers: Map<string, Handler[]>;
  commands: Map<string, { description?: string; handler: Handler }>;
  tool: any;
  on: (event: string, handler: Handler) => void;
  registerCommand: (name: string, command: { description?: string; handler: Handler }) => void;
  registerTool: (tool: any) => void;
}

const cleanup: string[] = [];
let originalHome = process.env.HOME;

async function makeTempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

async function fileExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function createFakePi(): FakePi {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { description?: string; handler: Handler }>();
  let tool: any = null;

  return {
    handlers,
    commands,
    get tool() {
      return tool;
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool(def) {
      tool = def;
    },
  };
}

function createUiRecorder() {
  const notifications: string[] = [];
  const statuses = new Map<string, string>();

  return {
    notifications,
    statuses,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      setStatus(key: string, value: string) {
        statuses.set(key, value);
      },
    },
  };
}

beforeEach(() => {
  originalHome = process.env.HOME;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('extension/session layer', () => {
  test('session_start scaffolds starter global config when none exists', async () => {
    const home = await makeTempDir('pi-lsp-home-');
    process.env.HOME = home;

    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const cwd = await mkdtemp(join(packageRoot, '.tmp-scaffold-'));
    cleanup.push(cwd);

    const pi = createFakePi();
    lspExtension(pi as any);

    const ui = createUiRecorder();
    const sessionStart = pi.handlers.get('session_start')?.[0];
    expect(sessionStart).toBeTruthy();

    await sessionStart?.({}, { cwd, ui: ui.ui });

    const globalConfigPath = join(home, '.pi', 'agent', 'extensions', 'lsp', 'config.json');
    expect(await fileExists(globalConfigPath)).toBe(true);
    const text = await readFile(globalConfigPath, 'utf8');
    expect(text).toContain('typescript-language-server');
    expect(ui.notifications.some((n) => n.includes('created starter config'))).toBe(true);
  });

  test('full entrypoint shows lazy/running status, routes tool calls, and restarts', async () => {
    const home = await makeTempDir('pi-lsp-home-');
    const cwd = await makeTempDir('pi-lsp-workspace-');
    process.env.HOME = home;

    await mkdir(join(cwd, '.pi'), { recursive: true });
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src', 'mock.ts'), 'const value = 1;\n', 'utf8');

    const mockServerPath = fileURLToPath(new URL('./mock-lsp-server.ts', import.meta.url));
    await writeFile(
      join(cwd, '.pi', 'lsp.json'),
      JSON.stringify(
        {
          lsp: {
            mock: {
              command: ['bun', mockServerPath],
              extensions: ['.ts'],
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const pi = createFakePi();
    lspExtension(pi as any);

    const ui = createUiRecorder();
    const ctx = { cwd, ui: ui.ui };

    const sessionStart = pi.handlers.get('session_start')?.[0];
    const sessionShutdown = pi.handlers.get('session_shutdown')?.[0];
    const lspStatus = pi.commands.get('lsp');
    const lspRestart = pi.commands.get('lsp-restart');
    expect(sessionStart).toBeTruthy();
    expect(sessionShutdown).toBeTruthy();
    expect(lspStatus).toBeTruthy();
    expect(lspRestart).toBeTruthy();
    expect(pi.tool).toBeTruthy();

    await sessionStart?.({}, ctx);
    expect(ui.statuses.get('lsp')).toBe('LSP: mock');

    await lspStatus?.handler('', ctx);
    expect(ui.notifications.at(-1)).toContain('mock: available (lazy start) — handles .ts');

    const toolResult = await pi.tool.execute(
      'tool-1',
      { operation: 'hover', filePath: 'src/mock.ts', line: 1, character: 1 },
      undefined,
      undefined,
      ctx,
    );
    expect((toolResult.content[0] as { text?: string } | undefined)?.text).toContain(
      'Mock hover docs',
    );

    await lspStatus?.handler('', ctx);
    expect(ui.notifications.at(-1)).toContain('mock: running — handles .ts');

    await lspRestart?.handler('', ctx);
    expect(ui.notifications.at(-1)).toContain(
      'LSP servers stopped. Will reinitialize on next tool use.',
    );

    await lspStatus?.handler('', ctx);
    expect(ui.notifications.at(-1)).toContain('mock: available (lazy start) — handles .ts');

    await sessionShutdown?.({}, ctx);
  });
});
