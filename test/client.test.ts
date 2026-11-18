import { describe, expect, it } from 'vitest';
import { encodeBody } from '../src/client.js';

describe('encodeBody', () => {
  it('drops NUL from strings at any depth', () => {
    const text = encodeBody({ a: 'Net profit\u0000 (restated)', list: ['x\u0000y', { k: 'v\u0000' }], n: 12 });
    expect(text).not.toContain('\\u0000');
    expect(JSON.parse(text)).toEqual({ a: 'Net profit (restated)', list: ['xy', { k: 'v' }], n: 12 });
  });

  it('leaves a literal backslash-u0000 typed in the text alone', () => {
    expect(JSON.parse(encodeBody({ t: 'typed \\u0000 out' }))).toEqual({ t: 'typed \\u0000 out' });
  });

  it('encodes everything else as JSON.stringify does', () => {
    const value = { ok: true, xs: [1, 2, 3], none: null };
    expect(encodeBody(value)).toBe(JSON.stringify(value));
  });
});
