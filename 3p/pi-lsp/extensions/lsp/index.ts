/**
 * Pi LSP Extension
 *
 * Language-agnostic code intelligence via LSP.
 * Auto-detects servers by file extension, configurable via:
 *   - ~/.pi/agent/extensions/lsp/config.json  (global defaults)
 *   - .pi/lsp.json                            (project overrides)
 *
 * Any LSP server can be added via config.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { LspClient } from './client';
import { inspectBuiltinServers, loadConfig, scaffoldGlobalConfig, serversForExtension, type LoadedConfig } from './config';
import { registerLspTool, type ServerManagerService } from './tools';
import type { ResolvedServerConfig } from './types';

export default function lspExtension(pi: ExtensionAPI) {
  // LOCAL PATCH (pi-pi): pi-pi's subagent runner opens an async scope around the
  // extension load of an in-process subagent session; snapshot it at factory time
  // so only that instance skips its hooks.
  const isSubagentSession =
    ((globalThis as Record<symbol, any>)[Symbol.for('pi-pi:subagent-session-scope')]?.getStore?.()?.depth ?? 0) > 0;
  const lspApiKey = Symbol.for('pi-lsp:api');
  let rootPath = '';
  let config: LoadedConfig | null = null;
  const clients = new Map<string, LspClient>();

  // ── Client management ───────────────────────────────────────────────

  function getOrCreateClient(serverConfig: ResolvedServerConfig): LspClient {
    const existing = clients.get(serverConfig.name);
    if (existing) return existing;

    const client = new LspClient(serverConfig, rootPath);
    clients.set(serverConfig.name, client);
    return client;
  }

  async function shutdownAll(): Promise<void> {
    const shutdowns = [...clients.values()].map((c) => c.shutdown().catch(() => {}));
    await Promise.all(shutdowns);
    clients.clear();
  }

  function refreshStatus(
    ui: { setStatus: (key: string, value: string) => void },
    cfg: LoadedConfig | null,
  ) {
    if (!cfg) {
      ui.setStatus('lsp', 'LSP: no servers detected');
      return;
    }

    if (cfg.globalDisabled) {
      ui.setStatus('lsp', 'LSP: disabled');
      return;
    }

    if (cfg.servers.length === 0) {
      ui.setStatus('lsp', 'LSP: no servers detected');
      return;
    }

    const running = cfg.servers.filter((server) => clients.get(server.name)?.isInitialized);
    if (running.length > 0) {
      ui.setStatus('lsp', `LSP: ${running.map((s) => s.name).join(', ')} (running)`);
      return;
    }

    ui.setStatus('lsp', `LSP: ${cfg.servers.map((s) => s.name).join(', ')}`);
  }

  // ── Server manager (passed to tool) ───────────────────────────────────

  const serverManager: ServerManagerService = {
    clientsForFile(filePath: string): LspClient[] {
      if (!config) return [];
      const matching = serversForExtension(config.servers, filePath);
      return matching.map((s) => getOrCreateClient(s));
    },

    clientForFileWithCapability(filePath: string, capability: string): LspClient | null {
      if (!config) return null;
      const matching = serversForExtension(config.servers, filePath);
      for (const serverConfig of matching) {
        const client = getOrCreateClient(serverConfig);
        // If not yet initialized, return it (capability check happens after init)
        if (!client.isInitialized) return client;
        if (client.hasCapability(capability)) return client;
      }
      return null;
    },

    anyClient(): LspClient | null {
      // Return first initialized client, or first available
      for (const client of clients.values()) {
        if (client.isInitialized) return client;
      }
      // Try to create one from config
      if (config && config.servers.length > 0) {
        return getOrCreateClient(config.servers[0]);
      }
      return null;
    },

    getRootPath: () => rootPath,
  };

  // ── Register tool ─────────────────────────────────────────────────────

  // LOCAL PATCH (pi-pi): an in-process subagent session skips session_start, so
  // its own `config` stays null and every lsp call would answer "no capable
  // server". Its clients would also never be shut down — nothing disposes a
  // subagent session — so it borrows the root session's manager instead of
  // starting language servers of its own.
  const rootServerManager = (): ServerManagerService | undefined =>
    (globalThis as any)[lspApiKey]?.serverManager;
  registerLspTool(pi, isSubagentSession
    ? {
        clientsForFile: (filePath) => rootServerManager()?.clientsForFile(filePath) ?? [],
        clientForFileWithCapability: (filePath, capability) =>
          rootServerManager()?.clientForFileWithCapability(filePath, capability) ?? null,
        anyClient: () => rootServerManager()?.anyClient() ?? null,
        getRootPath: () => rootServerManager()?.getRootPath() ?? '',
      }
    : serverManager);

  // ── Session lifecycle ─────────────────────────────────────────────────

  pi.on('session_start', async (_event, ctx) => {
    if (isSubagentSession) {
      return;
    }
    rootPath = ctx.cwd;

    const scaffolded = await scaffoldGlobalConfig(rootPath);
    if (scaffolded) {
      ctx.ui.notify(
        'LSP: created starter config at ~/.pi/agent/extensions/lsp/config.json — edit it to add your servers.',
        'info',
      );
    }

    config = await loadConfig(rootPath);
    refreshStatus(ctx.ui, config);
  });

  pi.on('session_shutdown', async () => {
    if (isSubagentSession) {
      return;
    }
    await shutdownAll();
    config = null;
  });

  pi.on('tool_execution_end', async (event, ctx) => {
    if (isSubagentSession) {
      return;
    }
    if (event.toolName !== 'lsp') return;
    refreshStatus(ctx.ui, config);
  });

  // ── Commands ──────────────────────────────────────────────────────────

  pi.registerCommand('lsp', {
    description: 'Show LSP server status',
    handler: async (_args, ctx) => {
      rootPath = ctx.cwd;
      const cfg = await loadConfig(ctx.cwd);
      config = cfg;
      refreshStatus(ctx.ui, cfg);
      const lines: string[] = ['LSP Status:'];

      if (cfg.globalDisabled) {
        lines.push('  All servers disabled via config.');
      } else if (cfg.servers.length === 0) {
        lines.push('  No servers configured.');
        lines.push('  Add servers to ~/.pi/agent/extensions/lsp/config.json or .pi/lsp.json');
      } else {
        for (const server of cfg.servers) {
          const client = clients.get(server.name);
          const status = client?.isInitialized ? 'running' : 'available (lazy start)';
          const exts = server.extensions.join(', ');
          lines.push(`  ${server.name}: ${status} — handles ${exts}`);
        }
      }

      if (cfg.errors.length > 0) {
        lines.push('', 'Config errors:');
        for (const err of cfg.errors) lines.push(`  - ${err}`);
      }

      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });

  pi.registerCommand('lsp-restart', {
    description: 'Restart all LSP servers',
    handler: async (_args, ctx) => {
      await shutdownAll();
      config = null;
      rootPath = ctx.cwd;
      config = await loadConfig(ctx.cwd);
      refreshStatus(ctx.ui, config);
      ctx.ui.notify('LSP servers stopped. Will reinitialize on next tool use.', 'info');
    },
  });

  // LOCAL PATCH (pi-pi): only the root session may publish the shared handle.
  // A subagent load would otherwise replace it with its own instance, whose
  // config is null and whose client map is empty, so "restart LSP" and the
  // doctor would report success against a dead object while the root session's
  // language servers kept running.
  if (!isSubagentSession) (globalThis as any)[lspApiKey] = {
    serverManager,
    status: async (ctx: any) => {
      rootPath = ctx.cwd;
      const cfg = await loadConfig(ctx.cwd);
      config = cfg;
      refreshStatus(ctx.ui, cfg);
      const lines: string[] = ['LSP Status:'];

      if (cfg.globalDisabled) {
        lines.push('  All servers disabled via config.');
      } else if (cfg.servers.length === 0) {
        lines.push('  No servers configured.');
        lines.push('  Add servers to ~/.pi/agent/extensions/lsp/config.json or .pi/lsp.json');
      } else {
        for (const server of cfg.servers) {
          const client = clients.get(server.name);
          const status = client?.isInitialized ? 'running' : 'available (lazy start)';
          const exts = server.extensions.join(', ');
          lines.push(`  ${server.name}: ${status} — handles ${exts}`);
        }
      }

      if (cfg.errors.length > 0) {
        lines.push('', 'Config errors:');
        for (const err of cfg.errors) lines.push(`  - ${err}`);
      }

      ctx.ui.notify(lines.join('\n'), 'info');
    },
    restart: async (ctx: any) => {
      await shutdownAll();
      config = null;
      rootPath = ctx.cwd;
      config = await loadConfig(ctx.cwd);
      refreshStatus(ctx.ui, config);
      ctx.ui.notify('LSP servers stopped. Will reinitialize on next tool use.', 'info');
    },

    // LOCAL PATCH (pi-pi): structured state for /pp's doctor. The status
    // command formats prose for a notification; a caller that wants to judge
    // an install needs the parts, including the ones for a language whose
    // server is missing entirely and so appears in no running config.
    describe: async (cwd: string, probe = false) => {
      rootPath = cwd;
      const cfg = await loadConfig(cwd);
      config = cfg;

      const detected = new Set(cfg.servers.map((server) => server.name));
      const servers = await Promise.all(cfg.servers.map(async (server) => {
        const client = clients.get(server.name);
        const base = {
          name: server.name,
          command: [server.command, ...server.args].join(' '),
          resolvedPath: server.resolvedPath ?? null,
          extensions: server.extensions,
          running: client?.isInitialized === true,
          stderr: client?.recentStderr() ?? [],
        };
        if (!probe || base.running) return { ...base, probe: base.running ? ('ok' as const) : ('skipped' as const) };

        // The only check that separates a binary that resolves from one that
        // runs: the rustup-shim case passes detection and dies on spawn.
        const probed = getOrCreateClient(server);
        try {
          await probed.ensureInitialized();
          return { ...base, probe: 'ok' as const, running: probed.isInitialized, stderr: probed.recentStderr() };
        } catch (error: any) {
          return { ...base, probe: 'failed' as const, error: error?.message ?? String(error), stderr: probed.recentStderr() };
        }
      }));

      return {
        rootPath,
        servers,
        // A language whose binary is absent vanishes from the detected set, so
        // nothing downstream could report which one is missing or what it wanted.
        missing: inspectBuiltinServers()
          .filter((builtin) => !detected.has(builtin.name))
          .map((builtin) => ({ name: builtin.name, command: builtin.command, extensions: builtin.extensions })),
        errors: cfg.errors,
        globalDisabled: cfg.globalDisabled,
      };
    },
  };
}
