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

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

import { LspClient } from './client';
import { loadConfig, scaffoldGlobalConfig, serversForExtension, type LoadedConfig } from './config';
import { registerLspTool, type ServerManager } from './tools';
import type { ResolvedServerConfig } from './types';

export default function lspExtension(pi: ExtensionAPI) {
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

  const serverManager: ServerManager = {
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

  registerLspTool(pi, serverManager);

  // ── Session lifecycle ─────────────────────────────────────────────────

  pi.on('session_start', async (_event, ctx) => {
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
    await shutdownAll();
    config = null;
  });

  pi.on('tool_execution_end', async (event, ctx) => {
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
}
