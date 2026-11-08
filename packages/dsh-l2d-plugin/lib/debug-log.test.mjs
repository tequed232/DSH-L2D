import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/**
 * 调试日志环形缓冲单测：不复制第二份实现，直接从 overlay.js 源码抽取
 * `var L2D_LOG_MAX_CHARS` → `if (typeof window !== 'undefined')`（renderL2dLog
 * 之后第一个非函数边界）之间的定义块，在空 sandbox（vm.runInNewContext）里
 * 执行真实代码。空 sandbox 能跑通本身就是「定义块无外部模块依赖」的证明。
 */
const source = fs.readFileSync(new URL('./overlay.js', import.meta.url), 'utf8');

const start = source.indexOf('var L2D_LOG_MAX_CHARS');
assert.ok(start > 0, 'overlay.js 应含 L2D_LOG_MAX_CHARS 定义块');
const end = source.indexOf("if (typeof window !== 'undefined') {", start);
assert.ok(end > start, '定义块应止于 renderL2dLog 之后的第一个非函数边界（window 钩子前）');
const block = source.slice(start, end);
assert.ok(block.includes('var L2D_LOG_MAX_AGE_MS'), '定义块应含 L2D_LOG_MAX_AGE_MS');
assert.ok(block.includes('var l2dLogEntries'), '定义块应含 l2dLogEntries');
assert.ok(block.includes('function pruneL2dLog('), '定义块应含 pruneL2dLog');
assert.ok(block.includes('function pushL2dLog('), '定义块应含 pushL2dLog');
assert.ok(block.includes('function renderL2dLog('), '定义块应含 renderL2dLog');

const exported = vm.runInNewContext(
  block +
    '\n;({ push: pushL2dLog, prune: pruneL2dLog, render: renderL2dLog,' +
    ' entries: function () { return l2dLogEntries.slice(); },' +
    ' setEntries: function (list) { l2dLogEntries = list; },' +
    ' MAX_CHARS: L2D_LOG_MAX_CHARS, MAX_AGE: L2D_LOG_MAX_AGE_MS })',
  {},
);
const { push, prune, render, entries, setEntries, MAX_CHARS, MAX_AGE } = exported;
assert.equal(MAX_CHARS, 8192, '环形缓冲上限应为 8192');
assert.equal(MAX_AGE, 30 * 60 * 1000, '过期窗口应为 30min');
assert.equal(typeof push, 'function', 'pushL2dLog 应可从 vm 抽取');
assert.equal(typeof prune, 'function', 'pruneL2dLog 应可从 vm 抽取');
assert.equal(typeof render, 'function', 'renderL2dLog 应可从 vm 抽取');

function totalChars(list) {
  return list.reduce((sum, e) => sum + JSON.stringify(e).length, 0);
}

// 1) 字段完整性与缺省值：空 sandbox 无 window，model 恒为 '—'
push({ comp: 'ai', action: 'l2d_say', state: 'exec' });
const first = entries()[0];
assert.equal(first.comp, 'ai');
assert.equal(first.state, 'exec');
assert.equal(first.model, '—', 'sandbox 无 window.DSH_L2D 时 model 应为 —');
assert.equal(first.action, 'l2d_say');
assert.equal(first.skill, '—', 'skill 预留列当前恒为 —');
assert.equal(typeof first.t, 'number', 't 应缺省为 Date.now()');
assert.equal(first.seq, 1, 'seq 应从 1 自增');

// 2) seq 自增
push({ comp: 'menu', action: 'quickchat', state: 'open' });
push({ comp: 'stage', action: 'state', state: 'conversation' });
assert.deepEqual(
  Array.from(entries()).map((e) => e.seq), // Array.from 归一化跨 vm realm 的数组原型
  [1, 2, 3],
  'seq 应连续自增',
);
assert.equal(entries()[2].comp, 'stage');

// 3) 滚动覆盖：总 JSON 字符 > 8192 时从最旧丢弃，总量回到上限内且最新保留
const LONG = 'x'.repeat(500); // 单条 JSON 长度约 560+
for (let i = 0; i < 20; i++) push({ comp: 'ai', action: LONG, state: 'exec' });
const list = entries();
assert.ok(list.length < 20, `超限后应丢弃最旧条目，实际保留 ${list.length}`);
assert.ok(totalChars(list) <= MAX_CHARS, `滚动后总字符应 ≤8192，实际 ${totalChars(list)}`);
assert.equal(list[list.length - 1].action, LONG, '最新条目应保留');
assert.ok(list[list.length - 1].seq > list[0].seq, '保留段 seq 应递增');
assert.ok(list[0].seq > 3, `最旧条目应已被滚动丢弃，最旧剩余 seq=${list[0].seq}`);

// 4) 30min 过期清理（钩子 entries() 返回副本，复位一律用 prune 全量判过期）
prune(Date.now() + MAX_AGE + 1);
const now = Date.now();
push({ comp: 'overlay', action: 'a', state: 'ok', t: now });
push({ comp: 'overlay', action: 'b', state: 'ok', t: now - MAX_AGE - 1 });
assert.equal(entries().length, 1, 'push 时应顺带 prune 掉超龄条目');
assert.equal(entries()[0].action, 'a', '应保留未过期条目');
push({ comp: 'overlay', action: 'c', state: 'ok', t: now });
prune(now + MAX_AGE + 1);
assert.equal(entries().length, 0, 'prune 应删除全部过期条目');

// 5) 畸形入参不抛；结果始终是结构完整的一条
for (const bad of [undefined, null, 42, 'x', {}, { t: 'bad' }, Symbol('s')]) {
  assert.doesNotThrow(() => push(bad), `畸形入参不应抛：${String(bad)}`);
}
for (const e of entries()) {
  assert.equal(typeof e.t, 'number');
  assert.equal(typeof e.comp, 'string');
  assert.equal(typeof e.state, 'string');
  assert.equal(typeof e.model, 'string');
  assert.equal(typeof e.action, 'string');
  assert.equal(typeof e.seq, 'number');
  assert.equal(typeof e.skill, 'string');
}

// 6) renderL2dLog 行格式：HH:MM:SS comp state action #seq（最新在底）
//    注：2020 年的固定 t 会被「push 顺带 prune」按 30min 规则丢弃，
//    因此渲染格式测试用 setEntries 直接注入结构完整的条目。
const T = new Date(2020, 0, 1, 7, 5, 3).getTime();
setEntries([
  { t: T, comp: 'ai', state: 'exec', model: '—', action: 'l2d_say', seq: 1, skill: '—' },
  { t: T, comp: 'stage', state: 'idle', model: '—', action: 'state', seq: 2, skill: '—' },
]);
const lines = render();
assert.equal(lines.length, 2);
assert.match(lines[0], /^07:05:03 ai exec l2d_say #1$/, `行格式不符：${lines[0]}`);
assert.match(lines[1], /^07:05:03 stage idle state #2$/, `行格式不符：${lines[1]}`);
assert.equal(lines[1].endsWith('#2'), true, '行内 #seq 应与条目一致');

// 7) 静态断言：接线点与钩子、菜单项顺序
assert.ok(
  source.includes("pushL2dLog({ comp: 'ai', action: String(name || ''), state: 'exec' })"),
  'DSH_L2D_AI.exec 入口应 push（comp:ai）',
);
const sayBody = source.slice(source.indexOf('function say('), source.indexOf('function sayHtml('));
assert.ok(
  sayBody.includes("pushL2dLog({ comp: 'overlay', action: 'say'"),
  'say() 上屏后应 push（comp:overlay, action:say）',
);
const setStateBody = source.slice(source.indexOf('function setState('), source.indexOf('var bubbleTimer'));
assert.ok(
  setStateBody.includes("pushL2dLog({ comp: 'stage', state: next })"),
  'setState 应 push（comp:stage）',
);
const envBody = source.slice(
  source.indexOf('function applyEnvState('),
  source.indexOf('function startAwayWander('),
);
assert.ok(
  envBody.includes("pushL2dLog({ comp: 'stage', state: next })"),
  'applyEnvState 应 push（comp:stage）',
);
assert.ok(source.includes('window.DSH_L2D_LOG__'), '应暴露 DSH_L2D_LOG__ 只读钩子');
const balanceAt = source.indexOf("menuButton('余额 / 价格', showBalance)");
const qcAt = source.indexOf("menuButton('快捷对话'");
const logAt = source.indexOf("menuButton('调试日志', toggleLogPanel");
assert.ok(balanceAt > 0 && balanceAt < qcAt && qcAt < logAt, '菜单顺序应为 余额/价格 → 快捷对话 → 调试日志');
assert.ok(source.indexOf("menuView = 'quickchat'") > 0, '快捷对话应切到 quickchat 子视图');

console.log('debug-log ok');
