import { beforeAll, afterAll, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { config } from '../../apps/api/src/config.ts';
import {
  artifactUrl,
  uploadArtifact,
  materializeArtifact,
} from '../../packages/runtime/src/storage.ts';
import { startEgressProxy } from '../../apps/worker/src/egress.ts';
import type { Artifact } from '../../apps/api/src/models.ts';
const cfg = config(),
  name = `storage-test-${randomUUID()}`,
  dir = join(cfg.dataDir, name);
let server: ReturnType<typeof createServer>,
  stored = Buffer.alloc(0),
  signed = false;
beforeAll(async () => {
  await mkdir(dir, { recursive: true });
  server = createServer(async (req, res) => {
    signed = !!req.headers.authorization?.startsWith('AWS4-HMAC-SHA256');
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      stored = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'aws-chunked') {
        const decoded: Buffer[] = [];
        let pos = 0;
        while (pos < stored.length) {
          const end = stored.indexOf('\r\n', pos);
          const size = parseInt(stored.subarray(pos, end).toString(), 16);
          if (!size) break;
          decoded.push(stored.subarray(end + 2, end + 2 + size));
          pos = end + 2 + size + 2;
        }
        stored = Buffer.concat(decoded);
      }
      res.end();
    } else {
      res.setHeader('Content-Length', stored.length);
      res.end(stored);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cfg.s3 = {
    endpoint: `http://127.0.0.1:${(server.address() as any).port}`,
    region: 'us-east-1',
    bucket: 'private-artifacts',
    accessKeyId: 'TEST_ONLY',
    secretAccessKey: 'TEST_ONLY_SECRET',
  };
});
afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});
it('uploads signed S3 requests, issues expiring links and restores a lost local clip with checksum verification', async () => {
  const bytes = Buffer.from('test media payload');
  const path = join(dir, 'clip.mp4');
  await writeFile(path, bytes);
  const artifact: Artifact = {
    artifactId: `artifact_${randomUUID()}`,
    owner: 'test-owner',
    jobId: 'job-test',
    kind: 'final',
    path,
    mimeType: 'video/mp4',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  artifact.objectKey = await uploadArtifact(cfg, artifact);
  expect(stored.equals(bytes)).toBe(true);
  expect(signed).toBe(true);
  const url = new URL(await artifactUrl(cfg, artifact));
  expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  expect(url.href).not.toContain('TEST_ONLY_SECRET');
  const cached = await materializeArtifact(cfg, artifact);
  expect(await readFile(cached, 'utf8')).toBe(bytes.toString());
  await rm(cached);
  stored = Buffer.from('corrupted');
  await expect(materializeArtifact(cfg, artifact)).rejects.toMatchObject({
    code: 'STORAGE_FAILED',
  });
  artifact.expiresAt = new Date(0).toISOString();
  await expect(materializeArtifact(cfg, artifact)).rejects.toMatchObject({ code: 'EXPIRED' });
});
it('denies loopback CONNECT tunnels before any upstream connection', async () => {
  const proxy = await startEgressProxy();
  try {
    const u = new URL(proxy.url);
    const result = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(u.port), u.hostname, () =>
        socket.write('CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n'),
      );
      socket.once('data', (data) => {
        resolve(data.toString());
        socket.destroy();
      });
      socket.once('error', reject);
      socket.setTimeout(3000, () => {
        socket.destroy();
        reject(Error('timeout'));
      });
    });
    expect(result).toContain('403 Forbidden');
  } finally {
    proxy.close();
  }
});
