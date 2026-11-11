/**
 * zip-reader 测试：正常解压（stored/deflate、目录条目跳过）与全部安全边界
 * （zip-slip 各种形态、加密位、未知压缩方法、条目数/大小上限、CRC、截断、伪造声明大小）。
 */
import assert from 'node:assert/strict';
import { readZipEntries, ZipError } from '../../packages/dsh-l2d-plugin/lib/zip-reader.mjs';
import { makeZip } from './zip-writer.mjs';

function expectZipError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ZipError, '应抛 ZipError，实际：' + (err && err.name));
    assert.equal(err.code, code, '错误码应为 ' + code + '，实际 ' + err.code + '：' + err.message);
    return err;
  }
  assert.fail('应抛 ZipError(' + code + ') 但没有抛');
}

// 1) stored + deflate 往返；目录条目跳过
{
  const zip = makeZip([
    { name: 'a.txt', data: 'hello stored' },
    { name: 'b.bin', data: Buffer.from('deflate me '.repeat(40)), method: 'deflate' },
    { name: 'dir/', data: '' },
    { name: 'dir/c.txt', data: 'nested' },
  ]);
  const entries = readZipEntries(zip);
  assert.equal(entries.length, 3, '目录条目跳过');
  assert.deepEqual(
    Object.fromEntries(entries.map((e) => [e.name, e.data.toString()])),
    { 'a.txt': 'hello stored', 'b.bin': 'deflate me '.repeat(40), 'dir/c.txt': 'nested' },
  );
}

// 2) not-zip：垃圾字节 / 缺 EOCD
{
  expectZipError(() => readZipEntries(Buffer.from('not a zip at all........')), 'not-zip');
  expectZipError(() => readZipEntries(Buffer.from('PK\x03\x04only-local-header')), 'not-zip');
}

// 3) zip-slip：各种穿越/绝对路径形态（zip 规范 / 与 Windows \ 都要拦）
for (const bad of ['../evil.txt', 'a/../../b.txt', '/abs.txt', 'C:/abs.txt', '..\\windows.txt', 'x/..\\..\\y.txt']) {
  expectZipError(() => readZipEntries(makeZip([{ rawName: bad, data: 'x' }])), 'zip-slip');
}
{
  // 合法的相对嵌套名不受影响
  const entries = readZipEntries(makeZip([{ name: 'm/data/m.model3.json', data: '{}' }]));
  assert.equal(entries[0].name, 'm/data/m.model3.json');
}

// 4) 加密位 / 损坏的本地文件头
{
  expectZipError(() => readZipEntries(makeZip([{ name: 'a.txt', data: 'x', encrypted: true }])), 'encrypted');
  // 保留 PK 魔数与 EOCD、只打坏第二个 local header 签名 → corrupt
  const zip = makeZip([
    { name: 'a.txt', data: 'x' },
    { name: 'b.txt', data: 'y' },
  ]);
  zip.writeUInt32LE(0xdeadbeef, 36); // 30 头 + 5 名 + 1 数据
  expectZipError(() => readZipEntries(zip), 'corrupt');
}

// 5) 条目数上限
{
  const zip = makeZip([
    { name: 'a.txt', data: '1' },
    { name: 'b.txt', data: '2' },
    { name: 'c.txt', data: '3' },
  ]);
  expectZipError(() => readZipEntries(zip, { maxEntries: 2 }), 'too-many-entries');
}

// 6) 解压总大小上限：伪造声明大小（炸弹典型形态——声明 600MB，实际几字节）
{
  const zip = makeZip([{ name: 'bomb.bin', data: 'tiny', declaredUncompressedSize: 600 * 1024 * 1024 }]);
  expectZipError(() => readZipEntries(zip, { maxTotalUncompressedBytes: 512 * 1024 * 1024 }), 'too-large');
  // 上限抬高后不再触发 too-large，但声明值与实际不符仍按 corrupt 拒绝（不信任声明字段）。
  expectZipError(() => readZipEntries(zip, { maxTotalUncompressedBytes: 1024 * 1024 * 1024 }), 'corrupt');
}

// 7) CRC 损坏 / 解压后大小与声明不符 / 截断
{
  expectZipError(() => readZipEntries(makeZip([{ name: 'a.txt', data: 'hello', corruptCrc: true }])), 'corrupt');
  expectZipError(() => readZipEntries(makeZip([{ name: 'a.txt', data: 'hello', declaredUncompressedSize: 99 }])), 'corrupt');
  // 条目数据被截断（把 EOCD 里的 cdOffset 后移，使中央目录越界）→ corrupt
  {
    const zip = makeZip([{ name: 'a.txt', data: 'x'.repeat(1000), method: 'deflate' }]);
    const eocdAt = zip.length - 22;
    zip.writeUInt32LE(zip.readUInt32LE(eocdAt + 16) + 5_000_000, eocdAt + 16);
    try {
      readZipEntries(zip);
      assert.fail('应抛 corrupt');
    } catch (err) {
      assert.equal(err.code, 'corrupt');
    }
  }
}

// 8) 空 zip（无文件条目）合法返回空数组
{
  const zip = makeZip([]);
  assert.deepEqual(readZipEntries(zip), []);
}

console.log('zip-reader tests passed');
