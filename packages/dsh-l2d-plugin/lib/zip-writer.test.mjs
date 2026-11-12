/**
 * zip-writer 单测（运行时库）：makeZip 产物必须被 lib/zip-reader.mjs 精确读回。
 * 覆盖 stored/deflate、中文条目名、空文件、目录式嵌套路径，以及注入非法字段时
 * reader 能按预期拒绝（构造器仍是安全测试的夹具来源）。
 */
import assert from 'node:assert/strict';
import { makeZip } from './zip-writer.mjs';
import { readZipEntries } from './zip-reader.mjs';

const CRC32_EMPTY = 0; // 空文件 CRC 恒为 0，reader 对 crc===0 跳过校验

// 1) stored + deflate 混合，中文名与嵌套路径全部原样读回
{
  const files = [
    { name: '大肥鱼.dsl2d.2048.model3.json', data: JSON.stringify({ FileReferences: { Moc: '大肥鱼.moc3' } }) },
    { name: '大肥鱼.moc3', data: Buffer.from('MOC3-fake-bytes'), method: 'deflate' },
    { name: '贴图/纹理 00.png', data: Buffer.from('PNGDATA'), method: 'deflate' },
    { name: 'empty.txt', data: '' },
  ];
  const zip = makeZip(files);
  assert.equal(zip.subarray(0, 4).toString('latin1'), 'PK\x03\x04', 'zip 以本地文件头魔数开头');
  const entries = readZipEntries(zip);
  assert.equal(entries.length, files.length);
  const back = Object.fromEntries(entries.map((e) => [e.name, e.data.toString('utf8')]));
  for (const f of files) {
    assert.equal(back[f.name], typeof f.data === 'string' ? f.data : f.data.toString('utf8'), '条目读回一致：' + f.name);
  }
  assert.equal(entries.find((e) => e.name === 'empty.txt').data.length, 0, '空文件往返正常');
  void CRC32_EMPTY;
}

// 2) 条目顺序与数量保持（同一条目名重复时以后出现者为准——reader 语义）
{
  const zip = makeZip([{ name: 'a.txt', data: '1' }, { name: 'a.txt', data: '2' }]);
  const entries = readZipEntries(zip);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].data.toString(), '2');
}

// 3) 注入非法字段仍按 reader 预期被拒（构造器是安全测试夹具，不是校验器）
{
  assert.throws(() => readZipEntries(makeZip([{ rawName: '../evil.txt', data: 'x' }])), (err) => err.code === 'zip-slip');
  assert.throws(() => readZipEntries(makeZip([{ name: 'a.txt', data: 'x', corruptCrc: true }])), (err) => err.code === 'corrupt');
  assert.throws(() => readZipEntries(makeZip([{ name: 'a.txt', data: 'x', encrypted: true }])), (err) => err.code === 'encrypted');
}

// 4) 大条目 deflate 往返（10 万字节重复串压缩后读回一致）
{
  const big = Buffer.from('A'.repeat(100_000));
  const entries = readZipEntries(makeZip([{ name: 'big.bin', data: big, method: 'deflate' }]));
  assert.equal(entries[0].data.length, big.length);
  assert.deepEqual(entries[0].data, big);
}

console.log('zip-writer tests passed');
