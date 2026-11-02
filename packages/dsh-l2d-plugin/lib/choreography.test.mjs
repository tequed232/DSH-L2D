import assert from 'node:assert/strict';
import {
  CHOREOGRAPHY,
  CHOREOGRAPHY_STATES,
  DEFAULT_GATE,
  aggregateWorkspaceState,
  assertValidChoreography,
  decide,
  estimateLifeMs,
  validateChoreography,
} from './choreography.mjs';

// 1. 默认编排本身必须零错误零警告。
const valid = assertValidChoreography();
assert.equal(valid.warnings.length, 0, '默认编排不应有警告：' + valid.warnings.join('; '));
for (const state of CHOREOGRAPHY_STATES) assert.ok(CHOREOGRAPHY[state], '缺 ' + state);

// 2. 时长估算必须和 overlay.js plannedLifeMs 同口径（400 起步，每步 1800，closeMotion 另算）。
assert.equal(estimateLifeMs([{ kind: 'look', x: 0, y: 0 }]), 1800);
assert.equal(estimateLifeMs([{ kind: 'look', x: 0, y: 0 }, { kind: 'expression', name: '兔牙', delayMs: 120 }]), 1920);
assert.equal(
  estimateLifeMs([
    { kind: 'look', x: 0, y: 0 },
    { kind: 'expression', name: '兔牙', delayMs: 120 },
    { kind: 'motion', name: '竖手指打开', closeMotion: '竖手指关闭', closeAfterMs: 1800, delayMs: 200 },
  ]),
  2320,
);
assert.ok(estimateLifeMs(CHOREOGRAPHY['user-direct'].chain) < DEFAULT_GATE.maxLifeMs);

// 3. 首次进入状态：抖动门放行。
const t0 = 1_000_000;
const fresh = decide({ state: 'thinking', previousState: 'idle', stateSince: t0 - 2000, now: t0, lastAnyFireAt: 0 });
assert.equal(fresh.fire, true);
assert.equal(fresh.reason, 'fire');
assert.equal(fresh.priority, 'BACKGROUND');
assert.notEqual(fresh.chain, CHOREOGRAPHY.thinking.chain, 'chain 必须是副本，调用方改动不能污染数据');

// 4. 同状态不重播；持续态到 refreshMs 后补脉冲。
const same = decide({ state: 'thinking', previousState: 'thinking', stateSince: t0 - 5000, now: t0, lastFireAtByState: { thinking: t0 - 5000 }, lastAnyFireAt: t0 - 5000 });
assert.equal(same.fire, false);
assert.equal(same.reason, 'same-state');

const pulse = decide({ state: 'working', previousState: 'working', stateSince: t0 - 60000, now: t0, lastFireAtByState: { working: t0 - 30000 }, lastAnyFireAt: t0 - 30000 });
assert.equal(pulse.fire, true);
assert.equal(pulse.reason, 'fire');

// 5. 状态切换后冷却未到：cooldown。
const cooling = decide({ state: 'attention', previousState: 'working', stateSince: t0 - 1000, now: t0, lastFireAtByState: { attention: t0 - 3000 }, lastAnyFireAt: t0 - 3000 });
assert.equal(cooling.fire, false);
assert.equal(cooling.reason, 'cooldown');
assert.ok(cooling.retryAfterMs > 0);

// 6. 全局最小间隔挡住密集连发。
const gap = decide({ state: 'error', previousState: 'attention', stateSince: t0 - 500, now: t0, lastAnyFireAt: t0 - 200 });
assert.equal(gap.fire, false);
assert.equal(gap.reason, 'min-gap');

// 7. 翻转风暴：环境状态静音，事件状态照常。
const flips = [t0 - 1000, t0 - 2000, t0 - 3000, t0 - 4000];
const jitter = decide({ state: 'thinking', previousState: 'working', stateSince: t0 - 5000, now: t0, lastAnyFireAt: 0, flips });
assert.equal(jitter.fire, false);
assert.equal(jitter.reason, 'jitter');
const event = decide({ state: 'attention', previousState: 'working', stateSince: t0 - 5000, now: t0, lastAnyFireAt: 0, flips });
assert.equal(event.fire, true);

// 8. force（用户直接对话）绕过抖动与冷却，但仍保留时长语义。
const forced = decide({ state: 'user-direct', previousState: 'user-direct', stateSince: t0 - 100, now: t0, lastFireAtByState: { 'user-direct': t0 - 100 }, lastAnyFireAt: t0 - 100, flips, force: true });
assert.equal(forced.fire, true);
assert.equal(forced.priority, 'FORCE');

// 9. 频次上限。
const rate = decide({
  state: 'attention',
  previousState: 'working',
  stateSince: t0 - 5000,
  now: t0,
  lastFireAtByState: { attention: t0 - 20000 },
  lastAnyFireAt: t0 - 2000,
  fires: [t0 - 50000, t0 - 20000],
});
assert.equal(rate.fire, false);
assert.equal(rate.reason, 'rate');

// 10. 未知状态不炸。
const unknown = decide({ state: 'no-such-state', now: t0 });
assert.equal(unknown.fire, false);
assert.equal(unknown.reason, 'unknown-state');

// 11. 工作区聚合优先级：error > attention > working > thinking > idle。
const snapshot = {
  workspaces: [
    { workspaceId: 'a', title: 'A', sessions: [{ state: 'working' }] },
    { workspaceId: 'b', title: 'B', sessions: [{ state: 'attention' }, { state: 'thinking' }] },
  ],
};
assert.equal(aggregateWorkspaceState(snapshot).state, 'attention');
snapshot.workspaces.push({ workspaceId: 'c', title: 'C', sessions: [{ state: 'error' }] });
assert.equal(aggregateWorkspaceState(snapshot).state, 'error');
assert.equal(aggregateWorkspaceState(snapshot, 'c').state, 'attention', '自己的工作区要排除');
assert.equal(aggregateWorkspaceState({ workspaces: [] }).state, 'idle');
assert.equal(aggregateWorkspaceState({ workspaces: [{ workspaceId: 'x', sessions: [] }] }).state, 'idle');

// 12. 校验器要能抓住常见错误。
const bad = {
  ...CHOREOGRAPHY,
  thinking: { ...CHOREOGRAPHY.thinking, priority: 'HIGH', chain: [{ kind: 'expression', name: '不存在的表情' }] },
  attention: { ...CHOREOGRAPHY.attention, chain: [{ kind: 'motion', name: '竖手指打开', closeMotion: '狗尾巴草关闭' }] },
  error: { ...CHOREOGRAPHY.error, chain: [{ kind: 'look', x: 2, y: 0 }] },
  idle: { ...CHOREOGRAPHY.idle, chain: [{ kind: 'look', x: 0, y: 0, bogus: 1 }] },
};
const badResult = validateChoreography(bad);
assert.equal(badResult.ok, false);
assert.ok(badResult.errors.some((text) => text.includes('priority')));
assert.ok(badResult.errors.some((text) => text.includes('表情名不存在')));
assert.ok(badResult.errors.some((text) => text.includes('closeMotion 必须是')));
assert.ok(badResult.errors.some((text) => text.includes('look.x')));
assert.ok(badResult.errors.some((text) => text.includes('未知字段')));
assert.equal(badResult.errors.some((text) => text.includes('口型')), false);

const mouth = JSON.parse(JSON.stringify(CHOREOGRAPHY));
mouth.idle.chain.push({ kind: 'look', x: 0, y: 0, name: 'ParamMouthOpenY' });
assert.ok(validateChoreography(mouth).errors.some((text) => text.includes('口型参数')));

const missing = { ...CHOREOGRAPHY };
delete missing.bootstrap;
assert.ok(validateChoreography(missing).errors.some((text) => text.includes('缺状态 bootstrap')));

const tooLong = {
  ...CHOREOGRAPHY,
  idle: { ...CHOREOGRAPHY.idle, chain: Array.from({ length: 9 }, () => ({ kind: 'look', x: 0, y: 0 })) },
};
assert.ok(validateChoreography(tooLong).errors.some((text) => text.includes('超过 8 步')));

const longChain = {
  ...CHOREOGRAPHY,
  idle: {
    ...CHOREOGRAPHY.idle,
    chain: [{ kind: 'motion', name: '竖手指打开', closeMotion: '竖手指关闭', closeAfterMs: 11000 }],
  },
};
assert.ok(validateChoreography(longChain).errors.some((text) => text.includes('估算时长')));

// 13. 换模型时白名单可覆盖。
const other = validateChoreography(CHOREOGRAPHY, { expressions: ['兔牙'], motionGroups: ['竖手指打开', '竖手指关闭'] });
assert.ok(other.errors.some((text) => text.includes('不在当前模型表')));

// 14. 回归：refreshMs 门禁。持续态没到刷新周期不重播——即使 cooldown 已经过了。
//     working 的 cooldown 只有 8s、refreshMs 是 25s；修复前这里会在 10s 时就补脉冲。
const notYetRefresh = decide({
  state: 'working',
  previousState: 'working',
  stateSince: t0 - 30000,
  now: t0,
  lastFireAtByState: { working: t0 - 10000 },
  lastAnyFireAt: t0 - 10000,
});
assert.equal(notYetRefresh.fire, false);
assert.equal(notYetRefresh.reason, 'refresh');
assert.ok(notYetRefresh.retryAfterMs > 0 && notYetRefresh.retryAfterMs <= 15000);

// 15. 回归：频次预算跨状态隔离。working 的高频次不能挤占 attention 的额度。
const isolated = decide({
  state: 'attention',
  previousState: 'working',
  stateSince: t0 - 5000,
  now: t0,
  lastFireAtByState: { attention: t0 - 30000 },
  lastAnyFireAt: t0 - 30000,
  firesByState: { working: [t0 - 1000, t0 - 2000, t0 - 3000], attention: [t0 - 50000] },
});
assert.equal(isolated.fire, true);
assert.equal(isolated.reason, 'fire');
// 同一批记录走旧口径（扁平 fires）会命中 rate——证明隔离真的生效，不是记录变少了。
const flatSame = decide({
  state: 'attention',
  previousState: 'working',
  stateSince: t0 - 5000,
  now: t0,
  lastFireAtByState: { attention: t0 - 30000 },
  lastAnyFireAt: t0 - 30000,
  fires: [t0 - 1000, t0 - 2000, t0 - 3000],
});
assert.equal(flatSame.fire, false);
assert.equal(flatSame.reason, 'rate');

// 16. 回归：缺 stateSince 时无法证明「已稳定」，按刚进入处理（fail-closed，dwell 挡住）。
const noSince = decide({ state: 'thinking', previousState: 'idle', now: t0, lastAnyFireAt: 0 });
assert.equal(noSince.fire, false);
assert.equal(noSince.reason, 'dwell');
assert.ok(noSince.retryAfterMs > 0);

console.log('choreography: ok');
