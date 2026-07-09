// Local-delta coverage for the pi-pi fork's zero-config LSP entrypoint.
//
// Sibling to the vendored index.test.ts, this file tests ONLY the entrypoint behavior that differs
// from upstream: the fork's index.ts no longer scaffolds a starter config, ignores project
// .pi/lsp.json, and derives status purely from auto-detected built-in servers. The upstream
// entrypoint cases that asserted the old file-driven behavior are FORK:-skipped in index.test.ts.
// Kept separate so upstream rebases re-apply the vendored suite cleanly.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

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

const subagentSessionKey = Symbol.for('pi-pi:subagent-session');
const lspApiKey = Symbol.for('pi-lsp:api');

beforeEach(() => {
  delete (globalThis as any)[subagentSessionKey];
  delete (globalThis as any)[lspApiKey];
});

afterEach(() => {
  delete (globalThis as any)[subagentSessionKey];
  delete (globalThis as any)[lspApiKey];
});

describe('zero-config entrypoint (local fork)', () => {
  test('registers the lsp tool plus lsp/lsp-restart commands and lifecycle handlers', () => {
    const pi = createFakePi();
    lspExtension(pi as any);

    expect(pi.tool).toBeTruthy();
    expect(pi.commands.get('lsp')).toBeTruthy();
    expect(pi.commands.get('lsp-restart')).toBeTruthy();
    expect(pi.handlers.get('session_start')?.length).toBe(1);
    expect(pi.handlers.get('session_shutdown')?.length).toBe(1);
    expect(pi.handlers.get('tool_execution_end')?.length).toBe(1);
  });

  test('session_start sets status without emitting a scaffold notification', async () => {
    const pi = createFakePi();
    lspExtension(pi as any);
    const ui = createUiRecorder();

    await pi.handlers.get('session_start')?.[0]?.({}, { cwd: process.cwd(), ui: ui.ui });

    // scaffoldGlobalConfig() is a no-op resolving false in the fork (see config.local.test.ts), so
    // the "created starter config" notification is never emitted.
    expect(ui.notifications.some((n) => n.includes('created starter config'))).toBe(false);
    expect(ui.statuses.has('lsp')).toBe(true);
    expect(ui.statuses.get('lsp')).toMatch(/^LSP: /);
  });

  test('subagent sessions short-circuit lifecycle handlers', async () => {
    (globalThis as any)[subagentSessionKey] = true;
    const pi = createFakePi();
    lspExtension(pi as any);
    const ui = createUiRecorder();

    await pi.handlers.get('session_start')?.[0]?.({}, { cwd: process.cwd(), ui: ui.ui });
    expect(ui.statuses.has('lsp')).toBe(false);

    await pi.handlers.get('session_shutdown')?.[0]?.({}, { cwd: process.cwd(), ui: ui.ui });
    await pi.handlers
      .get('tool_execution_end')
      ?.[0]?.({ toolName: 'lsp' }, { cwd: process.cwd(), ui: ui.ui });
    expect(ui.notifications).toHaveLength(0);
  });

  test('lsp command reports auto-detected servers or a no-servers hint', async () => {
    const pi = createFakePi();
    lspExtension(pi as any);
    const ui = createUiRecorder();

    await pi.commands.get('lsp')?.handler('', { cwd: process.cwd(), ui: ui.ui });

    const out = ui.notifications.at(-1) ?? '';
    expect(out.startsWith('LSP Status:')).toBe(true);
    // Never mentions the removed config files as a required setup step beyond the hint branch.
    if (out.includes('No servers configured.')) {
      expect(out).toContain('.pi/lsp.json');
    } else {
      expect(out).toMatch(/available \(lazy start\)|running/);
    }
  });

  test('lsp-restart notifies the stop message', async () => {
    const pi = createFakePi();
    lspExtension(pi as any);
    const ui = createUiRecorder();

    await pi.commands.get('lsp-restart')?.handler('', { cwd: process.cwd(), ui: ui.ui });

    expect(ui.notifications.at(-1)).toContain(
      'LSP servers stopped. Will reinitialize on next tool use.',
    );
  });

  test('exposes a global API with status() and restart() mirroring the commands', async () => {
    const pi = createFakePi();
    lspExtension(pi as any);
    const api = (globalThis as any)[lspApiKey];
    expect(typeof api?.status).toBe('function');
    expect(typeof api?.restart).toBe('function');

    const ui = createUiRecorder();
    await api.status({ cwd: process.cwd(), ui: ui.ui });
    expect(ui.notifications.at(-1)?.startsWith('LSP Status:')).toBe(true);

    await api.restart({ cwd: process.cwd(), ui: ui.ui });
    expect(ui.notifications.at(-1)).toContain('Will reinitialize on next tool use.');
  });
});
