import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LspClient } from '../extensions/lsp/client';

const cleanup: string[] = [];

async function makeFixtureWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-lsp-ts-fixture-'));
  cleanup.push(dir);
  await mkdir(join(dir, 'src'), { recursive: true });

  await writeFile(
    join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
    'utf8',
  );

  await writeFile(
    join(dir, 'src', 'shapes.ts'),
    [
      'export interface Shape {',
      '  area(): number;',
      '}',
      '',
      'export class Circle implements Shape {',
      '  constructor(private radius: number) {}',
      '',
      '  area(): number {',
      '    return Math.PI * this.radius * this.radius;',
      '  }',
      '}',
      '',
      'export function useShape(shape: Shape): number {',
      '  return shape.area();',
      '}',
      '',
      'export const broken: number = "oops";',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    join(dir, 'src', 'main.ts'),
    [
      'import { Circle, useShape } from "./shapes";',
      '',
      'const circle = new Circle(2);',
      'export const areaValue = useShape(circle);',
      '',
    ].join('\n'),
    'utf8',
  );

  return dir;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('real TypeScript integration', () => {
  test('typescript-language-server resolves diagnostics and navigation in a fixture workspace', async () => {
    const workspace = await makeFixtureWorkspace();
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const tsServerBin = join(packageRoot, 'node_modules', '.bin', 'typescript-language-server');

    const client = new LspClient(
      {
        name: 'typescript',
        command: tsServerBin,
        args: ['--stdio'],
        extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
        env: {},
        initializationOptions: {},
      },
      workspace,
    );

    try {
      await client.ensureInitialized();

      const diagnostics = await client.getDiagnostics('src/shapes.ts');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics.some((d) => d.message.toLowerCase().includes('string'))).toBe(true);

      await new Promise((r) => setTimeout(r, 1000));

      const hover = await client.hover('src/main.ts', { line: 2, character: 18 });
      const hoverText =
        hover && typeof hover.contents !== 'string' && 'value' in hover.contents
          ? hover.contents.value
          : JSON.stringify(hover?.contents ?? '');
      expect(hoverText.toLowerCase()).toContain('circle');

      const defs = await client.definition('src/main.ts', { line: 3, character: 25 });
      expect(defs.length).toBeGreaterThan(0);
      expect(defs.some((d) => d.uri.endsWith('/src/shapes.ts'))).toBe(true);

      const refs = await client.references('src/shapes.ts', { line: 12, character: 20 });
      expect(refs.length).toBeGreaterThan(1);
      expect(refs.some((r) => r.uri.endsWith('/src/main.ts'))).toBe(true);

      const impls = await client.implementation('src/shapes.ts', { line: 0, character: 17 });
      expect(impls.length).toBeGreaterThan(0);
      expect(impls.some((i) => i.uri.endsWith('/src/shapes.ts'))).toBe(true);

      const docSymbols = await client.documentSymbol('src/shapes.ts');
      expect(docSymbols.length).toBeGreaterThan(0);

      const workspaceSymbols = await client.workspaceSymbol('Circle');
      expect(workspaceSymbols.length).toBeGreaterThan(0);
      expect(workspaceSymbols.some((s) => s.name === 'Circle')).toBe(true);

      const hierarchyItems = await client.prepareCallHierarchy('src/shapes.ts', {
        line: 12,
        character: 16,
      });
      expect(hierarchyItems.length).toBeGreaterThan(0);

      const incoming = await client.incomingCalls(hierarchyItems[0]!);
      expect(incoming.length).toBeGreaterThan(0);

      const outgoing = await client.outgoingCalls(hierarchyItems[0]!);
      expect(outgoing.length).toBeGreaterThan(0);

      const codeActions = await client.codeActions(
        'src/shapes.ts',
        {
          start: { line: 16, character: 0 },
          end: { line: 16, character: 100 },
        },
        { diagnostics },
      );
      expect(Array.isArray(codeActions)).toBe(true);
    } finally {
      await client.shutdown();
    }
  }, 30000);
});
