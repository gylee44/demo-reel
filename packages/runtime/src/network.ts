import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { AppError } from '../../../apps/api/src/security.ts';
export function isPublicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
export function publicUrl(value: string) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new AppError('URL_BLOCKED', '올바른 HTTPS 주소를 입력해 주세요.');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    (u.port && u.port !== '443') ||
    host.endsWith('.') ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    (ipaddr.isValid(host) && !isPublicAddress(host))
  )
    throw new AppError('URL_BLOCKED', '공개 HTTPS 주소만 연결할 수 있습니다.');
  return u;
}
export async function resolvePublic(host: string, resolver = lookup) {
  const results = await resolver(host.replace(/^\[|\]$/g, ''), { all: true });
  if (!results.length || results.some((x) => !isPublicAddress(x.address)))
    throw new AppError('URL_BLOCKED', '내부 네트워크 주소에는 연결할 수 없습니다.');
  return results[0];
}
