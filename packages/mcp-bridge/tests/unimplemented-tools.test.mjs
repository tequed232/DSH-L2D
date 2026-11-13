/**
 * 未实现工具登记表测试。
 *
 * 直跑：node packages/mcp-bridge/tests/unimplemented-tools.test.mjs
 * 这类表最容易腐烂：工具后来实现了、表没清 → 用户被永久挡住。
 * 所以除了"登记项必须给出替代路径"，还要断言"已实现的名字不在表里"。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNIMPLEMENTED_TOOLS, unimplementedTool } from '../unimplemented-tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');

let passed = 0;
function it(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err && err.message}`);
    process.exitCode = 1;
  }
}

console.log('未实现工具登记');

it('l2d_emote 已登记，且有 reason/status/message/alternatives 四要素', () => {
  const entry = unimplementedTool('l2d_emote');
  assert.ok(entry, 'l2d_emote 必须登记');
  assert.equal(entry.status, 501);
  assert.match(entry.reason, /unimplemented/);
  assert.ok(entry.message.length > 10);
  assert.ok(Array.isArray(entry.alternatives) && entry.alternatives.length >= 2, '必须给可执行替代路径');
});

it('已实现的工具不在表里（防止拦死正常工具）', () => {
  for (const name of ['l2d_act', 'l2d_perform', 'l2d_graph_run', 'l2d_expression', 'l2d_look']) {
    assert.equal(unimplementedTool(name), null, `${name} 是已实现工具，不应被拦`);
  }
});

it('未知 / 空名字返回 null（不做过度拦截）', () => {
  assert.equal(unimplementedTool(''), null);
  assert.equal(unimplementedTool(undefined), null);
  assert.equal(unimplementedTool('some_future_tool'), null);
});

it('渲染端仍无 l2d_emote 处理分支时，本登记才成立（实现后必须同步移除）', () => {
  const rendererDir = path.join(REPO, 'packages', 'renderer', 'src');
  let found = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (/\.(ts|mjs|js|vue)$/.test(e.name)) {
        const text = fs.readFileSync(abs, 'utf8');
        if (text.includes("'l2d_emote'") || text.includes('"l2d_emote"')) found += 1;
      }
    }
  };
  walk(rendererDir);
  if (found > 0) {
    throw new Error(`渲染端已出现 ${found} 处 l2d_emote 引用：说明它可能已实现，应把 UNIMPLEMENTED_TOOLS 里的条目删掉`);
  }
  assert.equal(found, 0);
});

console.log('');
if (process.exitCode) {
  console.error('unimplemented-tools: 存在失败');
  process.exit(1);
}
console.log(`unimplemented-tools: ${passed} 项全部通过（登记 ${Object.keys(UNIMPLEMENTED_TOOLS).length} 项）`);
