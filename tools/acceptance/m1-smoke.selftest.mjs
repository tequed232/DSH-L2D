/**
 * m1-smoke 自测：对内置 mock 宿主跑通全部判定路径，不碰真机。
 *
 *   node tools/acceptance/m1-smoke.mjs --selftest
 *
 * 覆盖：
 *   1) 纯判定辅助（parsePv / parsePw / driftedFromHold / resolveM1Flag）
 *   2) flag on + allow-write：mock 宿主喂 PASS 数据 → 基线 + 全部 M1 自动化用例 PASS，0 FAIL
 *   3) flag off：M1 组整组 SKIP、基线照常 PASS → 0 FAIL（回滚基线模式 = 真机 SKIP 验收形态）
 *   4) flag on 但未 allow-write：M1 组 SKIP（对其他分支实例只 GET 的安全形态）
 *   5) hip / gesture 占位：未交付时 SKIP 不拉低 verdict
 *   6) 坏画像 mock：T1 必 FAIL（验证 FAIL 路径没有被 SKIP 语义吞掉）
 *
 * 全部断言通过返回 true（进程退出码 0）。
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { runCases, parsePv, parsePw, driftedFromHold, resolveM1Flag } from './m1-smoke.mjs';

const TITLES = ['显示与布局', '角色与模型', '情绪与行为', '动画与性能', '开发者工具'];

/** 生成 info.pv 串：RArm 独占期内恒为目标值，过期后物理漂移；HipAngleX 同理（U5）。 */
function makePv(state) {
  const now = Date.now();
  const rarm = now < state.holdUntil ? state.holdValue : 0.25 + 0.05 * (state.ticks % 4);
  const hip = now < state.hipUntil ? state.hipValue : 0.1 + 0.05 * (state.ticks % 3);
  return `AngleX=0.100 RArm=${rarm.toFixed(3)} HipAngleX=${hip.toFixed(3)} LArm=-0.100 chg=yes finished=false`;
}

/** 生成 info.inj 串（pw=pre/post 计数）。 */
function makeInj(state) {
  return `calls=9 writes=6 skip=0 sticky=0 locked=${state.holdUntil > Date.now() ? 1 : 0} owned=0 modes=2/3 pw=${state.pwPre}/${state.pwPost} seen=8/8 ne=8/8 dbg=0:post:set:RArm`;
}

/** mock 画像：U1/U5 依赖 sourceId 解析语义控制（M1-d1 契约 59 = 标准 23 + W3 36）。 */
const MOCK_CONTROLS = [
  { id: 'head.yaw', sourceId: 'AngleX' },
  { id: 'arm.right.raise', sourceId: 'RArm' },
  { id: 'torso.hip', sourceId: 'HipAngleZ' },
  { id: 'torso.hip.forward', sourceId: 'HipAngleY' },
  { id: 'torso.hip.twist', sourceId: 'HipAngleX' },
];

/**
 * 起 mock 宿主。profile.broken = 坏画像（controls=20、设置页缺标题），用于验证 FAIL 路径。
 * 返回 { origin, close }。
 */
export function startMockHost(profile = {}) {
  const state = {
    holdUntil: 0,
    holdValue: 0.8,
    hipUntil: 0,
    hipValue: 0.5,
    pwPre: 2,
    pwPost: 5,
    ticks: 0,
    nextId: 1,
    calls: new Map(),
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    const send = (status, body) => {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(text);
    };
    if (req.method === 'GET' && url.pathname === '/dsh-l2d/ai/result') {
      const id = url.searchParams.get('id');
      if (id === '0') return send(200, { ready: false, events: [] });
      const entry = state.calls.get(id);
      if (!entry) return send(200, { ready: false, events: [] });
      return send(200, { ready: true, result: entry.result, events: entry.events || [] });
    }
    if (req.method === 'GET' && url.pathname === '/dsh-l2d/capability.json') {
      const n = profile.broken ? 20 : 59;
      const named = profile.broken ? [] : MOCK_CONTROLS;
      const filler = Array.from({ length: Math.max(0, n - named.length) }, (_, i) => ({ id: 'c' + i }));
      return send(200, { controls: [...named, ...filler], modelId: 'mock-model' });
    }
    if (req.method === 'GET' && url.pathname === '/dsh-l2d/settings') {
      const titles = profile.broken ? TITLES.slice(0, 4) : TITLES;
      return send(200, '<html>' + titles.map((t) => `<h2>${t}</h2>`).join('') + '</html>');
    }
    if (req.method === 'GET' && url.pathname === '/dsh-l2d/status.json') {
      return send(200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/dsh-l2d/ai/call') {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        let name = '';
        let a = {};
        try {
          const parsed = JSON.parse(raw);
          name = parsed.name || '';
          a = parsed.args || {};
        } catch {
          return send(400, { error: 'name required' });
        }
        state.ticks++;
        const finish = (result) => {
          const id = String(state.nextId++);
          state.calls.set(id, { result, events: result && result.__events ? result.__events : [] });
          if (result) delete result.__events;
          send(200, { id });
        };
        if (name === 'l2d_get_state') {
          return finish({
            info: {
              fpsCap: 60,
              vsyncHz: 60.0,
              pv: makePv(state),
              inj: makeInj(state),
              frames: 1000 + state.ticks * 10,
              utime: 12.34,
            },
            diag: { bootTag: 1793684582683 },
          });
        }
        if (name === 'l2d_posture') {
          const values = a.values || {};
          // M1-d1：torso.hip 语义通道 → Hip* pre 让位（mock PhysicsGate：pw pre 上涨、
          // 独占窗口内 pv 锁 Agent 值、到期回物理），回执带 phase='pre' 的 applied/owned
          const hipApplied = ['torso.hip', 'torso.hip.forward', 'torso.hip.twist']
            .filter((ch) => values[ch] !== undefined)
            .map((ch) => ({ id: MOCK_CONTROLS.find((c) => c.id === ch).sourceId, value: Number(values[ch]), channel: ch, phase: 'pre' }));
          if (hipApplied.length) {
            state.pwPre++;
            const hipX = hipApplied.find((x) => x.id === 'HipAngleX');
            if (hipX) {
              state.hipValue = hipX.value;
              state.hipUntil = Date.now() + Math.max(0, Number(a.durationMs) || 0);
            }
            return finish({
              ok: true,
              applied: hipApplied,
              failed: [],
              owned: hipApplied.map((x) => x.id),
              skipped: [],
              degraded: [],
              durationMs: Number(a.durationMs) || 0,
            });
          }
          // U1：RArm（语义 id 或裸参数名均可）→ post 覆盖
          const rarmValue = values.RArm !== undefined ? values.RArm : values['arm.right.raise'];
          if (rarmValue !== undefined) {
            state.holdValue = Number(rarmValue);
            state.holdUntil = Date.now() + Math.max(0, Number(a.durationMs) || 0);
            return finish({ ok: true, accepted: true });
          }
          return finish({ ok: true, accepted: true });
        }
        if (name === 'l2d_set_parameters') {
          if (a.values && a.values.ParamMouthOpenY !== undefined) {
            return send(400, { error: 'reserved-param: ParamMouthOpenY（口型禁区）' });
          }
          return finish({ ok: true });
        }
        if (name === 'l2d_play_keyframes') {
          const tracks = Array.isArray(a.tracks) ? a.tracks : [];
          if (tracks.some((t) => t.param === 'ParamMouthOpenY')) {
            return send(400, { error: 'reserved-param: ParamMouthOpenY（口型禁区）' });
          }
          return finish({ ok: true });
        }
        if (name === 'l2d_play_motion') {
          if (a.group === 'Idle') return send(400, { error: 'idle-not-playable: Idle' });
          if (!a.group || a.group.startsWith('__M1Smoke_')) {
            return send(400, { error: 'unknown-motion-group: ' + (a.group || '') });
          }
          return finish({ ok: true });
        }
        if (name === 'l2d_act') {
          // mock m1-gesture：回执带仲裁标记
          return finish({ ok: true, runId: 'mock-run-1', notes: ['gesture-timeline-arbitrated'] });
        }
        if (name === 'l2d_reset') return finish({ ok: true });
        return send(400, { error: 'unknown tool: ' + name });
      });
      return;
    }
    send(404, { error: 'not found: ' + req.method + ' ' + url.pathname });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }),
    );
  });
}

let out = '';
const origLog = console.log;
function selftestStart() {
  out = '';
  console.log = (...xs) => {
    out += xs.join(' ') + '\n';
  };
}
function selftestStop() {
  console.log = origLog;
}

export async function selftest() {  const fails = [];
  const check = (label, cond) => {
    origLog(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
    if (!cond) fails.push(label);
  };

  // ---- 1) 纯判定辅助 ----
  origLog('\n[selftest] 1) 判定辅助');
  check('parsePv 提取 RArm', parsePv('AngleX=0.100 RArm=0.800 chg=yes', 'RArm') === 0.8);
  check('parsePv 提取负值', parsePv('AngleX=-1.234 RArm=0.8', 'AngleX') === -1.234);
  check('parsePv 缺参返回 null', parsePv('AngleX=0.1', 'RArm') === null);
  check('parsePv 非串返回 null', parsePv(null, 'RArm') === null);
  check('parsePv 参数名是前缀不误匹配（LArm vs LArm2）', parsePv('LArm2=0.500 LArm=0.700', 'LArm') === 0.7);
  check('parsePw 提取 [pre,post]', JSON.stringify(parsePw('calls=1 pw=3/5 seen=1/1')) === '[3,5]');
  check('parsePw 非串返回 null', parsePw(undefined) === null);
  check('driftedFromHold 覆盖中不漂移', !driftedFromHold(0.8, 0.8));
  check('driftedFromHold 偏离即漂移', driftedFromHold(0.35, 0.8));
  check('driftedFromHold null 安全', !driftedFromHold(null, 0.8));
  check('resolveM1Flag on', resolveM1Flag('on', null).on === true);
  check('resolveM1Flag off', resolveM1Flag('off', null).on === false);
  check('resolveM1Flag auto 未接线回落 off', resolveM1Flag('auto', null).on === false);
  check('resolveM1Flag auto 命中 diag.m1', resolveM1Flag('auto', { m1: true }).on === true);

  // ---- 2) flag on + allow-write：全 M1 自动化用例 PASS ----
  origLog('\n[selftest] 2) mock 宿主 · flag on + allow-write（真用例路径）');
  const m1 = await startMockHost();
  try {
    selftestStart();
    const s2 = await runCases({
      origin: m1.origin,
      allowWrite: true,
      m1Flag: 'on',
      hipReady: true,
      gestureReady: true,
      holdMs: 1500,
    });
    selftestStop();
    check('0 FAIL', s2.failed === 0);
    check('基线 T0..T3 全 PASS', s2.results.filter((r) => r.name.startsWith('T')).every((r) => r.verdict === true));
    const expectPass = ['U1 acquire→post 覆盖', 'U2 release 回物理', 'U3 口型红线（任何通道 400）', 'U4 未索引组拒绝', 'U5 Hip pre 让位', 'U6 gesture 仲裁'];
    for (const name of expectPass) {
      const r = s2.results.find((x) => x.name === name);
      check(`${name} PASS`, !!r && r.verdict === true);
    }
    check('人工项保持 SKIP', s2.results.filter((r) => r.auto === '需人工').every((r) => r.verdict === 'skip'));
  } finally {
    m1.close();
  }

  // ---- 3) flag off：M1 组整组 SKIP（= 真机 SKIP 验收形态，exit 0） ----
  origLog('\n[selftest] 3) mock 宿主 · flag off（回滚基线模式）');
  const m3 = await startMockHost();
  try {
    selftestStart();
    const s3 = await runCases({ origin: m3.origin, allowWrite: true, m1Flag: 'off' });
    selftestStop();
    check('0 FAIL', s3.failed === 0);
    const m1Group = s3.results.find((r) => r.name === 'M1 新用例组');
    check('M1 组 SKIP', !!m1Group && m1Group.verdict === 'skip');
    check('U1..U6 未执行（结果集无 PASS 的 U 项）', s3.results.every((r) => !(r.name.startsWith('U') && r.verdict === true)));
    check('基线照常 PASS', s3.results.filter((r) => r.name.startsWith('T')).every((r) => r.verdict === true));
  } finally {
    m3.close();
  }

  // ---- 4) flag on 但未 allow-write：M1 组 SKIP（对其他分支实例只 GET） ----
  origLog('\n[selftest] 4) mock 宿主 · flag on 未 allow-write');
  const m4 = await startMockHost();
  try {
    selftestStart();
    const s4 = await runCases({ origin: m4.origin, allowWrite: false, m1Flag: 'on' });
    selftestStop();
    check('0 FAIL', s4.failed === 0);
    const m1Group = s4.results.find((r) => r.name === 'M1 新用例组');
    check('M1 组 SKIP（写路径保护）', !!m1Group && m1Group.verdict === 'skip' && m1Group.detail.includes('--allow-write'));
  } finally {
    m4.close();
  }

  // ---- 5) 占位依赖：hip / gesture 未交付时 SKIP 不拉低 verdict ----
  origLog('\n[selftest] 5) mock 宿主 · 占位依赖 SKIP');
  const m5 = await startMockHost();
  try {
    selftestStart();
    const s5 = await runCases({ origin: m5.origin, allowWrite: true, m1Flag: 'on', hipReady: false, gestureReady: false, holdMs: 1500 });
    selftestStop();
    check('0 FAIL', s5.failed === 0);
    check('U5 SKIP 占位', s5.results.find((r) => r.name === 'U5 Hip pre 让位')?.verdict === 'skip');
    check('U6 SKIP 占位', s5.results.find((r) => r.name === 'U6 gesture 仲裁')?.verdict === 'skip');
    check('其余 M1 用例照常判定', s5.results.find((r) => r.name === 'U1 acquire→post 覆盖')?.verdict === true);
  } finally {
    m5.close();
  }

  // ---- 6) FAIL 路径：坏画像 mock 必须产生 FAIL（不被 SKIP 语义吞掉） ----
  origLog('\n[selftest] 6) mock 宿主 · 坏画像（FAIL 路径）');
  const m6 = await startMockHost({ broken: true });
  try {
    selftestStart();
    const s6 = await runCases({ origin: m6.origin, allowWrite: false, m1Flag: 'off' });
    selftestStop();
    check('T1 FAIL（controls=20 ≠ 契约 59）', s6.results.find((r) => r.name === 'T1 画像契约')?.verdict === false);
    check('T2 FAIL（缺分区标题）', s6.results.find((r) => r.name === 'T2 设置页')?.verdict === false);
    check('failed 计数 > 0（exit 1 路径）', s6.failed >= 2);
  } finally {
    m6.close();
  }

  origLog(
    `\n[selftest] ${fails.length ? 'FAIL ' + fails.length + ' 项：' + fails.join('；') : '全部断言通过（mock 宿主跑通 PASS/SKIP/FAIL 全部路径）'}`,
  );
  return fails.length === 0;
}
