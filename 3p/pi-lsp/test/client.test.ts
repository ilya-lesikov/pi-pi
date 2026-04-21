import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LspClient } from '../extensions/lsp/client';

const cleanup: string[] = [];

async function makeWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-lsp-workspace-'));
  cleanup.push(dir);
  await mkdir(join(dir, 'src'), { recursive: true });
  return dir;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('LspClient with mock server', () => {
  test('handles initialize + diagnostics + rich LSP operations', async () => {
    const workspace = await makeWorkspace();
    const filePath = 'src/mock.ts';
    await writeFile(join(workspace, filePath), 'const ok = 1;\n', 'utf8');

    const serverPath = new URL('./mock-lsp-server.ts', import.meta.url).pathname;
    const client = new LspClient(
      {
        name: 'mock',
        command: 'bun',
        args: [serverPath],
        extensions: ['.ts'],
        env: {},
        initializationOptions: {},
      },
      workspace,
    );

    try {
      await client.ensureInitialized();
      expect(client.isInitialized).toBe(true);
      expect(client.hasCapability('hoverProvider')).toBe(true);
      expect(client.hasCapability('definitionProvider')).toBe(true);

      // No diagnostics initially
      const cleanDiags = await client.getDiagnostics(filePath);
      expect(cleanDiags).toEqual([]);

      // After file change, diagnostics should arrive via publishDiagnostics
      await writeFile(join(workspace, filePath), 'TYPE_ERROR\n', 'utf8');
      const errorDiags = await client.getDiagnostics(filePath);
      expect(errorDiags).toHaveLength(1);
      expect(errorDiags[0]?.message).toBe('Mock type error');

      const hover = await client.hover(filePath, { line: 0, character: 0 });
      expect(hover && 'contents' in hover).toBe(true);

      const defs = await client.definition(filePath, { line: 0, character: 0 });
      expect(defs).toHaveLength(1);
      expect(defs[0]?.range.start.line).toBe(2);

      const refs = await client.references(filePath, { line: 0, character: 0 });
      expect(refs).toHaveLength(2);

      const impls = await client.implementation(filePath, { line: 0, character: 0 });
      expect(impls).toHaveLength(1);
      expect(impls[0]?.range.start.line).toBe(8);

      const docSymbols = await client.documentSymbol(filePath);
      expect(docSymbols).toHaveLength(1);

      const workspaceSymbols = await client.workspaceSymbol('Mock');
      expect(workspaceSymbols).toHaveLength(1);
      expect(workspaceSymbols[0]?.name).toBe('MockSymbol');

      const items = await client.prepareCallHierarchy(filePath, { line: 0, character: 0 });
      expect(items).toHaveLength(1);
      expect(items[0]?.name).toBe('mockMethod');

      const incoming = await client.incomingCalls(items[0]!);
      expect(incoming).toHaveLength(1);
      expect(incoming[0]?.from.name).toBe('callerFn');

      const outgoing = await client.outgoingCalls(items[0]!);
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0]?.to.name).toBe('calleeFn');

      const actions = await client.codeActions(
        filePath,
        {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 10 },
        },
        { diagnostics: errorDiags },
      );
      expect(actions).toHaveLength(1);
      expect(actions[0]?.title).toBe('Mock quick fix');
    } finally {
      await client.shutdown();
    }
  });
});
