/**
 * 零依赖 ZIP 读取器（model-import 管线的 validating/extracting 步）。
 *
 * 为什么不引第三方库（fflate/adm-zip）：
 *   - 仓库现有依赖里没有任何 zip 库（register.mjs 只处理已解压目录）；
 *   - dsh-l2d-plugin 有打包面（package.json dsh.bundle），新增第三方运行时依赖
 *     要过打包与供应链两道审查；而 Node 内置 zlib.inflateRawSync 已覆盖 zip 的
 *     两种主流压缩方法（stored=0 / deflate=8），解析 central directory 约 200 行。
 *
 * 安全设计（import 的不可信输入面）：
 *   - 只认无 ZIP64 的常规 zip（ZIP64 扩展直接报错，200MB 上限内用不到）；
 *   - 加密位（flags bit 0）→ encrypted 拒绝；
 *   - 条目名统一按路径校验：拒绝绝对路径、盘符、`..` 段、反斜杠穿越、NUL（zip-slip）；
 *   - 条目数 / 单条目解压后大小 / 总解压大小上限（zip 炸弹），上限在解压**前**按
 *     central directory 声明值检查，不先解压再数；
 *   - 解压后校验实际字节数与 CRC32，防声明值与实际不符的欺骗。
 *
 * 失败一律抛 ZipError（code 供路由/管线映射友好文案），绝不返回部分数据。
 */
import zlib from 'node:zlib';

export const ZIP_ENTRY_DEFAULT_LIMITS = Object.freeze({
  maxEntries: 4000,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
});

export class ZipError extends Error {
  /**
   * @param {string} code not-zip | zip64-unsupported | encrypted | unsupported-method
   *                      | zip-slip | too-many-entries | too-large | corrupt
   * @param {string} message 中文、面向用户可读
   * @param {object} [detail] 附加字段（如条目名）
   */
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

const EOCD_SIG = 0x06054b50;
const CD_ENTRY_SIG = 0x02014b50;
const LOCAL_HEADER_SIG = 0x04034b50;

/** CRC32（IEEE 802.3，zip 标准）：解压后完整性校验。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export { crc32 };

/**
 * 条目名安全校验：统一按 `/` 分隔（zip 规范用 `/`，但 Windows 压缩器可能写 `\`）。
 * 拒绝：绝对路径、盘符、`..` 段、空段穿越、NUL。返回归一化后的相对路径。
 * @throws ZipError('zip-slip')
 */
export function safeEntryName(rawName) {
  const name = String(rawName).replaceAll('\\', '/');
  if (name.includes('\0')) throw new ZipError('zip-slip', '压缩包内含非法文件名（NUL 字符）', { name: rawName });
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new ZipError('zip-slip', '压缩包内含绝对路径条目，已拒绝：' + rawName, { name: rawName });
  }
  const segments = name.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      throw new ZipError('zip-slip', '压缩包内含路径穿越条目（..），已拒绝：' + rawName, { name: rawName });
    }
  }
  const clean = segments.filter((s) => s.length > 0).join('/');
  if (!clean) throw new ZipError('zip-slip', '压缩包内含空文件名条目', { name: rawName });
  return clean;
}

/**
 * 解析 central directory 并解出全部文件条目。
 * @param {Buffer|Uint8Array} data zip 原始字节
 * @param {{maxEntries?: number, maxTotalUncompressedBytes?: number}} [limits]
 * @returns {Array<{name: string, data: Buffer}>} 仅文件条目（目录条目跳过），name 已归一化
 * @throws ZipError
 */
export function readZipEntries(data, limits = {}) {
  const maxEntries = Math.max(1, Math.floor(Number(limits.maxEntries) || ZIP_ENTRY_DEFAULT_LIMITS.maxEntries));
  const maxTotal = Math.max(1, Math.floor(Number(limits.maxTotalUncompressedBytes) || ZIP_ENTRY_DEFAULT_LIMITS.maxTotalUncompressedBytes));
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

  if (buf.length < 22 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new ZipError('not-zip', '不是合法的 zip 文件（缺少 PK 魔数）');
  }

  // EOCD：从尾部向前扫签名（注释最长 65535 字节）。
  let eocd = -1;
  const scanStart = Math.max(0, buf.length - (22 + 65535));
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('not-zip', '不是合法的 zip 文件（找不到中央目录结尾记录）');

  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new ZipError('zip64-unsupported', '不支持 ZIP64 格式的压缩包');
  }
  if (entryCount > maxEntries) {
    throw new ZipError('too-many-entries', `压缩包条目数超过上限（${entryCount} > ${maxEntries}）`);
  }
  if (cdOffset + cdSize > buf.length) {
    throw new ZipError('corrupt', 'zip 中央目录越界（文件可能被截断）');
  }

  const entries = [];
  let totalUncompressed = 0;
  let off = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CD_ENTRY_SIG) {
      throw new ZipError('corrupt', 'zip 中央目录条目损坏');
    }
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const compressedSize = buf.readUInt32LE(off + 20);
    const uncompressedSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    const rawName = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) {
      throw new ZipError('encrypted', '压缩包已加密，不支持导入', { name: rawName });
    }
    if (rawName.endsWith('/')) continue; // 目录条目
    const name = safeEntryName(rawName);
    if (uncompressedSize > maxTotal || totalUncompressed + uncompressedSize > maxTotal) {
      throw new ZipError('too-large', `压缩包解压后总大小超过上限（${Math.round(maxTotal / 1024 / 1024)}MB）`, { name });
    }

    // local header：名字与 extra 长度以 local 为准（流式 zip 两者可能不同）。
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_HEADER_SIG) {
      throw new ZipError('corrupt', 'zip 本地文件头损坏：' + name);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) {
      throw new ZipError('corrupt', 'zip 条目数据被截断：' + name);
    }
    const raw = buf.subarray(dataStart, dataEnd);
    let out;
    if (method === 0) {
      out = Buffer.from(raw); // stored：复制一份，避免持有整个 zip 的大视图
    } else if (method === 8) {
      try {
        out = zlib.inflateRawSync(raw);
      } catch {
        throw new ZipError('corrupt', 'zip 条目解压失败（数据损坏）：' + name);
      }
    } else {
      throw new ZipError('unsupported-method', '压缩包使用了不支持的压缩方法（method=' + method + '）：' + name, { name });
    }
    if (out.length !== uncompressedSize) {
      throw new ZipError('corrupt', `zip 条目解压后大小与声明不符：${name}（${out.length} ≠ ${uncompressedSize}）`);
    }
    if (crc !== 0 && crc32(out) !== crc) {
      throw new ZipError('corrupt', 'zip 条目 CRC 校验失败：' + name);
    }
    totalUncompressed += out.length;
    entries.push({ name, data: out });
  }
  return entries;
}
