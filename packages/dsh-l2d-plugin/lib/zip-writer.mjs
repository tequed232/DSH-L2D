/**
 * zip 构造器（运行时库，零依赖）：模型导出接口用它把模型目录打成可回导的 zip。
 *
 * 与 lib/zip-reader.mjs 配套（读写同源，crc32 实现共用一份）。
 * 支持 stored / deflate 两种压缩方法，并允许注入字段以便安全测试：
 *  - corruptCrc / declaredUncompressedSize / encrypted / rawName（任意原始条目名）。
 *
 * 导出接口（lib/model-export.mjs）默认一率 deflate；测试夹具常用 stored 便于断言原文。
 * 写入条目名一律用正斜杠相对路径——保证导出物经 POST /dsh-l2d/models/import 可原样回导。
 */
import zlib from 'node:zlib';
import { crc32 } from './zip-reader.mjs';

/**
 * @param {Array<{name?: string, rawName?: string, data?: Buffer|string,
 *                 method?: 'stored'|'deflate', corruptCrc?: boolean,
 *                 declaredUncompressedSize?: number, encrypted?: boolean}>} entries
 * @returns {Buffer}
 */
export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.rawName ?? entry.name ?? '', 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const method = entry.method === 'deflate' ? 8 : 0;
    const payload = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = entry.corruptCrc ? (crc32(raw) ^ 0xffffffff) >>> 0 : crc32(raw);
    const flags = entry.encrypted ? 0x1 : 0;
    const declaredUncompressed = entry.declaredUncompressedSize ?? raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(declaredUncompressed, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(declaredUncompressed, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}
