/**
 * 图库读取装配（GALLERY-BRIDGE §4.3）：listTopGalleryItems 结果 → 定位 GALLERY_DIR
 * 文件 → base64（供 MCP image content）。
 *
 * 护栏（裁决书 §4.4，用户最高优先级）：
 *  - 单图 base64 后 > 2MB 跳过（标记 oversized，不 500）；
 *  - 文件缺失/魔数不符跳过（标记 fileMissing，不 500）；
 *  - 一次响应图片总数上限 3 由 mcp-tools 的 limit clamp 保证；
 *  - 无 score 数据 → 上层返回空集 + 提示，不退化为全量随机。
 *
 * 依赖注入：db 经 listTopGalleryItems（repo 唯一读入口），fsImpl 可注入（测试）。
 */
import path from 'node:path';
import { listTopGalleryItems } from '../dsh-l2d-db/src/gallery-repo.mjs';

const OVERSIZE_BASE64_BYTES = 2 * 1024 * 1024;

function sniffMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * @param {{db: object, galleryDir: string, fsImpl?: object}} deps
 * @returns {{top: (emotion?: string, limit?: number) => Promise<Array<object>>}}
 */
export function createGallerySource({ db, galleryDir, fsImpl }) {
  if (!db || typeof db.prepare !== 'function') throw new Error('createGallerySource: db 必填');
  if (typeof galleryDir !== 'string' || !galleryDir) throw new Error('createGallerySource: galleryDir 必填');
  const fs = fsImpl || { readFileSync: (p) => import('node:fs').then((m) => m.readFileSync(p)) };
  return {
    async top(emotion, limit = 3) {
      const rows = listTopGalleryItems(db, { emotion, limit });
      return rows.map((row) => {
        const out = { ...row, base64: null, mimeType: null, fileMissing: false, oversized: false };
        // 文件名白名单化：拒绝路径穿越（只允许 basename）
        if (typeof row.fileName !== 'string' || row.fileName !== path.basename(row.fileName)) {
          out.fileMissing = true;
          return out;
        }
        let buf;
        try {
          buf = fs.readFileSync(path.join(galleryDir, row.fileName));
        } catch {
          out.fileMissing = true;
          return out;
        }
        const mime = sniffMime(buf);
        if (!mime) {
          out.fileMissing = true; // 魔数不符 = 非图片内容，按缺失处理，不投喂 Agent
          return out;
        }
        out.mimeType = mime;
        out.base64 = buf.toString('base64');
        if (out.base64.length * 3 / 4 > OVERSIZE_BASE64_BYTES) {
          out.oversized = true;
          out.base64 = null; // 护栏：单图 >2MB 跳过，不进响应
        }
        return out;
      });
    },
  };
}
