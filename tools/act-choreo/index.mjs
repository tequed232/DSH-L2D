#!/usr/bin/env node
/**
 * 动作链执行器（开发/验收工具，不进插件运行时）。
 *
 * 把 lib/choreography.mjs 里的 STATE→chain 数据真正发到本机 DSH 的 L2D 叠加层：
 *   POST /dsh-l2d/ai/call  { name: "l2d_act", args: {...} }
 *   GET  /dsh-l2d/ai/result?id=...  轮询 accepted / events(start/end/interrupted)
 *
 * 端点每次从 ~/.dsh/l2d-service.json 的 origin 读（DSH 重启端口会变），
 * 也可用 DSH_L2D_ORIGIN 覆盖。页面必须可见，否则 rAF 被节流，动作不推进。
 *
 * 用法：
 *   node tools/act-choreo/index.mjs --list
 *   node tools/act-choreo/index.mjs --dry-run
 *   node tools/act-choreo/index.mjs --state attention
 *   node tools/act-choreo/index.mjs --all
 *   node tools/act-choreo/index.mjs --phase speaking
 *   node tools/act-choreo/index.mjs --matrix
 *   node tools/act-choreo/index.mjs --all --gap-ms 1500 --out ./last-run.json
 *
 * 退出码：0 全部通过；1 编排校验失败 / 插件离线；2 有实测项不符合预期。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHOREOGRAPHY,
  CHOREOGRAPHY_STATES,
  USER_DIRECT_PHASES,
  estimateLifeMs,
  validateChoreography,
} from '../../packages/dsh-l2d-plugin/lib/choreography.mjs';

const POLL_MS = 110;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveOrigin() {
  const fromEnv = String(process.env.DSH_L2D_ORIGIN || '').trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const file = path.join(os.homedir(), '.dsh', 'l2d-service.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed.origin === 'string' && parsed.origin) return parsed.origin.replace(/\/+$/, '');
  } catch {
    /* 下面统一报错 */
  }
  return '';
}

async function postCall(origin, name, args) {
  const res = await fetch(origin + '/dsh-l2d/ai/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, args: args || {} }),
  });
  if (!res.ok) throw new Error('call HTTP ' + res.status);
  const body = await res.json();
  if (!body || body.ok === false || !body.id) throw new Error('call rejected: ' + JSON.stringify(body));
  return body;
}

function makeRun(label, priority) {
  return { label, priority, startedAt: Date.now(), result: null, events: [], terminal: null };
}

/**
 * 发一条 l2d_act，拿到受理回执就返回（不等播完）。
 * 返回 { id, run, t0 }。
 */
async function startAct(origin, args, label, priorityOverride) {
  const queued = await postCall(origin, 'l2d_act', args);
  const run = makeRun(label, priorityOverride || args.priority || 'NORMAL');
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && !run.result) {
    const res = await fetch(origin + '/dsh-l2d/ai/result?id=' + encodeURIComponent(queued.id), {
      cache: 'no-store',
    });
    if (res.ok) {
      const body = await res.json();
      if (Array.isArray(body.events)) run.events.push(...body.events);
      if (body.ready && body.result) run.result = body.result;
    }
    if (!run.result) await sleep(POLL_MS);
  }
  return { id: queued.id, run };
}

/** 等 end / interrupted（或超时）。继续轮询同一个 id 收割迟到事件。 */
async function waitAct(origin, ctx, timeoutMs) {
  const { id, run } = ctx;
  const deadline = Date.now() + (timeoutMs || 12000);
  const terminalOf = () =>
    run.events.find(
      (event) =>
        event &&
        (event.phase === 'end' || event.phase === 'interrupted') &&
        (run.result == null || run.result.runId == null || event.runId === run.result.runId),
    );
  let terminal = terminalOf();
  while (!terminal && Date.now() < deadline) {
    const res = await fetch(origin + '/dsh-l2d/ai/result?id=' + encodeURIComponent(id), { cache: 'no-store' });
    if (res.ok) {
      const body = await res.json();
      if (Array.isArray(body.events)) run.events.push(...body.events);
      if (body.ready && body.result && !run.result) run.result = body.result;
    }
    terminal = terminalOf();
    if (!terminal) await sleep(POLL_MS);
  }
  run.terminal = terminal || null;
  return summarize(run);
}

function summarize(run) {
  const result = run.result || {};
  const terminal = run.terminal || null;
  const accepted = result.accepted === true;
  let outcome = 'rejected';
  if (accepted) outcome = terminal ? (terminal.phase === 'end' ? 'completed' : 'interrupted') : 'pending';
  return {
    label: run.label,
    priority: result.priority || run.priority,
    accepted,
    outcome,
    reason: terminal && terminal.reason ? String(terminal.reason) : result.reason || null,
    notes: terminal && Array.isArray(terminal.notes) ? terminal.notes : [],
    runId: result.runId ?? null,
    steps: result.steps ?? null,
    events: run.events.map((event) => ({
      phase: event.phase,
      runId: event.runId,
      reason: event.reason || null,
      notes: event.notes || null,
    })),
    actualMs: run.terminal ? Date.now() - run.startedAt : null,
    current: result.current || null,
  };
}

/** 跑一条完整链（等播完）。 */
async function runAct(origin, args, label, opts = {}) {
  const ctx = await startAct(origin, args, label);
  const result = ctx.run.result;
  if (result && result.accepted === false) return summarize(ctx.run);
  return waitAct(origin, ctx, opts.timeoutMs || (estimateLifeMs(args.chain) + 6000));
}

function fmt(value, width) {
  const text = String(value == null ? '' : value);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function printTable(rows) {
  const head = ['链', '优先级', 'accepted', 'outcome', '实测ms', 'reason/notes'];
  const widths = [18, 10, 8, 12, 8, 52];
  console.log(head.map((text, index) => fmt(text, widths[index])).join(' '));
  console.log(widths.map((width) => '-'.repeat(width)).join(' '));
  for (const row of rows) {
    const note = row.reason || (row.notes && row.notes.length ? row.notes.join(',') : '');
    console.log(
      [fmt(row.label, widths[0]), fmt(row.priority, widths[1]), fmt(row.accepted, widths[2]), fmt(row.outcome, widths[3]), fmt(row.actualMs ?? '-', widths[4]), fmt(note, widths[5])].join(' '),
    );
  }
}

/** 发一条普通工具调用并等回执（get_state / play_motion 这类短调用）。 */
async function callAndWait(origin, name, args, timeoutMs = 6000) {
  const queued = await postCall(origin, name, args || {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(origin + '/dsh-l2d/ai/result?id=' + encodeURIComponent(queued.id), { cache: 'no-store' });
    if (res.ok) {
      const body = await res.json();
      if (body.ready && body.result) return body.result;
    }
    await sleep(POLL_MS);
  }
  return null;
}

/** 读当前动作槽位（抚胸手/竖手指/狗尾巴草 的开合），用来证明矩阵真的落到状态机。 */
async function readSlots(origin) {
  const state = await callAndWait(origin, 'l2d_get_state', {}, 5000);
  const info = state && state.info;
  if (!info || typeof info.motion !== 'string') return '';
  const match = /slots=([^\s]+)/.exec(info.motion);
  return match ? match[1] : info.motion;
}

/** 收干净两只手，保证下一条断言从确定的 closed 起步。 */
async function ensureClosed(origin, groups) {
  for (const group of groups) {
    await callAndWait(origin, 'l2d_play_motion', { group }, 8000);
  }
  await sleep(300);
  return readSlots(origin);
}

async function fetchFrames(origin) {
  const queued = await postCall(origin, 'l2d_get_state', {});
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const res = await fetch(origin + '/dsh-l2d/ai/result?id=' + encodeURIComponent(queued.id), { cache: 'no-store' });
    if (res.ok) {
      const body = await res.json();
      if (body.ready && body.result) {
        const info = body.result.info || {};
        return { frames: info.frames ?? null, ready: body.result.ready === true, motion: info.motion || '' };
      }
    }
    await sleep(POLL_MS);
  }
  return { frames: null, ready: false };
}

function chainArgs(state, force) {
  const entry = CHOREOGRAPHY[state];
  const args = { chain: entry.chain, priority: entry.priority };
  if (entry.phase) args.phase = entry.phase;
  return args;
}

async function runState(origin, state, gapMs) {
  const entry = CHOREOGRAPHY[state];
  const args = chainArgs(state);
  const row = await runAct(origin, args, state);
  row.expectedLifeMs = estimateLifeMs(entry.chain);
  await sleep(gapMs);
  return row;
}

async function runPhase(origin, phase, gapMs) {
  const row = await runAct(origin, { phase, priority: phase === 'settle' ? 'NORMAL' : 'FORCE' }, 'phase:' + phase);
  await sleep(gapMs);
  return row;
}

/** 优先级 / 兜底矩阵：每条断言都对应 docs/动作链编排-v1.md 的规则。 */
async function runMatrix(origin, gapMs) {
  const rows = [];
  const closeGrass = { chain: [{ kind: 'motion', name: '狗尾巴草关闭' }], priority: 'NORMAL' };
  const closeFinger = { chain: [{ kind: 'motion', name: '竖手指关闭' }], priority: 'NORMAL' };

  // 1. FORCE 在播，BACKGROUND 不该占槽。
  {
    const first = await startAct(origin, { phase: 'speaking' }, 'FORCE 占槽中');
    await sleep(400);
    const blocked = await runAct(origin, { chain: CHOREOGRAPHY.thinking.chain, priority: 'BACKGROUND' }, 'BACKGROUND 尝试插入');
    blocked.expect = 'priority-blocked';
    blocked.ok = blocked.accepted === false && blocked.reason === 'priority-blocked' && blocked.current && blocked.current.priority === 'FORCE';
    rows.push(blocked);
    await waitAct(origin, first, 12000);
    await sleep(gapMs);
  }

  // 2. NORMAL 在播，BACKGROUND 不该占槽。
  {
    const first = await startAct(origin, { phase: 'settle' }, 'NORMAL 占槽中');
    await sleep(400);
    const blocked = await runAct(origin, chainArgs('idle'), 'BACKGROUND 尝试插入');
    blocked.expect = 'priority-blocked';
    blocked.ok = blocked.accepted === false && blocked.reason === 'priority-blocked' && blocked.current && blocked.current.priority === 'NORMAL';
    rows.push(blocked);
    await waitAct(origin, first, 12000);
    await sleep(gapMs);
  }

  // 3. BACKGROUND 在播，NORMAL 可以抢占，旧链收到 interrupted。
  {
    const first = await startAct(origin, chainArgs('working'), 'BACKGROUND 在播');
    await sleep(400);
    const preempt = await runAct(origin, chainArgs('error'), 'NORMAL 抢占');
    const old = await waitAct(origin, first, 12000);
    preempt.expect = 'accepted + 旧链 interrupted';
    preempt.slots = await readSlots(origin);
    preempt.ok = preempt.accepted === true && old.outcome === 'interrupted';
    rows.push(preempt);
    await sleep(gapMs);
  }

  // 4. 同级可以打断。
  {
    const first = await startAct(origin, chainArgs('attention'), 'NORMAL 在播');
    await sleep(400);
    const preempt = await runAct(origin, chainArgs('error'), '同级 NORMAL 抢占');
    const old = await waitAct(origin, first, 12000);
    preempt.expect = 'accepted + 旧链 interrupted';
    preempt.slots = await readSlots(origin);
    preempt.ok = preempt.accepted === true && old.outcome === 'interrupted';
    rows.push(preempt);
    await sleep(gapMs);
  }

  // 5. 右臂冲突：狗尾巴草占着时，attention 的竖手指返回 conflict，表情/视线仍生效。
  {
    await ensureClosed(origin, ['竖手指关闭', '狗尾巴草关闭']);
    const opened = await runAct(origin, { chain: [{ kind: 'motion', name: '狗尾巴草打开' }], priority: 'NORMAL' }, '先开狗尾巴草');
    await sleep(gapMs);
    const conflict = await runAct(origin, chainArgs('attention'), 'attention（右臂被占）');
    conflict.expect = 'end.reason=conflict';
    conflict.slots = await readSlots(origin);
    conflict.ok =
      opened.outcome === 'completed' &&
      opened.reason == null &&
      conflict.accepted === true &&
      conflict.outcome === 'completed' &&
      /占用/.test(String(conflict.reason || ''));
    rows.push(conflict);
    await runAct(origin, closeGrass, '收狗尾巴草');
    await sleep(gapMs);
  }

  // 6. 已开着：重复打开返回 skipped，收进 notes，不算失败。
  {
    const closed = await ensureClosed(origin, ['竖手指关闭']);
    const opened = await runAct(origin, { chain: [{ kind: 'motion', name: '竖手指打开' }], priority: 'NORMAL' }, '先开竖手指');
    await sleep(gapMs);
    const skipped = await runAct(origin, chainArgs('attention'), 'attention（竖手指已开）');
    skipped.expect = 'notes=already-open';
    skipped.slots = await readSlots(origin);
    skipped.ok =
      closed.includes('竖手指:closed') &&
      opened.outcome === 'completed' &&
      skipped.accepted === true &&
      skipped.outcome === 'completed' &&
      skipped.notes.includes('already-open');
    rows.push(skipped);
    await runAct(origin, closeFinger, '收竖手指');
    await sleep(gapMs);
  }

  return rows;
}

function printPlan() {
  console.log('状态 → 链计划（估算时长按 overlay plannedLifeMs 公式）');
  for (const state of CHOREOGRAPHY_STATES) {
    const entry = CHOREOGRAPHY[state];
    console.log(
      [
        state.padEnd(12),
        entry.priority.padEnd(10),
        (estimateLifeMs(entry.chain) + 'ms').padEnd(8),
        'cooldown=' + entry.cooldownMs + 'ms',
        'dwell=' + entry.minDwellMs + 'ms',
        'refresh=' + entry.refreshMs + 'ms',
        'limit=' + entry.maxInWindow + '/' + entry.windowMs + 'ms',
      ].join('  '),
    );
    for (const step of entry.chain) {
      const detail = [
        step.kind,
        step.name || '',
        step.pose ? JSON.stringify(step.pose) : '',
        step.kind === 'look' ? 'x=' + step.x + ' y=' + step.y : '',
        step.closeMotion ? 'close=' + step.closeMotion + '@' + (step.closeAfterMs || 6000) : '',
        step.delayMs ? 'delay=' + step.delayMs : '',
      ]
        .filter(Boolean)
        .join(' ');
      console.log('              · ' + detail);
    }
  }
  console.log('\nphase 短链：' + Object.keys(USER_DIRECT_PHASES).join(' / '));
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes('--' + name);
  const value = (name, fallback) => {
    const at = argv.indexOf('--' + name);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
  };
  const gapMs = Math.max(1000, Number(value('gap-ms', '1300')) || 1300);
  const out = value('out', '');

  const validation = validateChoreography();
  if (!validation.ok) {
    console.error('编排校验失败：\n' + validation.errors.join('\n'));
    process.exit(1);
  }
  if (validation.warnings.length) console.warn('编排警告：\n' + validation.warnings.join('\n'));

  if (flag('list') || (!flag('all') && !flag('matrix') && !flag('dry-run') && !value('state', '') && !value('phase', ''))) {
    printPlan();
    return;
  }
  if (flag('dry-run')) {
    printPlan();
    return;
  }

  const origin = resolveOrigin();
  if (!origin) {
    console.error('找不到 DSH-L2D 端点：检查 ~/.dsh/l2d-service.json 或设置 DSH_L2D_ORIGIN');
    process.exit(1);
  }
  const before = await fetchFrames(origin).catch(() => ({ frames: null, ready: false }));
  console.log('端点：' + origin + '  渲染 ready=' + before.ready + ' frames=' + before.frames);
  if (!before.ready) {
    console.error('叠加层未就绪：确认 DSH 页面已打开且角色可见（不可见时 rAF 会被节流）。');
    process.exit(1);
  }

  const rows = [];
  if (flag('all')) {
    for (const state of CHOREOGRAPHY_STATES) rows.push(await runState(origin, state, gapMs));
  }
  const single = value('state', '');
  if (single) {
    if (!CHOREOGRAPHY[single]) {
      console.error('未知状态：' + single + '（可用：' + CHOREOGRAPHY_STATES.join(', ') + '）');
      process.exit(1);
    }
    rows.push(await runState(origin, single, gapMs));
  }
  const phase = value('phase', '');
  if (phase) {
    if (!USER_DIRECT_PHASES[phase]) {
      console.error('未知 phase：' + phase + '（可用：' + Object.keys(USER_DIRECT_PHASES).join(', ') + '）');
      process.exit(1);
    }
    rows.push(await runPhase(origin, phase, gapMs));
  }
  if (flag('matrix')) rows.push(...(await runMatrix(origin, gapMs)));

  const after = await fetchFrames(origin).catch(() => ({ frames: null, ready: false }));
  console.log('\n渲染活性：frames ' + before.frames + ' → ' + after.frames + '  ready=' + after.ready);

  printTable(rows);
  const failed = rows.filter((row) => row.ok === false);
  const report = { origin, startedAt: new Date().toISOString(), framesBefore: before.frames, framesAfter: after.frames, rows };
  if (out) {
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log('\n结果已写入 ' + out);
  }
  if (failed.length) {
    console.error('\n不符合预期的项：' + failed.map((row) => row.label + '（期望 ' + row.expect + '）').join('；'));
    process.exit(2);
  }
  console.log('\n全部通过：' + rows.length + ' 条');
}

main().catch((err) => {
  console.error('执行失败：' + (err && err.message ? err.message : err));
  process.exit(1);
});
