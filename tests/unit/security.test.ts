import { it, expect } from 'vitest';
import { encrypt, decrypt, hash, equal, validatePocTarget } from '../../apps/api/src/security.ts';
const key = 'ab'.repeat(32);
it('encrypts authentication with integrity protection and random nonces', () => {
  const a = encrypt({ password: 'test-secret' }, key),
    b = encrypt({ password: 'test-secret' }, key);
  expect(a).not.toBe(b);
  expect(a).not.toContain('test-secret');
  expect(decrypt(a, key)).toEqual({ password: 'test-secret' });
  const bytes = Buffer.from(a, 'base64');
  bytes[bytes.length - 1] ^= 1;
  expect(() => decrypt(bytes.toString('base64'), key)).toThrow();
});
it('hashes JSON independent of object key order, preserving array order', () => {
  expect(hash({ a: 1, b: 2 })).toBe(hash({ b: 2, a: 1 }));
  expect(hash([1, 2])).not.toBe(hash([2, 1]));
});
it('compares tokens without accepting a prefix', () => {
  expect(equal('abc', 'abc')).toBe(true);
  expect(equal('abc', 'ab')).toBe(false);
});
it.each([
  'http://127.0.0.1:4000',
  'http://169.254.169.254',
  'http://user:pass@127.0.0.1:4001',
  'file:///etc/passwd',
  'https://example.com',
])('rejects unconfigured PoC target %s', (value) =>
  expect(() => validatePocTarget(value, 'http://127.0.0.1:4001')).toThrow(),
);
