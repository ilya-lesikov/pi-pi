type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: any;
};

type JsonRpcNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: any;
};

const capabilities = {
  textDocumentSync: 2,
  hoverProvider: true,
  definitionProvider: true,
  referencesProvider: true,
  implementationProvider: true,
  documentSymbolProvider: true,
  workspaceSymbolProvider: true,
  callHierarchyProvider: true,
  codeActionProvider: true,
};

let buffer = Buffer.alloc(0);
let lastUri = 'file:///mock.ts';
let preparedItem: any = null;

function writeMessage(message: unknown) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

function sendResponse(id: number, result: unknown) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function sendDiagnostics(uri: string, text: string) {
  const diagnostics = text.includes('TYPE_ERROR')
    ? [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 10 },
          },
          severity: 1,
          source: 'mock-lsp',
          code: 'MOCK001',
          message: 'Mock type error',
        },
      ]
    : [];

  writeMessage({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: { uri, diagnostics },
  });
}

function handleRequest(req: JsonRpcRequest) {
  switch (req.method) {
    case 'initialize':
      return sendResponse(req.id, { capabilities });
    case 'shutdown':
      return sendResponse(req.id, null);
    case 'textDocument/hover':
      return sendResponse(req.id, {
        contents: {
          kind: 'markdown',
          value: '```ts\nconst mockSymbol: string\n```\n\nMock hover docs.',
        },
      });
    case 'textDocument/definition':
      return sendResponse(req.id, [
        {
          uri: lastUri,
          range: {
            start: { line: 2, character: 4 },
            end: { line: 2, character: 14 },
          },
        },
      ]);
    case 'textDocument/references':
      return sendResponse(req.id, [
        {
          uri: lastUri,
          range: {
            start: { line: 2, character: 4 },
            end: { line: 2, character: 14 },
          },
        },
        {
          uri: lastUri,
          range: {
            start: { line: 5, character: 2 },
            end: { line: 5, character: 12 },
          },
        },
      ]);
    case 'textDocument/implementation':
      return sendResponse(req.id, [
        {
          uri: lastUri,
          range: {
            start: { line: 8, character: 1 },
            end: { line: 8, character: 9 },
          },
        },
      ]);
    case 'textDocument/documentSymbol':
      return sendResponse(req.id, [
        {
          name: 'MockClass',
          kind: 5,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 10, character: 0 },
          },
          selectionRange: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 15 },
          },
          children: [
            {
              name: 'mockMethod',
              kind: 6,
              range: {
                start: { line: 2, character: 2 },
                end: { line: 4, character: 2 },
              },
              selectionRange: {
                start: { line: 2, character: 2 },
                end: { line: 2, character: 12 },
              },
            },
          ],
        },
      ]);
    case 'workspace/symbol':
      return sendResponse(req.id, [
        {
          name: 'MockSymbol',
          kind: 12,
          location: {
            uri: lastUri,
            range: {
              start: { line: 3, character: 0 },
              end: { line: 3, character: 10 },
            },
          },
          containerName: 'MockClass',
        },
      ]);
    case 'textDocument/prepareCallHierarchy':
      preparedItem = {
        name: 'mockMethod',
        kind: 6,
        detail: 'MockClass',
        uri: lastUri,
        range: {
          start: { line: 2, character: 2 },
          end: { line: 4, character: 2 },
        },
        selectionRange: {
          start: { line: 2, character: 2 },
          end: { line: 2, character: 12 },
        },
      };
      return sendResponse(req.id, [preparedItem]);
    case 'callHierarchy/incomingCalls':
      return sendResponse(req.id, [
        {
          from: {
            name: 'callerFn',
            kind: 12,
            uri: lastUri,
            range: {
              start: { line: 20, character: 0 },
              end: { line: 22, character: 0 },
            },
            selectionRange: {
              start: { line: 20, character: 9 },
              end: { line: 20, character: 17 },
            },
          },
          fromRanges: [
            {
              start: { line: 21, character: 4 },
              end: { line: 21, character: 14 },
            },
          ],
        },
      ]);
    case 'callHierarchy/outgoingCalls':
      return sendResponse(req.id, [
        {
          to: {
            name: 'calleeFn',
            kind: 12,
            uri: lastUri,
            range: {
              start: { line: 30, character: 0 },
              end: { line: 32, character: 0 },
            },
            selectionRange: {
              start: { line: 30, character: 9 },
              end: { line: 30, character: 17 },
            },
          },
          fromRanges: [
            {
              start: { line: 3, character: 4 },
              end: { line: 3, character: 12 },
            },
          ],
        },
      ]);
    case 'textDocument/codeAction':
      return sendResponse(req.id, [
        {
          title: 'Mock quick fix',
          kind: 'quickfix',
          isPreferred: true,
          edit: {
            changes: {
              [lastUri]: [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 10 },
                  },
                  newText: 'fixedValue',
                },
              ],
            },
          },
        },
      ]);
    default:
      return sendResponse(req.id, null);
  }
}

function handleNotification(msg: JsonRpcNotification) {
  if (msg.method === 'textDocument/didOpen' || msg.method === 'textDocument/didChange') {
    const textDocument =
      msg.method === 'textDocument/didOpen' ? msg.params?.textDocument : msg.params?.textDocument;
    const text =
      msg.method === 'textDocument/didOpen'
        ? (msg.params?.textDocument?.text ?? '')
        : (msg.params?.contentChanges?.[0]?.text ?? '');
    lastUri = textDocument?.uri ?? lastUri;
    sendDiagnostics(lastUri, text);
  }

  if (msg.method === 'exit') {
    process.exit(0);
  }
}

function handleMessage(message: JsonRpcRequest | JsonRpcNotification) {
  if ('id' in message) return handleRequest(message);
  return handleNotification(message);
}

function drainBuffer() {
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    const header = buffer.subarray(0, headerEnd).toString('ascii');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }

    const contentLength = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (buffer.length < bodyEnd) return;

    const body = buffer.subarray(bodyStart, bodyEnd).toString('utf8');
    buffer = buffer.subarray(bodyEnd);
    handleMessage(JSON.parse(body));
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
  drainBuffer();
});
