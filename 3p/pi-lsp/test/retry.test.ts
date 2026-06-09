import { describe, expect, test } from 'bun:test';

import { withRetry } from '../extensions/lsp/retry';

describe('withRetry', () => {
  test('returns immediately when result is not empty', async () => {
    let callCount = 0;
    const result = await withRetry(
      async () => {
        callCount++;
        return [1, 2, 3];
      },
      (r) => r.length === 0,
      { maxRetries: 2, delayMs: 10 },
    );

    expect(result).toEqual([1, 2, 3]);
    expect(callCount).toBe(1);
  });

  test('retries until result is not empty', async () => {
    let callCount = 0;
    const result = await withRetry(
      async () => {
        callCount++;
        return callCount >= 3 ? ['found'] : [];
      },
      (r) => r.length === 0,
      { maxRetries: 3, delayMs: 10 },
    );

    expect(result).toEqual(['found']);
    expect(callCount).toBe(3);
  });

  test('stops at maxRetries and returns last empty result', async () => {
    let callCount = 0;
    const result = await withRetry(
      async () => {
        callCount++;
        return [];
      },
      (r) => r.length === 0,
      { maxRetries: 2, delayMs: 10 },
    );

    expect(result).toEqual([]);
    expect(callCount).toBe(3); // 1 initial + 2 retries
  });

  test('works with null isEmpty check', async () => {
    let callCount = 0;
    const result = await withRetry(
      async () => {
        callCount++;
        return callCount >= 2 ? { value: 'ok' } : null;
      },
      (r) => r === null,
      { maxRetries: 3, delayMs: 10 },
    );

    expect(result).toEqual({ value: 'ok' });
    expect(callCount).toBe(2);
  });

  test('uses default options when not provided', async () => {
    let callCount = 0;
    const result = await withRetry(
      async () => {
        callCount++;
        return 'immediate';
      },
      (r) => r === '',
    );

    expect(result).toBe('immediate');
    expect(callCount).toBe(1);
  });
});
