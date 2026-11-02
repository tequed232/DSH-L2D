/**
 * Ownership spec 用例数据（可执行）。
 * 覆盖 docs/Ownership-Invariants.md 的 CASE-01…24；实现方用 run.mjs 跑自己的 resolveWritePlan。
 */

const limb = (id, params, { phase = 'post', priority = 50, runId = 'r1' } = {}) => ({
  id, source: 'limb', priority, phase, params, ...(runId !== undefined ? { runId } : {}),
});
const src = (source, id, params, { phase = 'post', priority = 50, runId } = {}) => ({
  id, source, priority, phase, params, ...(runId !== undefined ? { runId } : {}),
});

export const cases = [
  {
    id: 'CASE-01',
    desc: '叶子四肢被 acquire 后，limb post 胜出，physics 值被忽略',
    input: {
      now: 1000,
      intents: [limb('i1', { RArm: 1 })],
      ownership: { RArm: { owner: 'limb', runId: 'r1' } },
      physics: { RArm: 0.2 },
    },
    expect: {
      writes: [{ id: 'RArm', value: 1, source: 'limb', phase: 'post' }],
      rejected: [],
    },
  },
  {
    id: 'CASE-02',
    desc: '未 acquire 写四肢 → 拒绝；physics 值照常输出',
    input: {
      now: 1000,
      intents: [limb('i1', { RArm: 1 })],
      physics: { RArm: 0.5 },
    },
    expect: {
      writes: [{ id: 'RArm', value: 0.5, source: 'physics', phase: 'post' }],
      rejected: [{ id: 'RArm', source: 'limb', reason: 'not-owned' }],
    },
  },
  {
    id: 'CASE-03',
    desc: '独占期间其他 source（keyframes）写同参数 → 拒绝，limb 胜出',
    input: {
      now: 1000,
      intents: [limb('i1', { RArm: 1 }), src('keyframes', 'i2', { RArm: 2 })],
      ownership: { RArm: { owner: 'limb', runId: 'r1' } },
    },
    expect: {
      writes: [{ id: 'RArm', value: 1, source: 'limb', phase: 'post' }],
      rejected: [{ id: 'RArm', source: 'keyframes', reason: 'not-owned' }],
    },
  },
  {
    id: 'CASE-04',
    desc: 'limb 越界写姿态参数（Param36）→ 拒绝；pose 正常胜出',
    input: {
      now: 1000,
      intents: [limb('i1', { Param36: 1 }), src('pose', 'i2', { Param36: 0.3 })],
    },
    expect: {
      writes: [{ id: 'Param36', value: 0.3, source: 'pose', phase: 'post' }],
      rejected: [{ id: 'Param36', source: 'limb', reason: 'not-owned' }],
    },
  },
  {
    id: 'CASE-05',
    desc: 'HipAngleX 被 acquire：limb pre 写胜出，physics 让位',
    input: {
      now: 1000,
      intents: [limb('i1', { HipAngleX: 5 }, { phase: 'pre' })],
      ownership: { HipAngleX: { owner: 'limb', runId: 'r1' } },
      physics: { HipAngleX: 1 },
    },
    expect: {
      writes: [{ id: 'HipAngleX', value: 5, source: 'limb', phase: 'pre' }],
      rejected: [],
    },
  },
  {
    id: 'CASE-06',
    desc: 'HipAngleX 未 acquire：limb pre 写拒绝，physics 胜出',
    input: {
      now: 1000,
      intents: [limb('i1', { HipAngleX: 5 }, { phase: 'pre' })],
      physics: { HipAngleX: 1 },
    },
    expect: {
      writes: [{ id: 'HipAngleX', value: 1, source: 'physics', phase: 'pre' }],
      rejected: [{ id: 'HipAngleX', source: 'limb', reason: 'not-owned' }],
    },
  },
  {
    id: 'CASE-07',
    desc: 'HipAngleX 已 acquire 但用 post 相位 → wrong-phase，无 winner（物理让位）',
    input: {
      now: 1000,
      intents: [limb('i1', { HipAngleX: 5 }, { phase: 'post' })],
      ownership: { HipAngleX: { owner: 'limb', runId: 'r1' } },
      physics: { HipAngleX: 1 },
    },
    expect: {
      writes: [],
      rejected: [{ id: 'HipAngleX', source: 'limb', reason: 'wrong-phase' }],
    },
  },
  {
    id: 'CASE-08',
    desc: '叶子四肢已 acquire 但用 pre 相位 → wrong-phase',
    input: {
      now: 1000,
      intents: [limb('i1', { RArm: 1 }, { phase: 'pre' })],
      ownership: { RArm: { owner: 'limb', runId: 'r1' } },
      physics: { RArm: 0.4 },
    },
    expect: {
      writes: [],
      rejected: [{ id: 'RArm', source: 'limb', reason: 'wrong-phase' }],
    },
  },
  {
    id: 'CASE-09',
    desc: 'acquire 已超时（expiresAt 过期）→ 视为释放，physics 恢复',
    input: {
      now: 1000,
      intents: [limb('i1', { RArm: 1 })],
      ownership: { RArm: { owner: 'limb', runId: 'r1', expiresAt: 500 } },
      physics: { RArm: 0.5 },
    },
    expect: {
      writes: [{ id: 'RArm', value: 0.5, source: 'physics', phase: 'post' }],
      rejected: [{ id: 'RArm', source: 'limb', reason: 'not-owned' }],
    },
  },
  {
    id: 'CASE-10',
    desc: 'runId 不匹配（所有权属于 r2，intent 是 r1）→ 拒绝，物理让位且无 winner',
    input: {
      now: 1000,
      intents: [limb('i1', { RArm: 1 }, { runId: 'r1' })],
      ownership: { RArm: { owner: 'limb', runId: 'r2' } },
      physics: { RArm: 0.5 },
    },
    expect: {
      writes: [],
      rejected: [{ id: 'RArm', source: 'limb', reason: 'not-owned' }],
    },
  },
  {
    id: 'CASE-11',
    desc: '口型参数任何通道都拒绝（含 physics 值）',
    input: {
      now: 1000,
      intents: [src('gaze', 'i1', { ParamMouthOpenY: 1 })],
      physics: { ParamMouthOpenY: 0.3 },
    },
    expect: {
      writes: [],
      rejected: [{ id: 'ParamMouthOpenY', source: 'gaze', reason: 'lipsync' }],
    },
  },
  {
    id: 'CASE-12',
    desc: '普通姿态参数：pose post 胜出',
    input: {
      now: 1000,
      intents: [src('pose', 'i1', { Param36: 0.3 })],
    },
    expect: {
      writes: [{ id: 'Param36', value: 0.3, source: 'pose', phase: 'post' }],
      rejected: [],
    },
  },
  {
    id: 'CASE-13',
    desc: '同优先级 pose vs keyframes → pose（秩更高）',
    input: {
      now: 1000,
      intents: [src('pose', 'i1', { Param36: 0.3 }), src('keyframes', 'i2', { Param36: 0.6 })],
    },
    expect: {
      writes: [{ id: 'Param36', value: 0.3, source: 'pose', phase: 'post' }],
      rejected: [],
    },
  },
  {
    id: 'CASE-14',
    desc: '同优先级 pose vs motion → pose',
    input: {
      now: 1000,
      intents: [src('motion', 'i1', { Param36: 0.9 }), src('pose', 'i2', { Param36: 0.3 })],
    },
    expect: {
      writes: [{ id: 'Param36', value: 0.3, source: 'pose', phase: 'post' }],
      rejected: [],
    },
  },
  {
    id: 'CASE-15',
    desc: 'FORCE gaze vs NORMAL ambient 同根输入 → 优先级高者胜',
    input: {
      now: 1000,
      intents: [
        src('gaze', 'i1', { AngleX: 1 }, { phase: 'pre', priority: 90 }),
        src('ambient', 'i2', { AngleX: 0.5 }, { phase: 'pre', priority: 50 }),
      ],
    },
    expect: {
      writes: [{ id: 'AngleX', value: 1, source: 'gaze', phase: 'pre' }],
      rejected: [],
    },
  },
  {
    id: 'CASE-16',
    desc: 'BACKGROUND motion vs NORMAL pose → pose',
    input: {
      now: 1000,
      intents: [
        src('motion', 'i1', { Param36: 0.9 }, { priority: 10 }),
        src('pose', 'i2', { Param36: 0.3 }, { priority: 50 }),
      ],
    },
    expect: {
      writes: [{ id: 'Param36', value: 0.3, source: 'pose', phase: 'post' }],
      rejected: [],
    },
  },
  {
    id: 'CASE-17',
    desc: '同 source 同参数多条 → 后者覆盖（仍只一条）',
    input: {
      now: 1000,
      intents: [src('keyframes', 'a', { Param36: 0.2 }), src('keyframes', 'b', { Param36: 0.5 })],
    },
    expect: {
      writes: [{ id: 'Param36', value: 0.5, source: 'keyframes', phase: 'post' }],
      rejected: [],
    },
  },
  {
    id: 'CASE-18',
    desc: '非法数值 → rejected(invalid-value)',
    input: {
      now: 1000,
      intents: [src('pose', 'i1', { Param36: Number.NaN })],
    },
    expect: {
      writes: [],
      rejected: [{ id: 'Param36', source: 'pose', reason: 'invalid-value' }],
    },
  },
  {
    id: 'CASE-19',
    desc: '提供 bounds 时钳制',
    input: {
      now: 1000,
      intents: [src('pose', 'i1', { Param36: 5 })],
      bounds: { Param36: { min: -1, max: 1 } },
    },
    expect: {
      writes: [{ id: 'Param36', value: 1, source: 'pose', phase: 'post' }],
      rejected: [],
    },
  },
  {
    id: 'CASE-20',
    desc: '提供 knownParams 时未知参数拒绝',
    input: {
      now: 1000,
      intents: [src('pose', 'i1', { NoSuchParam: 1 })],
      knownParams: ['Param36'],
    },
    expect: {
      writes: [],
      rejected: [{ id: 'NoSuchParam', source: 'pose', reason: 'unknown-param' }],
    },
  },
  {
    id: 'CASE-21',
    desc: '空帧无副作用',
    input: { now: 1000, intents: [] },
    expect: { writes: [], rejected: [] },
  },
  {
    id: 'CASE-22',
    desc: '输出与 intents 顺序无关（确定性）',
    input: {
      now: 1000,
      intents: [
        src('keyframes', 'i1', { Param36: 0.2 }, { priority: 10 }),
        src('pose', 'i2', { Param36: 0.4 }, { priority: 50 }),
      ],
    },
    shuffle: true,
    expect: {
      writes: [{ id: 'Param36', value: 0.4, source: 'pose', phase: 'post' }],
      rejected: [],
    },
  },
  {
    id: 'CASE-23',
    desc: 'limb 功能关闭：独占失效，limb 拒绝、physics 恢复',
    input: {
      now: 1000,
      limbEnabled: false,
      intents: [limb('i1', { RArm: 1 })],
      ownership: { RArm: { owner: 'limb', runId: 'r1' } },
      physics: { RArm: 0.5 },
    },
    expect: {
      writes: [{ id: 'RArm', value: 0.5, source: 'physics', phase: 'post' }],
      rejected: [{ id: 'RArm', source: 'limb', reason: 'not-owned' }],
    },
  },
  {
    id: 'CASE-24',
    desc: '同一参数两个 limb intent 不同 runId：只接受当前 runId',
    input: {
      now: 1000,
      intents: [
        limb('i1', { RArm: 0.7 }, { runId: 'r1' }),
        limb('i2', { RArm: 0.8 }, { runId: 'r2' }),
      ],
      ownership: { RArm: { owner: 'limb', runId: 'r2' } },
    },
    expect: {
      writes: [{ id: 'RArm', value: 0.8, source: 'limb', phase: 'post' }],
      rejected: [{ id: 'RArm', source: 'limb', reason: 'not-owned' }],
    },
  },
];
