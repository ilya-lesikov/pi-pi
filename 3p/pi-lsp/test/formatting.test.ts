import { describe, expect, test } from 'bun:test';

import {
  formatCallHierarchy,
  formatCodeActions,
  formatDiagnostics,
  formatDocumentSymbols,
  formatHover,
  formatIncomingCalls,
  formatLocations,
  formatOutgoingCalls,
  formatWorkspaceSymbols,
} from '../extensions/lsp/formatting';

describe('formatting', () => {
  test('formats diagnostics across groups', () => {
    const text = formatDiagnostics('src/foo.ts', [
      {
        source: 'typescript',
        diagnostics: [
          {
            range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
            severity: 1,
            source: 'ts',
            code: 2322,
            message: 'Type string is not assignable to number',
          },
        ],
      },
      {
        source: 'eslint',
        diagnostics: [
          {
            range: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } },
            severity: 2,
            source: 'eslint',
            code: 'no-unused-vars',
            message: 'Unused variable',
          },
        ],
      },
    ]);

    expect(text).toContain('Diagnostics for src/foo.ts: 1 error, 1 warning');
    expect(text).toContain('── typescript ──');
    expect(text).toContain('Type string is not assignable to number');
    expect(text).toContain('── eslint ──');
  });

  test('formats hover and locations', () => {
    const hover = formatHover(
      { contents: { kind: 'markdown', value: '```ts\nconst foo: string\n```' } },
      'src/foo.ts',
      4,
      7,
    );
    expect(hover).toContain('Hover at src/foo.ts:5:8');
    expect(hover).toContain('const foo: string');

    const locations = formatLocations(
      [
        {
          uri: 'file:///repo/src/defs.ts',
          range: { start: { line: 9, character: 1 }, end: { line: 9, character: 6 } },
        },
      ],
      'Definition',
      'src/foo.ts',
      4,
      7,
      '/repo',
    );
    expect(locations).toContain('Definition for symbol at src/foo.ts:5:8');
    expect(locations).toContain('src/defs.ts:10:2');
  });

  test('formats symbols and hierarchy outputs', () => {
    const docSymbols = formatDocumentSymbols(
      [
        {
          name: 'Foo',
          kind: 5,
          range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
          selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
          children: [
            {
              name: 'bar',
              kind: 6,
              range: { start: { line: 2, character: 2 }, end: { line: 4, character: 2 } },
              selectionRange: { start: { line: 2, character: 2 }, end: { line: 2, character: 5 } },
            },
          ],
        },
      ],
      'src/foo.ts',
      '/repo',
    );
    expect(docSymbols).toContain('Symbols in src/foo.ts');
    expect(docSymbols).toContain('Foo (class)');
    expect(docSymbols).toContain('bar (method)');

    const wsSymbols = formatWorkspaceSymbols(
      [
        {
          name: 'FooService',
          kind: 5,
          location: {
            uri: 'file:///repo/src/service.ts',
            range: { start: { line: 11, character: 0 }, end: { line: 11, character: 10 } },
          },
          containerName: 'services',
        },
      ],
      'Foo',
      '/repo',
    );
    expect(wsSymbols).toContain('Workspace symbols matching "Foo"');
    expect(wsSymbols).toContain('FooService (class) src/service.ts:12 in services');
  });

  test('formats call hierarchy and code actions', () => {
    const item = {
      name: 'doThing',
      kind: 12,
      detail: 'Worker',
      uri: 'file:///repo/src/worker.ts',
      range: { start: { line: 5, character: 0 }, end: { line: 8, character: 0 } },
      selectionRange: { start: { line: 5, character: 2 }, end: { line: 5, character: 9 } },
    };

    const hierarchy = formatCallHierarchy([item], 'src/app.ts', 2, 4, '/repo');
    expect(hierarchy).toContain('Call hierarchy at src/app.ts:3:5');
    expect(hierarchy).toContain('doThing (function) src/worker.ts:6 — Worker');

    const incoming = formatIncomingCalls(
      [
        {
          from: {
            ...item,
            name: 'caller',
            uri: 'file:///repo/src/caller.ts',
          },
          fromRanges: [],
        },
      ],
      item,
      '/repo',
    );
    expect(incoming).toContain('Incoming calls to doThing');
    expect(incoming).toContain('caller (function) src/caller.ts:6');

    const outgoing = formatOutgoingCalls(
      [
        {
          to: {
            ...item,
            name: 'callee',
            uri: 'file:///repo/src/callee.ts',
          },
          fromRanges: [],
        },
      ],
      item,
      '/repo',
    );
    expect(outgoing).toContain('Outgoing calls from doThing');
    expect(outgoing).toContain('callee (function) src/callee.ts:6');

    const actions = formatCodeActions(
      [
        {
          title: 'Fix issue',
          kind: 'quickfix',
          isPreferred: true,
          edit: {
            changes: {
              'file:///repo/src/app.ts': [
                {
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
                  newText: 'done',
                },
              ],
            },
          },
        },
      ],
      'src/app.ts',
      0,
    );
    expect(actions).toContain('Code actions at src/app.ts:1');
    expect(actions).toContain('Fix issue [quickfix] ★ preferred');
  });
});
