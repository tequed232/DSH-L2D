/**
 * P0 修复（模型加载失败）：fetchModelAsset 单元测试（fetch 注入 stub）。
 * 运行：node --experimental-strip-types packages/renderer/src/app/model-fetch.test.mjs
 */
import assert from 'node:assert/strict';
import { fetchModelAsset } from './model-fetch.ts';

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log('  ok -', name);
    })
    .catch((err) => {
      console.error('  FAIL -', name);
      throw err;
    });
}

const okResponse = (body) => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => body,
});

test('成功：200 + 非空体 → 返回 buffer', async () => {
  const fake = async () => okResponse(new Uint8Array([1, 2, 3]).buffer);
  const r = await fetchModelAsset('http://x/model3.json', 5000, fake);
  assert.equal(r.byteLength, 3);
});

test('HTTP 404 → 明确报错（不再把错误页当 model3.json 解析）', async () => {
  const fake = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(
    fetchModelAsset('http://x/missing.json', 5000, fake),
    (err) => /HTTP 404/.test(err.message),
  );
});

test('空体（0 字节）→ 拒绝', async () => {
  const fake = async () => okResponse(new ArrayBuffer(0));
  await assert.rejects(
    fetchModelAsset('http://x/empty.json', 5000, fake),
    (err) => /空\(0 字节\)/.test(err.message),
  );
});

test('网络挂起 → 超时拒绝', async () => {
  const fake = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  await assert.rejects(
    fetchModelAsset('http://x/hang.json', 50, fake),
    (err) => /超时/.test(err.message),
  );
});

test('网络异常 → 错误消息透传', async () => {
  const fake = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(
    fetchModelAsset('http://x/refused.json', 5000, fake),
    (err) => /ECONNREFUSED/.test(err.message),
  );
});

const results = [];
for (const t of [test]) void t;
// 顺序执行收集
const run = async () => {
  // test() 返回 promise，但上面已按同步注册执行——等全部落定
  await new Promise((r) => setTimeout(r, 120));
  console.log('\nmodel-fetch: ' + passed + ' passed, 0 failed');
  if (passed !== 5) {
    console.error('期望 5 项全过，实际 ' + passed);
    process.exit(1);
  }
};
await run();
