/**
 * 工作区状态 → Live2D 动作链编排（v1）。
 *
 * 纯数据 + 纯函数：不 fetch、不读文件、不碰 DOM、不接线。
 * 后续由 workspace-agent.mjs 的通知链路调用 decide() 决定「这条反应发不发」，
 * 命中的 chain 原样交给 /dsh-l2d/ai/call 的 l2d_act（或让专属 Agent 用同一份数据调 MCP 工具）。
 *
 * 状态来源（只读、脱敏）：
 *   packages/dsh-l2d-plugin/lib/index.js  deriveAgentState() 产出
 *   thinking / working / attention / error / idle
 * 外加两个本地状态：
 *   bootstrap    专属工作区/渲染首次就绪
 *   user-direct  用户直接在 Live2D Agent 会话里说话（最高优先级，走 phase 模板更自然）
 *
 * 设计口径：
 *   - 环境状态（thinking / working / idle）一律 BACKGROUND，可被任何东西打断；
 *     事件状态（attention / error / bootstrap）NORMAL；用户直接对话 FORCE。
 *   - 链只做表情 / 动作 / 姿势 / 视线四类，不写任何底层参数，更不写口型。
 *   - 时长按 overlay.js 的 plannedLifeMs 公式估算，单链 < 10s，避免 MCP 12s 超时拿到 pending。
 *   - 抖动保护：状态必须稳定 minDwellMs，同状态冷却 cooldownMs，全局最小间隔 minGapMs，
 *     翻转风暴（flipWindowMs 内超过 maxFlips 次）时只压环境状态，不压事件状态。
 *
 * 模型事实（大肥鱼.dsl2d.2048.model3.json，2026-11 实测）：
 *   7 个动作组、21 个表情；参数 509；成对动作由 motion-director 状态机托管。
 *   换模型时用 validateChoreography(map, { expressions, motionGroups }) 传新表。
 */

export const CHOREOGRAPHY_VERSION = 1;

// 口型禁区名单单一事实源（宿主/MCP/编排共用一份，避免各写一份漂移）。
import { collectReservedParams } from './param-guards.mjs';

/** 编排覆盖的状态。顺序是判定优先级从高到低（见 aggregateWorkspaceState）。 */
export const CHOREOGRAPHY_STATES = [
  'error',
  'attention',
  'working',
  'thinking',
  'idle',
  'bootstrap',
  'user-direct',
];

export const ACT_PRIORITIES = ['BACKGROUND', 'NORMAL', 'FORCE'];

export const STEP_KINDS = ['expression', 'motion', 'pose', 'look'];

/** 模型里真实存在的表情名。写错名字 l2d_set_expression 会直接失败，所以这里做白名单。 */
export const MODEL_EXPRESSIONS = [
  '兔牙',
  '加载',
  '单片眼镜',
  '圈圈眼',
  '屑',
  '流泪',
  '爱心眼',
  '脱鞋',
  '脸红',
  '钢盆',
  '裙长切换',
  '黑框眼镜',
  '黑脸',
  '＞＜',
  '体型1',
  '体型2',
  '默认体型',
  '前倾',
  '尾巴开关',
  '流冷汗',
  '胸口衣服',
];

/**
 * 可以手动播的动作组。Idle 不在里面：待机由 lappmodel 的 isFinished 自动重启，
 * 手动播会和引擎抢同一组。
 */
export const MODEL_MOTION_GROUPS = [
  '抚胸手打开',
  '抚胸手关闭',
  '竖手指打开',
  '竖手指关闭',
  '狗尾巴草打开',
  '狗尾巴草关闭',
];

/** 打开 → 关闭的配对。只允许成对写，避免手停在半空。 */
export const PAIRED_CLOSES = {
  抚胸手打开: '抚胸手关闭',
  竖手指打开: '竖手指关闭',
  狗尾巴草打开: '狗尾巴草关闭',
};

export const POSE_VALUES = ['rest', 'finger', 'grass', 'chest'];

export const STEP_KEYS = new Set([
  'kind',
  'name',
  'clear',
  'closeMotion',
  'closeAfterMs',
  'delayMs',
  'pose',
  'x',
  'y',
  // Action Chain v2：并行组（宿主只做静态可判定校验，参数重叠降级在 renderer）
  'group',
  'mode',
  'timeoutMs',
]);

/** 并行组 id：只允许安全字符，长度 1~32（会进回执与诊断）。 */
export const GROUP_ID_RE = /^[A-Za-z0-9_.:-]{1,32}$/;

/**
 * 步字段白名单的显式数组形式（与 STEP_KEYS 同一内容，供编辑器构建期复用）。
 * 新增步字段时只改 STEP_KEYS，这里自动跟随。
 */
export const STEP_FIELD_KEYS = Object.freeze([...STEP_KEYS]);

/**
 * validateStep 内部使用的数值域（以既有硬编码值为准提取，供编辑器构建期复用）。
 * look 的 x/y 同域（-1~1）；改动取值域必须同步 validateStep，两边测试互相对拍。
 */
export const STEP_FIELD_RANGES = Object.freeze({
  delayMs: [0, 5000],
  closeAfterMs: [300, 12000],
  timeoutMs: [0, 8000],
  x: [-1, 1],
  y: [-1, 1],
});

/** 组语义：sequence 按顺序；parallel 同 elapsed 一次投放（必须带 group）。 */
export const STEP_MODES = ['sequence', 'parallel'];

/** 抖动门默认值。可按状态覆盖（entry.maxFlips / entry.flipWindowMs）。 */
export const DEFAULT_GATE = {
  /** 任意两条编排之间至少隔这么久，防「连续抽搐」。 */
  minGapMs: 1500,
  /** 翻转统计窗口。 */
  flipWindowMs: 20000,
  /** 窗口内状态翻转超过这个次数，环境状态一律静音。 */
  maxFlips: 4,
  /** 单链时长上限（估算值），留 2s 余量给 MCP 的 12s 轮询。 */
  maxLifeMs: 10000,
};

/**
 * STATE → chain。字段说明见 docs/动作链编排-v1.md。
 * chain 里 delayMs 是该步相对前一步的延迟；motion 步的 closeAfterMs 是开播后多久收招。
 */
export const CHOREOGRAPHY = {
  bootstrap: {
    id: 'bootstrap',
    label: '就绪',
    trigger: '专属工作区创建成功 / 叠加层首次 ready（每个 DSH 进程一次）',
    priority: 'NORMAL',
    chain: [
      { kind: 'look', x: 0, y: 0.04 },
      { kind: 'expression', name: '兔牙', delayMs: 120 },
    ],
    bubble: null,
    cooldownMs: 600000,
    minDwellMs: 0,
    refreshMs: 0,
    maxInWindow: 1,
    windowMs: 600000,
    fallback: '渲染未就绪时丢弃，等下一次通知；不重试、不排队。',
  },

  thinking: {
    id: 'thinking',
    label: '思考（轻）',
    trigger: '其他工作区有会话处于 thinking（用户刚提交 / 正在生成）',
    priority: 'BACKGROUND',
    chain: [
      { kind: 'look', x: 0.3, y: 0.32 },
      { kind: 'expression', name: '＞＜', delayMs: 120 },
    ],
    bubble: null,
    cooldownMs: 9000,
    minDwellMs: 800,
    refreshMs: 0,
    maxInWindow: 3,
    windowMs: 60000,
    fallback: '表情名多模型不一致时删掉 expression 步只留 look；被高优先级占槽则直接丢。',
  },

  working: {
    id: 'working',
    label: '忙活（持续）',
    trigger: '其他工作区有会话在 working（有 tool/call）；持续期间按 refreshMs 轻脉冲',
    priority: 'BACKGROUND',
    chain: [
      { kind: 'expression', name: '加载' },
      { kind: 'look', x: 0.18, y: 0.08, delayMs: 80 },
    ],
    bubble: null,
    cooldownMs: 8000,
    minDwellMs: 1200,
    refreshMs: 25000,
    maxInWindow: 3,
    windowMs: 60000,
    fallback: '持续状态只补视线脉冲，不重复播动作、不弹气泡；被占槽就等下个 refresh。',
  },

  attention: {
    id: 'attention',
    label: '轮到你',
    trigger: '其他工作区有会话 turn/end 且不是错误（等你接手）',
    priority: 'NORMAL',
    chain: [
      { kind: 'look', x: 0, y: 0.05 },
      { kind: 'expression', name: '兔牙', delayMs: 120 },
      {
        kind: 'motion',
        name: '竖手指打开',
        closeMotion: '竖手指关闭',
        closeAfterMs: 1800,
        delayMs: 200,
      },
    ],
    bubble: null,
    cooldownMs: 15000,
    minDwellMs: 0,
    refreshMs: 0,
    maxInWindow: 2,
    windowMs: 60000,
    fallback: '右臂被狗尾巴草占着时动作返回 conflict/skipped，表情和视线已经生效，不重试。',
  },

  error: {
    id: 'error',
    label: '出事（克制）',
    trigger: '其他工作区有会话以错误结束（hasError 或 state=error）',
    priority: 'NORMAL',
    chain: [
      { kind: 'expression', name: '流冷汗' },
      { kind: 'look', x: 0, y: -0.14, delayMs: 120 },
    ],
    bubble: null,
    cooldownMs: 20000,
    minDwellMs: 0,
    refreshMs: 0,
    maxInWindow: 1,
    windowMs: 60000,
    fallback: '不弹错误文本（状态快照本就脱敏）；表情持续到下一次 attention/settle 覆盖。',
  },

  idle: {
    id: 'idle',
    label: '待机（极轻）',
    trigger: '其他工作区全部 idle/unknown 且已静默 minDwellMs 以上',
    priority: 'BACKGROUND',
    chain: [{ kind: 'look', x: 0, y: 0 }],
    bubble: null,
    cooldownMs: 45000,
    minDwellMs: 8000,
    refreshMs: 90000,
    maxInWindow: 2,
    windowMs: 300000,
    fallback: '默认就是「不动作」；这条链只把视线轻轻收回，不清表情、不插手引擎待机。',
  },

  'user-direct': {
    id: 'user-direct',
    label: '用户直接对话',
    trigger: '用户直接对 Live2D Agent 说话（专属会话里的 user/message）',
    priority: 'FORCE',
    chain: [
      { kind: 'expression', name: '兔牙' },
      { kind: 'look', x: 0, y: 0, delayMs: 100 },
      {
        kind: 'motion',
        name: '竖手指打开',
        closeMotion: '竖手指关闭',
        closeAfterMs: 2800,
        delayMs: 180,
      },
    ],
    phase: null,
    bubble: null,
    cooldownMs: 2000,
    minDwellMs: 0,
    refreshMs: 0,
    maxInWindow: 6,
    windowMs: 60000,
    fallback: '对话里优先走已有 phase 短链（listening/thinking/speaking/settle），这条是单发兜底。',
  },
};

/**
 * 用户直接对话的四段路由。l2d_act 支持 phase，用内置短链比手写 chain 更稳：
 * listening / thinking / speaking 是 FORCE，settle 是 NORMAL。
 */
export const USER_DIRECT_PHASES = {
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
  settle: 'settle',
};

/** 工作区聚合时的状态优先级：错误 > 等你接手 > 忙 > 想 > 待机。 */
export const AGGREGATE_PRECEDENCE = ['error', 'attention', 'working', 'thinking'];

/**
 * 把 getWorkspaceAgentStates 的形状聚合成一个编排状态。
 * @param {{workspaces?: Array<{workspaceId?: string, title?: string, sessions?: Array<{state?: string}>}>}} snapshot
 * @param {string} [ownWorkspaceId] 自己的工作区不算「其他工作区」
 * @returns {{state: string, matches: Array<{workspaceId: string, title: string, state: string, count: number}>}}
 */
export function aggregateWorkspaceState(snapshot, ownWorkspaceId) {
  const matches = [];
  const counts = new Map();
  for (const workspace of (snapshot && snapshot.workspaces) || []) {
    if (ownWorkspaceId != null && String(workspace.workspaceId) === String(ownWorkspaceId)) continue;
    const byState = new Map();
    for (const session of workspace.sessions || []) {
      const state = String(session && session.state ? session.state : 'unknown');
      byState.set(state, (byState.get(state) || 0) + 1);
      counts.set(state, (counts.get(state) || 0) + 1);
    }
    for (const [state, count] of byState) {
      matches.push({
        workspaceId: String(workspace.workspaceId || ''),
        title: String(workspace.title || 'Untitled workspace'),
        state,
        count,
      });
    }
  }
  for (const state of AGGREGATE_PRECEDENCE) {
    if (counts.get(state)) return { state, matches };
  }
  if (counts.get('idle') || counts.get('unknown') || matches.length === 0) {
    return { state: 'idle', matches };
  }
  return { state: 'idle', matches };
}

/** 与 overlay.js plannedLifeMs 同口径的链时长估算（不含 holdMs）。 */
export function estimateLifeMs(chain) {
  const steps = Array.isArray(chain) ? chain : [];
  let cursor = 0;
  let life = 400;
  for (const step of steps) {
    const delay = Math.max(0, Number(step && step.delayMs) || 0);
    cursor += delay;
    life = Math.max(life, cursor + 1800);
    if (step && step.closeMotion) {
      life = Math.max(life, cursor + (Number(step.closeAfterMs) || 6000) + 200);
    }
  }
  return life;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function numberInRange(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/**
 * 判断一条链能不能发。纯函数：所有时间都从 input 传进来，不读 Date.now。
 *
 * @param {{
 *   state: string,
 *   previousState?: string|null,
 *   stateSince?: number,
 *   now?: number,
 *   lastFireAtByState?: Record<string, number>,
 *   lastAnyFireAt?: number,
 *   fires?: number[],
 *   flips?: number[],
 *   force?: boolean,
 * }} input
 * @param {typeof DEFAULT_GATE} [gate]
 * @returns {{fire: boolean, state: string, priority: string|null, chain: object[]|null, entry: object|null, reason: string, retryAfterMs: number}}
 */
export function decide(input = {}, gate = DEFAULT_GATE) {
  const settings = { ...DEFAULT_GATE, ...(gate || {}) };
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const state = String(input.state || '');
  const entry = Object.prototype.hasOwnProperty.call(CHOREOGRAPHY, state) ? CHOREOGRAPHY[state] : null;
  const base = {
    fire: false,
    state,
    priority: entry ? entry.priority : null,
    chain: null,
    entry,
    reason: '',
    retryAfterMs: 0,
  };
  if (!entry) return { ...base, reason: 'unknown-state' };

  const force = input.force === true;
  const stateSince = Number.isFinite(Number(input.stateSince)) ? Number(input.stateSince) : now;
  const lastFireAtByState = input.lastFireAtByState || {};
  const lastAnyFireAt = Number(input.lastAnyFireAt) || 0;
  // 频次预算按状态隔离：一个状态的触发不能挤占另一个状态的额度。
  // 兼容旧调用方：只给扁平 fires 时视为当前状态的记录。
  const firedForState = Array.isArray(input.firesByState?.[state])
    ? input.firesByState[state]
    : Array.isArray(input.fires)
      ? input.fires
      : [];
  const flips = Array.isArray(input.flips) ? input.flips : [];

  // 1. 抖动风暴：只压环境状态，事件状态照常（但后面还有冷却和频次上限）。
  if (entry.priority === 'BACKGROUND' && !force) {
    const windowMs = Number(entry.flipWindowMs) || settings.flipWindowMs;
    const maxFlips = Number(entry.maxFlips) || settings.maxFlips;
    const recent = flips.filter((at) => typeof at === 'number' && now - at <= windowMs);
    if (recent.length >= maxFlips) return { ...base, reason: 'jitter' };
  }

  // 2. 状态没变：无 refreshMs 的状态不重播；有 refreshMs 的持续态必须等到刷新周期。
  //    （只靠 cooldown 不够：working 的 cooldown 只有 8s，但刷新节拍是 25s。）
  //    FORCE 状态（user-direct）豁免 same-state：每条用户消息都要有反应，由 cooldown/rate 防风暴。
  const refreshMs = Number(entry.refreshMs) || 0;
  const sameState = input.previousState != null && String(input.previousState) === state;
  const lastStateFireAt = Number(lastFireAtByState[state]) || 0;
  const forceEntry = entry.priority === 'FORCE';
  if (!force && !forceEntry && sameState) {
    if (refreshMs <= 0) return { ...base, reason: 'same-state' };
    const since = now - lastStateFireAt;
    if (since < refreshMs) return { ...base, reason: 'refresh', retryAfterMs: refreshMs - since };
  }

  // 3. 状态稳定时间（防「刚进入就触发、马上又切走」的空动作）。FORCE 豁免。
  const dwellRemaining = Math.max(0, Number(entry.minDwellMs) || 0) - (now - stateSince);
  if (!force && !forceEntry && dwellRemaining > 0) {
    return { ...base, reason: 'dwell', retryAfterMs: dwellRemaining };
  }

  // 4. 同状态冷却（FORCE 也保留：连续对话靠它防刷屏）。
  const cooldownRemaining = Math.max(0, Number(entry.cooldownMs) || 0) - (now - lastStateFireAt);
  if (!force && cooldownRemaining > 0) {
    return { ...base, reason: 'cooldown', retryAfterMs: cooldownRemaining };
  }

  // 5. 全局最小间隔。FORCE 豁免（用户直接对话的反应不该被环境动作的间隔拖住）。
  const gapRemaining = settings.minGapMs - (now - lastAnyFireAt);
  if (!force && !forceEntry && gapRemaining > 0) {
    return { ...base, reason: 'min-gap', retryAfterMs: gapRemaining };
  }

  // 6. 频次上限。
  const windowMs = Number(entry.windowMs) || 60000;
  const maxInWindow = Math.max(1, Number(entry.maxInWindow) || 1);
  const inWindow = firedForState.filter((at) => typeof at === 'number' && now - at <= windowMs);
  if (!force && inWindow.length >= maxInWindow) {
    return { ...base, reason: 'rate', retryAfterMs: windowMs - (now - Math.min(...inWindow)) };
  }

  return {
    ...base,
    fire: true,
    chain: entry.chain.map((step) => {
      const copy = { ...step };
      if (step.pose) copy.pose = { ...step.pose };
      return copy;
    }),
    reason: 'fire',
  };
}

/**
 * 单步校验。
 * @param {object} step
 * @param {number} index
 * @param {{expressions?: string[]|Set<string>, motionGroups?: string[]|Set<string>}} [allowed]
 *   [#28] 表情/动作组白名单可由调用方注入（当前模型资源清单）；缺省用写死的大肥鱼
 *   名单（静态行为完全不变）。数组用 includes、Set 用 has，两种形态都收。
 */
export function validateStep(step, index = 0, allowed = null) {
  const errors = [];
  const warnings = [];
  const at = 'chain[' + index + ']';
  if (!isPlainObject(step)) return { errors: [at + ' 不是对象'], warnings };

  const inWhitelist = (coll, name) =>
    coll instanceof Set ? coll.has(name) : Array.isArray(coll) ? coll.includes(name) : false;
  const allowedExpressions = allowed && allowed.expressions ? allowed.expressions : MODEL_EXPRESSIONS;
  const allowedMotionGroups = allowed && allowed.motionGroups ? allowed.motionGroups : MODEL_MOTION_GROUPS;

  for (const key of Object.keys(step)) {
    if (!STEP_KEYS.has(key)) errors.push(at + ' 未知字段 ' + key);
  }
  if (!STEP_KINDS.includes(step.kind)) {
    errors.push(at + ' kind 非法：' + String(step.kind));
    return { errors, warnings };
  }
  if (step.delayMs !== undefined && !numberInRange(step.delayMs, 0, 5000)) {
    errors.push(at + ' delayMs 必须是 0~5000 的数字');
  }

  if (step.kind === 'expression') {
    if (step.clear === true) {
      if (step.name) warnings.push(at + ' 同时给了 clear 和 name，执行时只走 clear');
    } else if (!inWhitelist(allowedExpressions, step.name)) {
      errors.push(at + ' 表情名不存在：' + String(step.name));
    }
  }

  if (step.kind === 'motion') {
    if (!inWhitelist(allowedMotionGroups, step.name)) {
      errors.push(at + ' 动作组不存在或不允许手动播：' + String(step.name));
    }
    const pair = PAIRED_CLOSES[step.name];
    if (step.closeMotion !== undefined) {
      if (!pair) errors.push(at + ' 这个动作没有关闭配对，不能写 closeMotion');
      else if (step.closeMotion !== pair) {
        errors.push(at + ' closeMotion 必须是 ' + pair + '，实际 ' + step.closeMotion);
      }
      if (step.closeAfterMs === undefined) warnings.push(at + ' 有 closeMotion 但没 closeAfterMs，默认 6000ms');
      else if (!numberInRange(step.closeAfterMs, 300, 12000)) {
        errors.push(at + ' closeAfterMs 必须是 300~12000 的数字');
      }
    } else if (pair) {
      warnings.push(at + ' 打开动作没有 closeMotion，手会一直举着（由状态机与终态姿势接管）');
    }
  }

  if (step.kind === 'pose') {
    if (!isPlainObject(step.pose)) errors.push(at + ' pose 必须是 {right?, left?}');
    else {
      const keys = Object.keys(step.pose);
      if (!keys.length) errors.push(at + ' pose 至少给一侧');
      for (const key of keys) {
        if (key !== 'right' && key !== 'left') errors.push(at + ' pose 未知侧 ' + key);
        else if (!POSE_VALUES.includes(step.pose[key])) {
          errors.push(at + ' pose.' + key + ' 取值非法：' + String(step.pose[key]));
        }
      }
    }
  }

  if (step.kind === 'look') {
    if (!numberInRange(step.x, -1, 1)) errors.push(at + ' look.x 必须是 -1~1 的数字');
    if (!numberInRange(step.y, -1, 1)) errors.push(at + ' look.y 必须是 -1~1 的数字');
  }

  // 并行组（Action Chain v2）。宿主只判静态事实：id 合法、parallel 必须带 group、
  // timeoutMs 是整组超时（必须带 group）。参数重叠降级由 renderer 的 chain-normalize 做。
  if (step.group !== undefined) {
    if (typeof step.group !== 'string' || !GROUP_ID_RE.test(step.group)) {
      errors.push(at + ' group 必须是 1~32 位 [A-Za-z0-9_.:-]');
    }
  }
  if (step.mode !== undefined) {
    if (!STEP_MODES.includes(step.mode)) errors.push(at + ' mode 必须是 sequence 或 parallel');
    else if (step.mode === 'parallel' && step.group === undefined) errors.push(at + ' mode=parallel 必须同时给 group');
  }
  if (step.timeoutMs !== undefined) {
    if (!numberInRange(step.timeoutMs, 0, 8000)) errors.push(at + ' timeoutMs 必须是 0~8000 的数字');
    else if (step.group === undefined) errors.push(at + ' timeoutMs 是整组超时，必须同时给 group');
  }

  if (step.name !== undefined && typeof step.name !== 'string') errors.push(at + ' name 必须是字符串');
  return { errors, warnings };
}

/** 单条状态编排校验。 */
export function validateEntry(id, entry, gate = DEFAULT_GATE) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(entry)) return { errors: [id + ' 不是对象'], warnings };
  if (entry.id !== id) errors.push(id + ' 的 id 字段必须与键名一致');
  if (typeof entry.label !== 'string' || !entry.label) errors.push(id + ' 缺 label');
  if (typeof entry.trigger !== 'string' || !entry.trigger) errors.push(id + ' 缺 trigger');
  if (!ACT_PRIORITIES.includes(entry.priority)) errors.push(id + ' priority 非法：' + String(entry.priority));
  if (!Array.isArray(entry.chain) || entry.chain.length === 0) {
    errors.push(id + ' chain 不能为空');
    return { errors, warnings };
  }
  if (entry.chain.length > 8) errors.push(id + ' chain 超过 8 步（MCP 工具上限）');
  entry.chain.forEach((step, index) => {
    const result = validateStep(step, index);
    errors.push(...result.errors.map((text) => id + ': ' + text));
    warnings.push(...result.warnings.map((text) => id + ': ' + text));
  });

  const life = estimateLifeMs(entry.chain);
  const maxLifeMs = Number(gate.maxLifeMs) || DEFAULT_GATE.maxLifeMs;
  if (life > maxLifeMs) errors.push(id + ' 估算时长 ' + life + 'ms 超过上限 ' + maxLifeMs + 'ms');

  if (!numberInRange(entry.cooldownMs, 0, 600000)) errors.push(id + ' cooldownMs 必须是 0~600000 的数字');
  if (!numberInRange(entry.minDwellMs, 0, 60000)) errors.push(id + ' minDwellMs 必须是 0~60000 的数字');
  if (!numberInRange(entry.refreshMs, 0, 600000)) errors.push(id + ' refreshMs 必须是 0~600000 的数字');
  if (entry.refreshMs > 0 && entry.refreshMs < entry.cooldownMs) {
    warnings.push(id + ' refreshMs 小于 cooldownMs，持续脉冲会被冷却吞掉');
  }
  if (!Number.isInteger(entry.maxInWindow) || entry.maxInWindow < 1) errors.push(id + ' maxInWindow 必须是正整数');
  if (!numberInRange(entry.windowMs, 1000, 3600000)) errors.push(id + ' windowMs 必须是 1000~3600000 的数字');
  if (entry.bubble !== null && (typeof entry.bubble !== 'string' || entry.bubble.length > 40)) {
    errors.push(id + ' bubble 必须是 null 或 40 字以内字符串');
  }
  if (entry.phase !== undefined && entry.phase !== null) {
    if (!['listening', 'thinking', 'speaking', 'settle'].includes(entry.phase)) {
      errors.push(id + ' phase 非法：' + String(entry.phase));
    }
  }
  if (entry.priority === 'BACKGROUND' && entry.chain.some((step) => step && step.kind === 'motion')) {
    warnings.push(id + ' BACKGROUND 链里有动作步，会占舞台 acting，建议只在事件状态用动作');
  }
  if (entry.priority === 'FORCE' && entry.chain.length < 2) {
    warnings.push(id + ' FORCE 链只有一步，演出可能太单薄');
  }
  return { errors, warnings };
}

/**
 * 整份编排校验。
 * @param {typeof CHOREOGRAPHY} [map]
 * @param {{expressions?: string[], motionGroups?: string[], gate?: typeof DEFAULT_GATE}} [options]
 */
export function validateChoreography(map = CHOREOGRAPHY, options = {}) {
  const errors = [];
  const warnings = [];
  const gate = { ...DEFAULT_GATE, ...(options.gate || {}) };
  if (!isPlainObject(map)) return { ok: false, errors: ['编排不是对象'], warnings };

  const expected = new Set(CHOREOGRAPHY_STATES);
  for (const key of Object.keys(map)) {
    if (!expected.has(key)) errors.push('未知状态 ' + key);
  }
  for (const state of CHOREOGRAPHY_STATES) {
    if (!Object.prototype.hasOwnProperty.call(map, state)) {
      errors.push('缺状态 ' + state);
      continue;
    }
    const result = validateEntry(state, map[state], gate);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  // 口型禁区：编排数据里出现口型参数名（键或精确字符串值）就判死。
  // 用 param-guards 的精确匹配，避免对整份 JSON 做子串误报（label/trigger 文案含参数名会误杀）。
  const reservedHits = collectReservedParams(map);
  for (const key of reservedHits) {
    errors.push('编排数据里出现口型参数 ' + key);
  }

  // 模型白名单可被其他模型覆盖；默认表用常量。
  const expressions = new Set(options.expressions || MODEL_EXPRESSIONS);
  const motionGroups = new Set(options.motionGroups || MODEL_MOTION_GROUPS);
  for (const [id, entry] of Object.entries(map)) {
    for (const step of (entry && entry.chain) || []) {
      if (!step) continue;
      if (step.kind === 'expression' && step.name && !expressions.has(step.name)) {
        errors.push(id + ' 表情不在当前模型表：' + step.name);
      }
      if (step.kind === 'motion' && step.name && !motionGroups.has(step.name)) {
        errors.push(id + ' 动作组不在当前模型表：' + step.name);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** 测试用：校验失败时直接抛。 */
export function assertValidChoreography(map = CHOREOGRAPHY, options = {}) {
  const result = validateChoreography(map, options);
  if (!result.ok) throw new Error('choreography 校验失败：\n' + result.errors.join('\n'));
  return result;
}
