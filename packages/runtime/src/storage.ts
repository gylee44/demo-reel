import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream } from 'node:fs';
import { mkdir, stat, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import type { Config } from '../../../apps/api/src/config.ts';
import type { Artifact } from '../../../apps/api/src/models.ts';
import { AppError } from '../../../apps/api/src/security.ts';
export function storageReady(cfg: Config) {
  return !!(cfg.s3.bucket && cfg.s3.accessKeyId && cfg.s3.secretAccessKey);
}
function client(cfg: Config) {
  if (!storageReady(cfg))
    throw new AppError('STORAGE_NOT_CONFIGURED', '영상 저장소 연결 설정이 필요합니다.', 503);
  return new S3Client({
    endpoint: cfg.s3.endpoint,
    region: cfg.s3.region,
    credentials: { accessKeyId: cfg.s3.accessKeyId, secretAccessKey: cfg.s3.secretAccessKey },
    forcePathStyle: !!cfg.s3.endpoint,
    maxAttempts: 2,
  });
}
export async function uploadArtifact(cfg: Config, artifact: Artifact) {
  const s3 = client(cfg);
  const key = `artifacts/${artifact.owner}/${artifact.artifactId}`;
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: cfg.s3.bucket,
        Key: key,
        Body: createReadStream(artifact.path),
        ContentLength: (await stat(artifact.path)).size,
        ContentType: artifact.mimeType,
        Metadata: { sha256: artifact.sha256 },
        CacheControl: 'private, no-store',
      }),
    );
    return key;
  } catch {
    throw new AppError(
      'STORAGE_FAILED',
      '영상 저장에 실패했습니다. 잠시 후 다시 시도해 주세요.',
      502,
    );
  } finally {
    s3.destroy();
  }
}
export async function artifactUrl(cfg: Config, artifact: Artifact, seconds = 300) {
  if (!artifact.objectKey) throw new AppError('NOT_FOUND', '저장된 파일을 찾지 못했습니다.', 404);
  const s3 = client(cfg);
  try {
    return await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: cfg.s3.bucket,
        Key: artifact.objectKey,
        ResponseContentType: artifact.mimeType,
        ResponseContentDisposition: `inline; filename="${artifact.artifactId}.${artifact.mimeType === 'video/mp4' ? 'mp4' : 'bin'}"`,
      }),
      { expiresIn: seconds },
    );
  } finally {
    s3.destroy();
  }
}
export async function materializeArtifact(cfg: Config, artifact: Artifact) {
  if (Date.parse(artifact.expiresAt) <= Date.now())
    throw new AppError('EXPIRED', '클립 보관 기간이 지났습니다.', 410);
  const path = artifact.objectKey
    ? join(cfg.dataDir, 'cache', artifact.artifactId)
    : resolve(artifact.path);
  if (!path.startsWith(resolve(cfg.dataDir) + sep))
    throw new AppError('NOT_FOUND', '파일을 찾을 수 없습니다.', 404);
  const matches = async () => {
    try {
      return (
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex') === artifact.sha256
      );
    } catch {
      return false;
    }
  };
  if (await matches()) return path;
  if (!artifact.objectKey)
    throw new AppError('RENDER_FAILED', '저장된 클립이 없거나 손상되었습니다.');
  const s3 = client(cfg);
  try {
    const result = await s3.send(
      new GetObjectCommand({ Bucket: cfg.s3.bucket, Key: artifact.objectKey }),
    );
    if (!result.Body) throw Error('Empty storage response');
    const bytes = await result.Body.transformToByteArray();
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
      throw Error('Checksum mismatch');
    await mkdir(join(cfg.dataDir, 'cache'), { recursive: true });
    await writeFile(path, bytes, { mode: 0o600 });
    return path;
  } catch {
    throw new AppError('STORAGE_FAILED', '보관한 클립을 불러오지 못했습니다.', 502);
  } finally {
    s3.destroy();
  }
}
export async function deleteStoredArtifact(cfg: Config, artifact: Artifact) {
  if (!artifact.objectKey) return;
  const s3 = client(cfg);
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: cfg.s3.bucket, Key: artifact.objectKey }));
  } finally {
    s3.destroy();
  }
}
