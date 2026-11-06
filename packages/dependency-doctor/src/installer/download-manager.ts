/**
 * 下载管理器：只允许下载 registry 登记的官方来源文件，且必须携带 SHA-256 预期值。
 * 未经授权不执行；下载后由 integrity-verifier 校验。
 */
import { createWriteStream } from 'node:fs';
import { statSync, unlinkSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, resolve } from 'node:path';
import { verifyFileIntegrity } from './integrity-verifier.ts';

export interface DownloadRequest {
  url: string;
  targetPath: string; // 绝对路径
  expectedSha256: string;
  expectedSizeBytes?: number;
}

const OFFICIAL_HOST_ALLOWLIST = new Set(['www.live2d.com', 'live2d.com']);

export function isOfficialSource(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return OFFICIAL_HOST_ALLOWLIST.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * 执行下载（调用方必须已完成授权闸校验）。
 * 安全约束：仅 https 官方域；SHA-256 校验失败即删除落盘文件并报错。
 */
export async function downloadFile(req: DownloadRequest, fetchImpl: typeof fetch = globalThis.fetch): Promise<void> {
  if (!isOfficialSource(req.url)) {
    throw new Error(`非官方来源，拒绝下载：${req.url}`);
  }
  if (!req.expectedSha256) {
    throw new Error('预期 SHA-256 缺失：拒绝下载（fail-closed）');
  }
  const res = await fetchImpl(req.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const tmpPath = req.targetPath + '.part';
  try {
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tmpPath));
    const verdict = verifyFileIntegrity(tmpPath, req.expectedSha256, req.expectedSizeBytes);
    if (!verdict.ok) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      throw new Error(`完整性校验失败：${verdict.reason}`);
    }
    // 校验通过才落正式路径（不覆盖用户已配置文件的决策在调用方 planRepair/宿主层）
    const { renameSync } = await import('node:fs');
    renameSync(tmpPath, req.targetPath);
  } catch (e) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw e;
  }
}

/** 展示用：目标路径与大小预估（安装前必须向用户展示）。 */
export function describeTarget(rootDir: string, relativePath: string, sizeBytes?: number): string {
  const abs = resolve(join(rootDir, relativePath));
  return `${abs}${sizeBytes != null ? `（约 ${Math.round(sizeBytes / 1024)} KB）` : ''}`;
}
