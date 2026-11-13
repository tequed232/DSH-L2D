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
import { spawnSync } from 'node:child_process';
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

it('l2d_emote 不在登记表（2026-11-13 误判已回滚：overlay.js:5383 有 case 分支，它是活工具）', () => {
  assert.equal(unimplementedTool('l2d_emote'), null, '误判残留会把能用的工具拦死');
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

// 反腐闸门（对登记表全量生效）：任何一个被登记的名字，只要在任何消费层出现
// `case '<name>':` 分支，就说明它其实活着——必须从表里删掉，测试直接红。
const CONSUMER_DIRS = [
  path.join(REPO, 'packages', 'renderer', 'src'),
  path.join(REPO, 'packages', 'dsh-l2d-plugin', 'lib'),
];
it('登记表为空或每个登记名都确无 case 分支（防误伤活工具）', () => {
  const names = Object.keys(UNIMPLEMENTED_TOOLS);
  const offenders = names.filter((name) => {
    const needle = `case '${name}':`;
    return CONSUMER_DIRS.some((dir) => {
      const hit = spawnGrep(needle, dir);
      return hit;
    });
  });
  assert.deepEqual(offenders, [], `以下名字已有消费分支，必须从 UNIMPLEMENTED_TOOLS 移除：${offenders.join(', ')}`);
});

function spawnGrep(needle, dir) {
  try {
    const r = spawnSync('grep', ['-r', '-l', '--include=*.mjs', '--include=*.js', '--include=*.ts', '-F', needle, dir], { encoding: 'utf8' });
    return r.status === 0 && r.stdout.trim().length > 0;
  } catch {
    return false; // 环境无 grep 时跳过该层（Windows Git Bash 自带 grep）
  }
}

console.log('');
if (process.exitCode) {
  console.error('unimplemented-tools: 存在失败');
  process.exit(1);
}
console.log(`unimplemented-tools: ${passed} 项全部通过（登记 ${Object.keys(UNIMPLEMENTED_TOOLS).length} 项）`);
