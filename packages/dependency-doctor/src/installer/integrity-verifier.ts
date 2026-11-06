/**
 * 完整性校验器（installer 层的安全闸）。
 * 下载/安装后的文件必须通过 SHA-256 校验；预期 hash 缺失时拒绝放行（fail-closed）。
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export function sha256File(path: string): string {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex');
}

export interface IntegrityVerdict {
  ok: boolean;
  reason?: string;
  actualSha256?: string;
  actualSizeBytes?: number;
}

/** 校验文件：hash 必须与预期一致；expectedSha256 缺失即拒绝。 */
export function verifyFileIntegrity(path: string, expectedSha256: string, expectedSizeBytes?: number): IntegrityVerdict {
  if (!expectedSha256) {
    return { ok: false, reason: '预期 SHA-256 缺失——来源不明文件不得放行（fail-closed）' };
  }
  let actual: string;
  let size: number;
  try {
    actual = sha256File(path);
    size = statSync(path).size;
  } catch (e) {
    return { ok: false, reason: `文件不可读：${String(e)}` };
  }
  if (expectedSizeBytes != null && size !== expectedSizeBytes) {
    return { ok: false, reason: `大小不符：预期 ${expectedSizeBytes}B，实际 ${size}B`, actualSha256: actual, actualSizeBytes: size };
  }
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
    return { ok: false, reason: 'SHA-256 不符（来源被篡改或下载不完整）', actualSha256: actual, actualSizeBytes: size };
  }
  return { ok: true, actualSha256: actual, actualSizeBytes: size };
}
