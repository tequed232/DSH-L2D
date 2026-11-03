#!/usr/bin/env node
/**
 * 宿主守卫回归（需要运行中的实例）。
 *
 *   node tools/acceptance/guards.mjs                 # 读 ~/.dsh/l2d-service.json
 *   node tools/acceptance/guards.mjs --origin http://127.0.0.1:3080
 *
 * 只发**应当被拒绝**的调用：被拒即不产生状态变化，所以可在任意时刻跑（不抢动作槽）。
 * 每条断言「状态码 + 响应体里的原因串」，避免像 M1 验收那样因为字段名写错
 * （params vs values、name vs group）把「没触发守卫」误判成「守卫失效」。
 *
 * 退出码：0 全过；1 有 FAIL；2 连不上。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

function readOrigin() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, 'l2d-service.json'), 'utf8'));
    return j && j.origin ? String(j.origin) : '';
  } catch {
    return '';
  }
}

const ORIGIN = (argOf('origin', '') || readOrigin() || '').replace(/\/+$/, '');

/** 每条用例：说明 / 请求体 / 期望状态码 / 期望响应里出现的原因串 */
const CASES = [
  {
    name: '口型红线（任何通道永拒）',
    body: { name: 'l2d_set_parameters', args: { values: { ParamMouthOpenY: 1 } } },
    expect: 400,
    reason: 'reserved-param',
  },
  {
    name: '物理输出未 own 不可写',
    body: { name: 'l2d_set_parameters', args: { values: { ParamAngleX: 10 } } },
    expect: 400,
    reason: 'physics-output-requires-own',
  },
  {
    name: '未索引表情被拒',
    body: { name: 'l2d_set_expression', args: { name: '根本不存在的表情' } },
    expect: 400,
    reason: 'unknown-expression',
  },
  {
    name: 'Idle 不允许手动播',
    body: { name: 'l2d_play_motion', args: { group: 'Idle' } },
    expect: 400,
    reason: 'idle-not-playable',
  },
  {
    name: '未知工具名被拒',
    body: { name: 'l2d_does_not_exist', args: {} },
    expect: 400,
    reason: 'unknown tool',
  },
  {
    name: '缺 name 被拒',
    body: { args: {} },
    expect: 400,
    reason: 'name required',
  },
  {
    name: '跨站 Origin 被拒',
    body: { name: 'l2d_get_state', args: {} },
    expect: 403,
    reason: 'forbidden',
    headers: { origin: 'https://evil.example' },
  },
];

const results = [];
async function main() {
  if (!ORIGIN) {
    console.error('找不到服务地址：既没传 --origin，也没读到 ~/.dsh/l2d-service.json');
    process.exit(2);
  }
  console.log(`\n[guards] origin=${ORIGIN}\n`);
  try {
    const ping = await fetch(`${ORIGIN}/dsh-l2d/status.json`);
    if (!ping.ok) throw new Error('HTTP ' + ping.status);
  } catch (e) {
    console.error(`连不上 ${ORIGIN}（${e.message}）`);
    process.exit(2);
  }

  for (const c of CASES) {
    let status = 0;
    let text = '';
    try {
      const res = await fetch(`${ORIGIN}/dsh-l2d/ai/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(c.headers || {}) },
        body: JSON.stringify(c.body),
      });
      status = res.status;
      text = await res.text();
    } catch (e) {
      text = 'FETCH-ERR ' + e.message;
    }
    const ok = status === c.expect && text.includes(c.reason);
    results.push({ ...c, status, text: text.slice(0, 120), ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name} — ${status} ${text.slice(0, 80)}`);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n[guards] ${results.length - failed}/${results.length} 通过${failed ? `，${failed} 项失败` : ''}\n`);
  process.exit(failed ? 1 : 0);
}

main();
