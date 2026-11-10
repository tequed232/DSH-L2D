/**
 * overlay.js 戳一戳节点图策略测试（clickMode='nodegraph'）。
 *
 * overlay.js 是浏览器 IIFE，无法在 node 里整体执行。这里从源码抽出两段真实实现：
 *   ① `function pokeAction() {...}` 分发表；
 *   ② `function pokeByNodegraph() {...}` 节点图通道（fetch → run → fail-open 降级）；
 * 在沙箱里用桩（fetch / say / pokeRandom / pokeByApi / window.DSH_L2D）执行，
 * 断言分派与降级行为，不是源码字面。另有设置面板下拉选项的静态断言。
 * 运行：node packages/dsh-l2d-plugin/lib/overlay-poke-nodegraph.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, 'overlay.js'), 'utf8');

function extractBalanced(marker, open, close) {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, 'overlay.js 缺少片段：' + marker);
  const first = src.indexOf(open, start);
  let depth = 0;
  for (let i = first; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('括号未闭合：' + marker);
}

const pokeActionSrc = extractBalanced('function pokeAction()', '{', '}');
const pokeByNodegraphSrc = extractBalanced('function pokeByNodegraph()', '{', '}');
const pokeNameMatch = src.match(/var POKE_NODEGRAPH_NAME = '([^']+)';/);
assert.ok(pokeNameMatch, 'overlay.js 缺少 POKE_NODEGRAPH_NAME 常量');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok -', name); } catch (err) { console.error('  FAIL -', name); throw err; }
}

/** 沙箱：注入 settings / fetch 桩 / poke 通道桩，返回 exec 与副作用记录。 */
function makeSandbox({ clickMode = 'nodegraph', ready = true, fetchResponse = null, fetchRejects = false } = {}) {
  const log = { fetches: [], says: [], randoms: 0, apis: 0 };
  const factory = new Function(
    'settings', 'fetch', 'log',
    `
    function say(text) { log.says.push(text); }
    function pokeRandom() { log.randoms++; }
    function pokeByApi() { log.apis++; }
    var L_READY = ${ready ? 'true' : 'false'};
    var window = { DSH_L2D: { isReady: function () { return L_READY; } } };
    var POKE_NODEGRAPH_NAME = ${JSON.stringify(pokeNameMatch[1])};
    ${pokeByNodegraphSrc}
    ${pokeActionSrc}
    return { pokeAction: pokeAction, pokeByNodegraph: pokeByNodegraph };
    `,
  );
  const sandbox = factory(
    { clickMode },
    function (url, opts) {
      log.fetches.push({ url: String(url), method: opts && opts.method });
      if (fetchRejects) return Promise.reject(new Error('net-down'));
      return Promise.resolve({
        status: fetchResponse ? fetchResponse.status : 200,
        json: function () { return Promise.resolve(fetchResponse ? fetchResponse.body : null); },
      });
    },
    log,
  );
  sandbox.log = log;
  return sandbox;
}

test('pokeAction 分派：nodegraph 策略走节点图通道', async () => {
  const sb = makeSandbox({ clickMode: 'nodegraph', fetchResponse: { status: 200, body: { ok: true, status: 'completed', receipts: [] } } });
  sb.pokeAction();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(sb.log.fetches, [{ url: '/dsh-l2d/nodegraphs/run?name=poke-response', method: 'POST' }], 'run 固定图名 poke-response');
  assert.deepEqual(sb.log.says, ['戳戳~'], '成功冒泡');
  assert.equal(sb.log.randoms, 0, '成功不降级');
});

test('pokeAction 分派：random/api 策略不走节点图', () => {
  const sbRandom = makeSandbox({ clickMode: 'random' });
  sbRandom.pokeAction();
  assert.equal(sbRandom.log.randoms, 1);
  assert.deepEqual(sbRandom.log.fetches, []);
  const sbApi = makeSandbox({ clickMode: 'api' });
  sbApi.pokeAction();
  assert.equal(sbApi.log.apis, 1);
});

test('run 失败（mode-blocked 409）→ fail-open 降级随机动作', async () => {
  const sb = makeSandbox({ fetchResponse: { status: 409, body: { ok: false, reason: 'mode-blocked', message: '纯 LLM 模式下节点图不执行' } } });
  sb.pokeByNodegraph();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(sb.log.randoms, 1, '降级 pokeRandom');
  assert.deepEqual(sb.log.says, ['节点图不配合，先随机一个']);
});

test('run 图不存在（404）→ fail-open 降级', async () => {
  const sb = makeSandbox({ fetchResponse: { status: 404, body: { ok: false, reason: 'nodegraph-not-found', errors: ['nodegraph not found: poke-response'] } } });
  sb.pokeByNodegraph();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(sb.log.randoms, 1);
});

test('status=rejected（槽位被拒）→ fail-open 降级', async () => {
  const sb = makeSandbox({ fetchResponse: { status: 200, body: { ok: false, status: 'rejected', receipts: [] } } });
  sb.pokeByNodegraph();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(sb.log.randoms, 1);
});

test('网络异常 → fail-open 降级', async () => {
  const sb = makeSandbox({ fetchRejects: true });
  sb.pokeByNodegraph();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(sb.log.randoms, 1);
});

test('模型未就绪 → 提示且不发请求', () => {
  const sb = makeSandbox({ ready: false });
  sb.pokeByNodegraph();
  assert.deepEqual(sb.log.fetches, []);
  assert.deepEqual(sb.log.says, ['模型还没准备好']);
});

// 设置面板（overlay 内嵌）与全局设置页（assets/settings.html）的选项静态断言
test('设置面板下拉含「节点图编排（推荐）」且为首选项', () => {
  assert.ok(src.includes("modeNodegraph.textContent = '节点图编排（推荐）'"), '面板选项文案');
  assert.ok(src.indexOf("clickMode.appendChild(modeNodegraph)") < src.indexOf("clickMode.appendChild(modeRandom)"), '节点图排第一');
  assert.ok(src.includes("settings.clickMode === 'nodegraph' ? 'nodegraph'"), 'value 回显映射含 nodegraph');
});

{
  const settingsHtml = readFileSync(join(HERE, '..', 'assets', 'settings.html'), 'utf8');
  assert.ok(settingsHtml.includes("{ value: 'nodegraph', label: '节点图编排（推荐）' }"), 'settings.html 下拉含节点图选项');
  assert.ok(settingsHtml.indexOf("{ value: 'nodegraph'") < settingsHtml.indexOf("{ value: 'random'"), '节点图排第一');
}

console.log('overlay-poke-nodegraph.test.mjs: ' + passed + ' tests passed');
