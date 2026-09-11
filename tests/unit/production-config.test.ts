import { it, expect, vi, afterEach } from 'vitest';
import { config } from '../../apps/api/src/config.ts';
afterEach(() => vi.unstubAllEnvs());
function production() {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('POC_MODE', 'false');
  vi.stubEnv('DATABASE_URL', 'postgres://test@db/test');
  vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
  vi.stubEnv('WEB_ORIGIN', 'https://studio.example.org');
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('S3_ENDPOINT', '');
}
it('forbids fixed PoC in production', () => {
  production();
  vi.stubEnv('POC_MODE', 'true');
  expect(() => config()).toThrow('POC_MODE');
});
it('requires a stable encryption key and DB in production', () => {
  production();
  vi.stubEnv('ENCRYPTION_KEY', '');
  expect(() => config()).toThrow('ENCRYPTION_KEY');
});
it('requires HTTPS for production session cookies and storage credentials', () => {
  production();
  vi.stubEnv('WEB_ORIGIN', 'http://example.org');
  expect(() => config()).toThrow('WEB_ORIGIN');
  vi.stubEnv('WEB_ORIGIN', 'https://example.org');
  vi.stubEnv('S3_ENDPOINT', 'http://storage.example.org');
  expect(() => config()).toThrow('S3_ENDPOINT');
});
it('keeps the provider key blank instead of silently using fixtures', () => {
  production();
  const cfg = config();
  expect(cfg.pocMode).toBe(false);
  expect(cfg.openaiKey).toBe('');
  expect(cfg.webOrigin).toBe('https://studio.example.org');
});
