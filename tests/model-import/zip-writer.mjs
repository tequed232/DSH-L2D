/**
 * 测试专用 zip 构造器（zip-reader / model-import 测试夹具，不参与运行时）。
 *
 * 只支持测试需要的子集：stored / deflate、可注入非法字段（错误 CRC、伪造声明大小、
 * 加密位、任意原始文件名）用于打安全边界。
 */
import zlib from 'node:zlib';
import { crc32 } from '../../packages/dsh-l2d-plugin/lib/zip-reader.mjs';

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

/** 常规模型夹具：单根文件夹 + model3/moc3/贴图（嵌套布局，覆盖抬升逻辑）。 */
export function modelZip(modelName = 'demo-model') {
  return makeZip([
    { name: modelName + '/data/' + modelName + '.model3.json', data: JSON.stringify({ version: 3, FileReferences: { Moc: modelName + '.moc3' } }) },
    { name: modelName + '/data/' + modelName + '.moc3', data: Buffer.from('FAKEMOC3BYTES') },
    { name: modelName + '/data/texture00.png', data: Buffer.from('PNGDATA') },
    { name: modelName + '/README.txt', data: 'junk at zip root' },
  ]);
}
