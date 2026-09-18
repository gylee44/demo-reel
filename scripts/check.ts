import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const checks = [['typecheck'], ['test']];
if (existsSync('apps/web/src/main.tsx')) checks.push(['build']);
if (existsSync('playwright.config.ts')) checks.push(['test:e2e']);
const results = [];
for (const args of checks) {
  const started = Date.now();
  // Windows resolves pnpm only as pnpm.cmd, which Node refuses to spawn without a shell (CVE-2024-27980).
  const result = spawnSync('pnpm', args, { stdio: 'inherit', env: process.env, shell: true });
  results.push({ check: args[0], exitCode: result.status, durationMs: Date.now() - started });
  if (result.status !== 0) break;
}
mkdirSync('output/checks', { recursive: true });
writeFileSync(
  `output/checks/${new Date().toISOString().replaceAll(':', '-')}.json`,
  JSON.stringify(results, null, 2),
);
if (results.some((r) => r.exitCode !== 0) || results.length !== checks.length) process.exit(1);
