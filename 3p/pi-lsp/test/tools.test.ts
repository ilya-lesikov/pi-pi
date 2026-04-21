import { describe, expect, test } from 'bun:test';

import { registerLspTool } from '../extensions/lsp/tools';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

function captureTool() {
  let tool: ToolDefinition<any, any> | null = null;
  const fakePi = {
    registerTool(def: ToolDefinition<any, any>) {
      tool = def;
    },
  };
  return {
    register(mgr: any) {
      registerLspTool(fakePi as any, mgr);
      if (!tool) throw new Error('Tool was not registered');
      return tool;
    },
  };
}

describe('unified lsp tool dispatch', () => {
  test('validates required params by operation', async () => {
    const { register } = captureTool();
    const tool = register({
      clientsForFile: () => [],
      clientForFileWithCapability: () => null,
      anyClient: () => null,
      getRootPath: () => '/repo',
    });

    await expect(
      tool.execute('1', { operation: 'hover' }, undefined as any, undefined, {} as any),
    ).rejects.toThrow("Operation 'hover' requires filePath");

    await expect(
      tool.execute('1', { operation: 'workspaceSymbol' }, undefined as any, undefined, {} as any),
    ).rejects.toThrow("Operation 'workspaceSymbol' requires query");
  });

  test('aggregates diagnostics from all matching clients', async () => {
    const { register } = captureTool();
    const tool = register({
      clientsForFile: () => [
        {
          config: { name: 'ts' },
          getDiagnostics: async () => [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
              severity: 1,
              source: 'ts',
              message: 'Type error',
            },
          ],
        },
        {
          config: { name: 'eslint' },
          getDiagnostics: async () => [
            {
              range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
              severity: 2,
              source: 'eslint',
              message: 'Lint warning',
            },
          ],
        },
      ],
      clientForFileWithCapability: () => null,
      anyClient: () => null,
      getRootPath: () => '/repo',
    });

    const result = await tool.execute(
      '1',
      { operation: 'diagnostics', filePath: 'src/app.ts' },
      undefined as any,
      undefined,
      {} as any,
    );

    const text = (result.content[0] as { text?: string } | undefined)?.text ?? '';
    expect(text).toContain('Diagnostics for src/app.ts: 1 error, 1 warning');
    expect(text).toContain('── ts ──');
    expect(text).toContain('── eslint ──');
    expect(result.details.groups).toEqual([
      { source: 'ts', count: 1 },
      { source: 'eslint', count: 1 },
    ]);
  });

  test('routes hover to first capable server and converts positions to zero-indexed', async () => {
    const calls: any[] = [];
    const { register } = captureTool();
    const tool = register({
      clientsForFile: () => [],
      clientForFileWithCapability: () => ({
        hover: async (filePath: string, pos: { line: number; character: number }) => {
          calls.push({ filePath, pos });
          return { contents: { kind: 'markdown', value: 'mock hover' } };
        },
      }),
      anyClient: () => null,
      getRootPath: () => '/repo',
    });

    const result = await tool.execute(
      '1',
      { operation: 'hover', filePath: '@src/app.ts', line: 5, character: 8 },
      undefined as any,
      undefined,
      {} as any,
    );

    expect(calls).toEqual([{ filePath: 'src/app.ts', pos: { line: 4, character: 7 } }]);
    expect((result.content[0] as { text?: string } | undefined)?.text).toContain(
      'Hover at src/app.ts:5:8',
    );
  });

  test('routes workspaceSymbol through anyClient', async () => {
    const { register } = captureTool();
    const tool = register({
      clientsForFile: () => [],
      clientForFileWithCapability: () => null,
      anyClient: () => ({
        workspaceSymbol: async (query: string) => [
          {
            name: `${query}Service`,
            kind: 5,
            location: {
              uri: 'file:///repo/src/service.ts',
              range: { start: { line: 9, character: 0 }, end: { line: 9, character: 5 } },
            },
            containerName: 'services',
          },
        ],
      }),
      getRootPath: () => '/repo',
    });

    const result = await tool.execute(
      '1',
      { operation: 'workspaceSymbol', query: 'User' },
      undefined as any,
      undefined,
      {} as any,
    );

    expect((result.content[0] as { text?: string } | undefined)?.text).toContain(
      'Workspace symbols matching "User"',
    );
    expect((result.content[0] as { text?: string } | undefined)?.text).toContain('UserService');
  });

  test('errors when no capable server is found', async () => {
    const { register } = captureTool();
    const tool = register({
      clientsForFile: () => [],
      clientForFileWithCapability: () => null,
      anyClient: () => null,
      getRootPath: () => '/repo',
    });

    await expect(
      tool.execute(
        '1',
        { operation: 'findReferences', filePath: 'src/app.ts', line: 1, character: 1 },
        undefined as any,
        undefined,
        {} as any,
      ),
    ).rejects.toThrow("No LSP server with 'findReferences' capability found for src/app.ts");
  });

  test('codeActions filters diagnostics to the requested line', async () => {
    const { register } = captureTool();
    const seenContexts: any[] = [];
    const tool = register({
      clientsForFile: () => [],
      clientForFileWithCapability: () => ({
        getDiagnostics: async () => [
          {
            range: { start: { line: 2, character: 0 }, end: { line: 2, character: 10 } },
            severity: 1,
            message: 'line 3 issue',
          },
          {
            range: { start: { line: 5, character: 0 }, end: { line: 5, character: 10 } },
            severity: 1,
            message: 'line 6 issue',
          },
        ],
        codeActions: async (_filePath: string, range: any, context: any) => {
          seenContexts.push({ range, context });
          return [{ title: 'Fix it', kind: 'quickfix' }];
        },
      }),
      anyClient: () => null,
      getRootPath: () => '/repo',
    });

    const result = await tool.execute(
      '1',
      { operation: 'codeActions', filePath: 'src/app.ts', line: 3, character: 1 },
      undefined as any,
      undefined,
      {} as any,
    );

    expect(seenContexts).toHaveLength(1);
    expect(seenContexts[0]?.range.start.line).toBe(2);
    expect(seenContexts[0]?.context.diagnostics).toHaveLength(1);
    expect(seenContexts[0]?.context.diagnostics[0]?.message).toBe('line 3 issue');
    expect((result.content[0] as { text?: string } | undefined)?.text).toContain(
      'Code actions at src/app.ts:3',
    );
  });
});
