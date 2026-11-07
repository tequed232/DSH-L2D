import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/**
 * 字幕准入单测：不复制第二份实现，直接从 overlay.js 源码抽取
 * `var CAPTION_PARAM_RE` → `function say(` 之间的定义块，
 * 在空 sandbox（vm.runInNewContext）里执行真实代码。
 * 空 sandbox 能跑通本身就是「定义块无外部模块依赖」的证明。
 */
const source = fs.readFileSync(new URL('./overlay.js', import.meta.url), 'utf8');

const start = source.indexOf('var CAPTION_PARAM_RE');
assert.ok(start > 0, 'overlay.js 应含 CAPTION_PARAM_RE 定义块');
const end = source.indexOf('function say(', start);
assert.ok(end > start, '定义块应位于 function say( 之前');
const block = source.slice(start, end);
assert.ok(block.includes('var CAPTION_ALLOW_RE'), '定义块应含 CAPTION_ALLOW_RE');
assert.ok(block.includes('function admitCaption('), '定义块应含 admitCaption');
assert.ok(block.includes('window.DSH_L2D_CAPTION__'), '应暴露 DSH_L2D_CAPTION__ 钩子');

const exported = vm.runInNewContext(
  block + '\n;({ admit: admitCaption, paramRe: CAPTION_PARAM_RE, allowRe: CAPTION_ALLOW_RE })',
  {},
);
const admit = exported.admit;
assert.equal(typeof admit, 'function', 'admitCaption 应可从 vm 抽取');
assert.equal(exported.paramRe.flags, 'g', 'CAPTION_PARAM_RE 应为 g 标志');
assert.equal(exported.allowRe.flags, 'gu', 'CAPTION_ALLOW_RE 应为 gu 标志');

// 最终渲染文本的参数残留复核：任何命中都视为参数泄漏。
const RESIDUE_RE = /Param|Clothes|LEar|REar|BodyAngle|paramId|schemaVersion|\{|\$|=/i;

// 1) 纯文本：原样放行，验证不误拦
const PLAIN = [
  '嘿嘿，好痒~',
  '我看完啦，等你下一句',
  '操作电脑',
  '完成，剩 1 秒',
  'OK!',
  '第 2 次',
];
for (const t of PLAIN) {
  const r = admit(t);
  assert.equal(r.ok, true, `纯文本不应被拦截：${t} -> ${JSON.stringify(r)}`);
  assert.equal(r.text, t, `纯文本应原样放行：${t} -> ${JSON.stringify(r.text)}`);
  assert.equal(RESIDUE_RE.test(r.text), false);
}

// 2) 含参：ok:false，或 text 不含任何参数名 / 赋值 / 占位符残留
const PARAM = [
  'Clothes2=0.4',
  'ParamAngleX: 30',
  'LEar1=1',
  '{ParamMouthOpenY:1}',
  '{"paramId":"LEar1","weight":1.5}',
  '${ParamAngleX}',
  '<mood>开心</mood>',
  'setParameters({ParamAngleZ:-1})',
];
for (const t of PARAM) {
  const r = admit(t);
  assert.equal(typeof r.ok, 'boolean', `应返回结构化结果：${t}`);
  assert.equal(typeof r.text, 'string', `text 应为字符串：${t}`);
  if (!r.ok) {
    assert.equal(r.text, '', `ok:false 时 text 应为空：${t}`);
  } else {
    assert.equal(RESIDUE_RE.test(r.text), false, `含参文本仍有残留：${t} -> ${JSON.stringify(r.text)}`);
  }
}

// 3) 混合：剔除参数片段，保留自然语言
const MIXED = [
  ['嘿嘿，好痒~ Clothes2=0.4', '嘿嘿，好痒~'],
  ['完成，剩 1 秒 {"value":1}', '完成，剩 1 秒'],
];
for (const [input, expected] of MIXED) {
  const r = admit(input);
  assert.equal(r.ok, true, `混合文本应放行自然语言部分：${input} -> ${JSON.stringify(r)}`);
  assert.equal(r.text, expected, `混合文本清理结果不符：${input} -> ${JSON.stringify(r.text)}`);
  assert.equal(RESIDUE_RE.test(r.text), false);
}

// 4) 禁用字符（= { } $ < >）不得进入渲染文本；<b> 这类标签形态由 PARAM_RE 整段剔除
const FORBIDDEN = [
  ['a=b', 'ab'],
  ['x{y}', 'xy'],
  ['a$b', 'ab'],
  ['a<b>', 'a'],
];
for (const [input, expected] of FORBIDDEN) {
  const r = admit(input);
  assert.equal(r.text, expected, `禁用字符应被剔除：${input} -> ${JSON.stringify(r.text)}`);
  assert.equal(/[={}<>$|`]/.test(r.text), false, `禁用字符不得残留：${input}`);
}

// 5) 畸形入参不抛；重复调用结果一致（g 正则 lastIndex 已在函数内重置）
for (const bad of [undefined, null, 42, '', {}, [], Symbol('x')]) {
  const r = admit(bad);
  assert.equal(typeof r.ok, 'boolean', `畸形入参不应抛：${String(bad)}`);
  assert.equal(typeof r.text, 'string', `畸形入参 text 应为字符串：${String(bad)}`);
}
assert.deepEqual(
  admit('嘿嘿，好痒~ Clothes2=0.4'),
  admit('嘿嘿，好痒~ Clothes2=0.4'),
  'admitCaption 应为纯函数（可重复调用）',
);

// 6) 静态断言：say() 接线正确，sayHtml 仍无调用点
const sayBody = source.slice(source.indexOf('function say('), source.indexOf('function sayHtml('));
assert.ok(sayBody.includes('admitCaption('), 'say() 应调用 admitCaption');
assert.ok(sayBody.includes('bubbleEl.textContent = admitted.text'), 'say() 应写入 admitted.text');
assert.equal(
  (source.match(/\bsayHtml\b/g) || []).length,
  1,
  'sayHtml 应仍无调用点（仅定义处一次）',
);

console.log('caption-guard ok');
