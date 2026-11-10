#!/usr/bin/env node
/**
 * DSH-L2D MCP 薄壳。
 * 工具调用转发到本机 http://127.0.0.1:<port>/dsh-l2d/ai/call，
 * 再等浏览器把执行结果放到 /ai/result。不启动渲染，也不读用户的 API Key。
 *
 * 不暴露 l2d_set_parameters / l2d_play_keyframes。
 * 不改 systemSensor / mediaSensor，那两个开关默认关，只能在插件设置里打开。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveBase } from './discover.mjs';
import { forwardCall } from './forward.mjs';
import { executeActionSequence, validateActionSequence } from './action-sequence.mjs';
import { CHOREOGRAPHY } from '../../dsh-l2d-plugin/lib/choreography.mjs';
import {
  ALLOWED_EXPRESSIONS,
  PLAYABLE_MOTION_GROUPS,
  findReservedParams,
  validateActChain,
  validateExpressionName,
  validateMotionGroup,
} from './validate.mjs';
import { readToolchainStatus } from './toolchain-status.mjs';
import {
  ACCESSORY_SET_DESCRIPTION,
  BRIDGE_CUTS,
  BRIDGE_ON_BUSY,
  BRIDGE_PRIORITIES,
  BRIDGE_REGIONS,
  CUT_DESCRIPTION,
  FACE_COMPOSE_DESCRIPTION,
  FACE_DESCRIBE_DESCRIPTION,
  FACE_VOCAB_DESCRIPTION,
  ON_BUSY_DESCRIPTION,
  REGIONS_GET_DESCRIPTION,
  REGIONS_RELEASE_DESCRIPTION,
  loadCapabilitiesForDescription,
  regionsActDescription,
} from './regions-tools.mjs';

let cachedBase = '';

/**
 * 带超时的直接 fetch（不走 forward 的 deadline 机制）。
 * balance / workspace / persona 等低频辅助端点此前是裸 fetch：宿主进程僵死时
 * 调用方会无限挂起。Node 22 的 AbortSignal.timeout 同时约束连接与响应体读取。
 */
async function fetchTimeout(url, init = {}, timeoutMs = 5000) {
  return fetch(url, {
    ...init,
    signal: init.signal || AbortSignal.timeout(timeoutMs),
  });
}

async function baseUrl() {
  if (cachedBase) return cachedBase;
  cachedBase = await resolveBase();
  return cachedBase;
}

async function forward(name, args, timeoutMs, mode) {
  const base = await baseUrl();
  if (!base) {
    return { ok: false, reason: 'plugin-offline' };
  }
  const result = await forwardCall({ base, name, args, timeoutMs, mode });
  // 只有网络层失败（unreachable，且非截止中止）才清缓存地址
  if (result && result.reason === 'unreachable') {
    cachedBase = '';
  }
  return result;
}

function toolResult(result) {
  const text = JSON.stringify(result);
  const benign =
    result &&
    (result.reason === 'skipped' ||
      result.reason === 'conflict' ||
      result.reason === 'priority-blocked' ||
      result.reason === 'pending' ||
      result.reason === 'region-busy' ||
      result.reason === 'expression-conflict' ||
      result.status === 'skipped' ||
      result.status === 'conflict');
  return {
    content: [{ type: 'text', text }],
    isError: result && result.ok === false && !benign,
  };
}

const server = new McpServer({
  name: 'dsh-l2d',
  version: '0.1.0',
});

server.registerTool(
  'l2d_emote',
  {
    description: '用情绪词驱动角色（开心、害羞、生气、惊讶、思考等）。走情绪路由，比直接点表情名更自然。不会打开系统传感器或媒体律动。',
    inputSchema: {
      mood: z.string().describe('情绪词，例如 开心 / 害羞 / 生气 / 惊讶 / 思考'),
    },
  },
  async ({ mood }) => toolResult(await forward('l2d_emote', { mood }, 3000)),
);

server.registerTool(
  'l2d_set_expression',
  {
    description: '切换模型自带表情。名字必须是模型里真实存在的表情。内部走部位联动 bridge 的表情层：眼型等互斥表情被更高优先级联动占着时返回 expression-conflict；「前倾」「脱鞋」会转成躯干 / 腿部模块指令。',
    inputSchema: {
      name: z.string().describe('表情名'),
    },
  },
  async ({ name }) => {
    const check = validateExpressionName(name);
    if (!check.ok) {
      return toolResult({ ok: false, reason: check.reason, name, allowed: check.allowed });
    }
    return toolResult(await forward('l2d_set_expression', { name }, 3000));
  },
);

server.registerTool(
  'l2d_play_motion',
  {
    description: '播放动作组。打开/关闭是成对状态，重复打开会得到 skipped。内部走部位联动 bridge：动作所属模块（如 hands）正被另一条联动占着时返回 region-busy；要打开的动作与已打开的动作共用一只手臂时会先自动播放那个的关闭动作再打开（只收尾这一只手）。这些是正常结果，换一个动作或稍后再试，不要原样重试。',
    inputSchema: {
      group: z.string().describe('动作组名，例如 竖手指打开'),
      index: z.number().int().optional().describe('组内下标，默认 0'),
      awaitFinish: z.boolean().optional().describe('是否等到动作时长结束再返回'),
    },
  },
  async ({ group, index, awaitFinish }) => {
    const check = validateMotionGroup(group);
    if (!check.ok) {
      return toolResult({ ok: false, reason: check.reason, group, allowed: check.allowed });
    }
    return toolResult(await forward('l2d_play_motion', { group, index, awaitFinish }, awaitFinish ? 15000 : 4000));
  },
);

server.registerTool(
  'l2d_set_pose',
  {
    description: '摆四肢姿势。right/left 取 rest、finger、grass、chest。会缓动过去，空闲几秒后自动回到 rest。动作播放中会被拒绝。',
    inputSchema: {
      right: z.enum(['rest', 'finger', 'grass', 'chest']).optional(),
      left: z.enum(['rest', 'finger', 'grass', 'chest']).optional(),
    },
  },
  async ({ right, left }) => toolResult(await forward('l2d_set_pose', { right, left }, 3000)),
);

server.registerTool(
  'l2d_gaze',
  {
    description: '看向一个方向。x 向右为正，y 向上为正，范围 -1 到 1。比直接拧头更自然，屏幕坐标不用自己取反。',
    inputSchema: {
      x: z.number().min(-1).max(1),
      y: z.number().min(-1).max(1),
    },
  },
  async ({ x, y }) => toolResult(await forward('l2d_gaze', { x, y }, 3000)),
);

server.registerTool(
  'l2d_posture',
  {
    description:
      '用语义通道摆姿态：values 是 {通道名: -1..1}，通道名来自模型能力画像（l2d_get_state 可见），不认识的通道会被显式 skipped 并给原因。保持 durationMs（默认 4000，500~30000）后自动回到待机；own 为 true 时把全部写入参数占住防止被覆盖。approximate 通道在回执 degraded 里标注（表达是近似的）。返回的 skipped / degraded / failed 都要读，不要原样重试。',
    inputSchema: {
      values: z.record(z.string(), z.number().min(-1).max(1)).describe('语义通道 → 归一化值（-1..1）'),
      durationMs: z.number().int().min(500).max(30000).optional().describe('保持时长毫秒，默认 4000'),
      own: z.boolean().optional().describe('true 时把全部写入参数 own 住，到期自动释放'),
      fadeMs: z.number().min(0).optional().describe('淡入时长毫秒，超过 durationMs 会被夹到 durationMs'),
    },
  },
  async ({ values, durationMs, own, fadeMs }) => {
    if (!values || Object.keys(values).length === 0) {
      return toolResult({ ok: false, reason: 'empty-values' });
    }
    const timeoutMs = Math.min(35000, (durationMs || 4000) + 5000);
    return toolResult(await forward('l2d_posture', { values, durationMs, own, fadeMs }, timeoutMs));
  },
);

server.registerTool(
  'l2d_say',
  {
    description: '让角色冒一句气泡。只显示文字，不读硬盘、不发请求。',
    inputSchema: {
      text: z.string().describe('要说的话，别太长'),
      holdMs: z.number().int().optional().describe('气泡停留毫秒，默认约 3.6 秒'),
    },
  },
  async ({ text, holdMs }) => toolResult(await forward('l2d_say', { text, holdMs }, 3000)),
);

server.registerTool(
  'l2d_act',
  {
    description:
      '按顺序演一小段。chain 每步 kind 是 expression、motion、pose、look。priority 取 BACKGROUND、NORMAL、FORCE：低的不能打断高的，同级可以打断，省略是 NORMAL。对话和邪神用 FORCE，待机小动作用 BACKGROUND。accepted 只表示占上了槽；events 里的 action-done 才是 start、end 或 interrupted。phase 可填 listening、thinking、speaking、settle，用内置短链。说话段也不写 ParamMouthOpenY。不要用来写底层参数。',
    inputSchema: {
      chain: z
        .array(
          z.object({
            kind: z.enum(['expression', 'motion', 'pose', 'look']),
            name: z.string().optional(),
            closeMotion: z.string().optional(),
            closeAfterMs: z.number().optional(),
            delayMs: z.number().optional(),
            group: z.string().regex(/^[A-Za-z0-9_.:-]{1,32}$/).optional(),
            mode: z.enum(['sequence', 'parallel']).optional(),
            timeoutMs: z.number().int().min(0).max(8000).optional(),
            pose: z
              .object({
                right: z.enum(['rest', 'finger', 'grass', 'chest']).optional(),
                left: z.enum(['rest', 'finger', 'grass', 'chest']).optional(),
              })
              .optional(),
            x: z.number().optional(),
            y: z.number().optional(),
          }),
        )
        .max(8)
        .optional(),
      priority: z.enum(['BACKGROUND', 'NORMAL', 'FORCE']).optional(),
      phase: z.enum(['listening', 'thinking', 'speaking', 'settle']).optional(),
      bubble: z.string().optional(),
    },
  },
  async ({ chain, bubble, priority, phase }) => {
    if ((!chain || !chain.length) && !phase) {
      return toolResult({ ok: false, accepted: false, reason: 'empty-chain', outcome: 'rejected', settled: false, events: [] });
    }
    const check = validateActChain(chain);
    if (!check.ok) {
      return toolResult({ ok: false, accepted: false, reason: 'invalid-chain', errors: check.errors, outcome: 'rejected', settled: false, events: [] });
    }
    return toolResult(await forward('l2d_act', { chain, bubble, priority, phase }, 12000, 'act'));
  },
);

server.registerTool(
  'l2d_choreograph',
  {
    description: '混合动作编排入口。简单状态反应优先传 presetState（error/attention/working/thinking/idle/bootstrap/user-direct），程序复用 choreography.mjs 已验证的预设链；复杂对话、情绪或多阶段演出则由 Agent 自行生成 segments（1~15 段，每段最多 8 步）。两者只能选一个。程序以 FIFO 队列逐段调用现有 l2d_act；上一段明确 completed 后才出队下一段。conflict / priority-blocked 会在队列头等待并有限重试；accepted=true 但 pending 不会重复提交，避免重复动作。interrupted / timeout 会保留剩余队列并返回明确状态。只允许 expression / motion / pose / look；表情和动作必须使用当前模型真实白名单。',
    inputSchema: {
      presetState: z.enum(['error', 'attention', 'working', 'thinking', 'idle', 'bootstrap', 'user-direct']).optional(),
      segments: z.array(z.object({
        chain: z.array(z.object({
          kind: z.enum(['expression', 'motion', 'pose', 'look']),
          name: z.string().optional(),
          closeMotion: z.string().optional(),
          closeAfterMs: z.number().optional(),
          delayMs: z.number().optional(),
          group: z.string().regex(/^[A-Za-z0-9_.:-]{1,32}$/).optional(),
          mode: z.enum(['sequence', 'parallel']).optional(),
          timeoutMs: z.number().int().min(0).max(8000).optional(),
          pose: z.object({
            right: z.enum(['rest', 'finger', 'grass', 'chest']).optional(),
            left: z.enum(['rest', 'finger', 'grass', 'chest']).optional(),
          }).optional(),
          x: z.number().optional(),
          y: z.number().optional(),
        })).min(1).max(8),
        priority: z.enum(['BACKGROUND', 'NORMAL', 'FORCE']).optional(),
        bubble: z.string().max(40).optional(),
      })).min(1).max(15).optional(),
    },
  },
  async ({ presetState, segments }) => {
    if ((presetState && segments) || (!presetState && !segments)) {
      return toolResult({ ok: false, status: 'rejected', reason: 'choose-preset-or-segments' });
    }
    const selected = presetState
      ? CHOREOGRAPHY[presetState]
      : null;
    const plan = {
      segments: selected
        ? [{ chain: selected.chain, priority: selected.priority, bubble: selected.bubble || undefined }]
        : segments,
    };
    const reserved = findReservedParams(plan.segments);
    if (reserved.length) {
      return toolResult({ ok: false, status: 'rejected', reason: 'reserved-param', reserved, receipts: [] });
    }
    // [#28] 序列校验用当前模型的动态白名单（与 validateActChain / 单步原语同源）。
    const validation = validateActionSequence(plan, {
      expressions: ALLOWED_EXPRESSIONS,
      motionGroups: PLAYABLE_MOTION_GROUPS,
    });
    if (!validation.ok) return toolResult({ ok: false, status: 'rejected', reason: 'invalid-sequence', errors: validation.errors, receipts: [] });
    const result = await executeActionSequence(plan, (args) => forward('l2d_act', args, 12000, 'act'));
    return toolResult({ ...result, source: selected ? 'preset:' + presetState : 'agent-generated' });
  },
);

server.registerTool(
  'l2d_get_state',
  {
    description: '只读快照：渲染信息、情绪、姿势。余额单独查，没有 Key 时余额字段会说明原因。不会打开任何传感器。',
    inputSchema: {},
  },
  async () => {
    const state = await forward('l2d_get_state', {}, 3000);
    const base = await baseUrl();
    let balance = { ok: false, reason: 'unavailable' };
    if (base) {
      try {
        const res = await fetchTimeout(base + '/dsh-l2d/balance.json', { cache: 'no-store' });
        if (res.ok) balance = await res.json();
      } catch {
        balance = { ok: false, reason: 'unavailable' };
      }
    }
    return toolResult({ ...(state || { ok: false, reason: 'empty' }), balance });
  },
);

server.registerTool(
  'l2d_reset',
  {
    description: '回到待机：清姿势、清表情、清注视。不读取任何用户文件。',
    inputSchema: {},
  },
  async () => toolResult(await forward('l2d_reset', {}, 3000)),
);

server.registerTool(
  'l2d_workspace_ensure',
  {
    description: '在 DSH 中创建或复用独立的 Live2D Agent Workspace 和 Session，并初始化 AGENTS.md / agent.md。',
    inputSchema: {},
  },
  async () => {
    const base = await baseUrl();
    if (!base) return toolResult({ ok: false, reason: 'plugin-offline' });
    try {
      const response = await fetchTimeout(base + '/dsh-l2d/workspace/ensure', { method: 'POST' });
      const result = await response.json();
      return toolResult(result && typeof result === 'object' ? result : { ok: false, reason: 'invalid-response' });
    } catch {
      cachedBase = '';
      return toolResult({ ok: false, reason: 'workspace-bridge-unreachable' });
    }
  },
);

server.registerTool(
  'l2d_workspace_status',
  {
    description: '读取 DSH 所有已登记 Workspace 的脱敏 Session 状态。只返回工作区标题、会话状态和活动时长，不读取聊天内容或文件。',
    inputSchema: {},
  },
  async () => {
    const base = await baseUrl();
    if (!base) return toolResult({ ok: false, reason: 'plugin-offline' });
    try {
      const response = await fetchTimeout(base + '/dsh-l2d/workspace/status.json', { cache: 'no-store' });
      const result = await response.json();
      return toolResult(result && typeof result === 'object' ? result : { ok: false, reason: 'invalid-response' });
    } catch {
      cachedBase = '';
      return toolResult({ ok: false, reason: 'workspace-status-unreachable' });
    }
  },
);

server.registerTool(
  'l2d_persona',
  {
    description:
      '读取 / 修改 / 重置角色人设（性格 traits、情绪表达 expression、主动程度 proactivity、亲密程度 intimacy、工作态度 workAttitude、动作偏好 motionPreference、待机习惯 idleHabit、自由描述 description）。action=get 读当前值；action=set 只传要改的字段（patch），返回修改后的完整人设；action=reset 回默认。人设写入宿主文件后，下一次工作区规划立即生效。',
    inputSchema: {
      action: z.enum(['get', 'set', 'reset']),
      patch: z
        .object({
          traits: z.array(z.string()).max(8).optional().describe('性格关键词，如 温柔 / 傲娇 / 认真'),
          expression: z
            .object({
              style: z.enum(['gentle', 'lively', 'reserved', 'tsundere', 'calm']).optional(),
              intensity: z.number().min(0).max(1).optional(),
            })
            .optional(),
          proactivity: z.number().min(0).max(1).optional().describe('主动程度：0 只回应，1 乐于主动'),
          intimacy: z.number().min(0).max(1).optional(),
          workAttitude: z.enum(['supportive', 'neutral', 'strict', 'playful']).optional(),
          motionPreference: z
            .object({
              style: z.enum(['subtle', 'balanced', 'expressive']).optional(),
              avoid: z.array(z.string()).max(8).optional().describe('回避的动作组名'),
            })
            .optional(),
          idleHabit: z
            .object({
              style: z.enum(['quiet', 'normal', 'chatty']).optional(),
              lookAround: z.boolean().optional(),
            })
            .optional(),
          description: z.string().max(500).optional().describe('用户原话的自由描述，如「一只温柔但有点傲娇的蓝鲸女仆」'),
        })
        .optional(),
    },
  },
  async ({ action, patch }) => {
    const base = await baseUrl();
    if (!base) return toolResult({ ok: false, reason: 'plugin-offline' });
    try {
      if (action === 'get') {
        const res = await fetchTimeout(base + '/dsh-l2d/persona.json', { cache: 'no-store' });
        if (!res.ok) return toolResult({ ok: false, reason: 'http-' + res.status });
        return toolResult(await res.json());
      }
      const body = action === 'reset' ? { reset: true } : { patch: patch || {} };
      const res = await fetchTimeout(base + '/dsh-l2d/persona.json', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return toolResult({ ok: false, reason: 'http-' + res.status });
      return toolResult(await res.json());
    } catch {
      cachedBase = '';
      return toolResult({ ok: false, reason: 'unreachable' });
    }
  },
);

server.registerTool(
  'l2d_toolchain_status',
  {
    description:
      '只读。查询 MOC3 解析工具链与运行时依赖的注册状态（python / py-moc3 / Rust 候选等），含版本、来源、提交锚点与最近一次 smoke 测试明细。数据来自统一 SQLite 注册表（data/bootstrap-state.sqlite），读不到库时如实报错，不编造状态。',
    inputSchema: {},
  },
  async () => {
    const status = readToolchainStatus({});
    return toolResult(status);
  },
);

server.registerTool(
  'l2d_change_form',
  {
    description: '切换模型形态（默认体型 / 体型1 / 体型2 循环切换）。一次调用切到下一形态，返回当前形态名称。',
    inputSchema: z.object({}),
  },
  async () => toolResult(await forward('l2d_change_form', {}, 3000)),
);

server.registerTool(
  'l2d_set_form',
  {
    description:
      '直接切到指定模型形态（0=默认体型 / 1=体型1 / 2=体型2），可从高形态切回低形态。已是目标形态时回执带 notes:["already-current"]；index 非 0..2 整数时返回 invalid-form-index。',
    inputSchema: {
      index: z.number().int().min(0).max(2).describe('目标形态序号：0=默认体型，1=体型1，2=体型2'),
    },
  },
  async ({ index }) => toolResult(await forward('l2d_set_form', { index }, 3000)),
);

// ---------------------------------------------------------------- 部位联动 bridge
// 直连宿主 /dsh-l2d/api/bridge/*（宿主先用 body-bridge.mjs 静态校验，再经 aiInbox 交给 overlay 仲裁）。
// 工具说明由分区表生成：每个模块能做什么、可写哪些参数直接写在描述里。
const regionsCaps = loadCapabilitiesForDescription();

async function bridgeApi(pathAndQuery, init, timeoutMs) {
  const base = await baseUrl();
  if (!base) return { ok: false, reason: 'plugin-offline' };
  try {
    const res = await fetchTimeout(base + pathAndQuery, init, timeoutMs);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, reason: 'http-' + res.status };
    }
  } catch {
    cachedBase = '';
    return { ok: false, reason: 'unreachable' };
  }
}

// 忙时策略 / 衔接（regions_act、accessory_set、face_compose 共用）。LLM 侧默认 blend + next。
const busySchema = {
  priority: z.enum([...BRIDGE_PRIORITIES]).optional().describe('LOW / NORMAL / HIGH / FORCE，默认 NORMAL'),
  onBusy: z.enum([...BRIDGE_ON_BUSY]).optional().describe(ON_BUSY_DESCRIPTION),
  cut: z.enum([...BRIDGE_CUTS]).optional().describe(CUT_DESCRIPTION),
  fadeMs: z.number().int().min(200).max(400).optional().describe('交叉淡变时长，默认 300'),
  waitMs: z.number().int().min(0).max(30000).optional().describe('最多等多久：wait 默认 3000，blend 默认 30000（after / 低优先级等播完时用得上）'),
};

const composeSchema = z.object({
  dimensions: z
    .union([z.record(z.string(), z.number().min(0).max(1)), z.array(z.object({ dimension: z.string(), intensity: z.number().min(0).max(1) }))])
    .optional()
    .describe('情绪维度强度，如 {慵懒:0.6, 挑逗:0.7}'),
  units: z.record(z.string(), z.number().min(0).max(1)).optional().describe('直接给部件强度 {部件id: 0..1}'),
  recipes: z.array(z.string()).optional().describe('叠加预设配方'),
  side: z.enum(['L', 'R']).optional().describe('有方向的部件统一朝哪边'),
  energy: z.number().min(0).max(1).optional().describe('摆动能量，默认按维度强度加权平均'),
  expressions: z.array(z.string()).optional().describe('额外要一起开的表情（走表情层）'),
  autoExpressions: z.boolean().optional().describe('维度强度过阈值时自动开伴随表情（脸红等），默认 true'),
  enterMs: z.number().int().min(0).max(10000).optional().describe('渐入时长，默认 1000'),
  holdMs: z.number().int().min(0).max(600000).optional().describe('保持多久后自动渐出；不给就一直保持'),
});

async function bridgeAct(route, body, opts) {
  const out = { ...body, onBusy: opts.onBusy || 'blend' };
  if (opts.priority) out.priority = opts.priority;
  if (opts.cut) out.cut = opts.cut;
  if (opts.fadeMs !== undefined) out.fadeMs = opts.fadeMs;
  if (opts.waitMs !== undefined) out.waitMs = opts.waitMs;
  if (opts.awaitDone) out.awaitDone = true;
  const wait = out.onBusy === 'reject' ? 0 : opts.waitMs ?? (out.onBusy === 'wait' ? 3000 : 30000);
  const budget = wait + (opts.awaitDone ? 20000 : 0) + 8000;
  return bridgeApi(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(out) }, budget);
}

server.registerTool(
  'l2d_regions_get',
  { description: REGIONS_GET_DESCRIPTION, inputSchema: z.object({}) },
  async () => toolResult(await bridgeApi('/dsh-l2d/api/bridge/state', { cache: 'no-store' }, 8000)),
);

server.registerTool(
  'l2d_regions_act',
  {
    description: regionsActDescription(regionsCaps),
    inputSchema: {
      steps: z
        .array(
          z.object({
            region: z.enum([...BRIDGE_REGIONS]).optional().describe('模块：hair / face / hands / torso / legs（与 layer 二选一）'),
            motion: z.string().optional().describe('该模块的动作组名（与 set 二选一）'),
            index: z.number().int().min(0).optional(),
            set: z.record(z.string(), z.number()).optional().describe('{参数ID: 目标值}，只能是该模块可写参数'),
            durationMs: z.number().int().min(0).max(30000).optional().describe('插值时长，默认 0'),
            layer: z.enum(['expression', 'form', 'accessory']).optional(),
            expression: z.string().optional(),
            item: z.string().optional().describe('layer=accessory 时的饰品 id'),
            on: z.boolean().optional(),
            form: z.number().int().min(0).max(2).optional(),
            compose: composeSchema.optional().describe('region=face 时组合神态（见 l2d_face_compose）'),
            mood: z.string().optional().describe('region=face 时用预设配方名'),
          }),
        )
        .min(1)
        .max(12),
      ...busySchema,
      awaitDone: z.boolean().optional().describe('true 时等所有模块 action-done 再返回'),
    },
  },
  async ({ steps, priority, onBusy, cut, fadeMs, waitMs, awaitDone }) =>
    toolResult(await bridgeAct('/dsh-l2d/api/bridge/act', { source: 'llm', steps }, { priority, onBusy, cut, fadeMs, waitMs, awaitDone })),
);

server.registerTool(
  'l2d_accessory_set',
  {
    description: ACCESSORY_SET_DESCRIPTION,
    inputSchema: {
      items: z
        .array(z.object({ item: z.string().describe('饰品 id，如 monocle / black-glasses / flower-1'), on: z.boolean().optional().describe('true 戴上（默认），false 摘下') }))
        .min(1)
        .max(16),
      ...busySchema,
      awaitDone: z.boolean().optional(),
    },
  },
  async ({ items, priority, onBusy, cut, fadeMs, waitMs, awaitDone }) =>
    toolResult(
      await bridgeAct(
        '/dsh-l2d/api/bridge/act',
        { source: 'llm', steps: items.map((x) => ({ layer: 'accessory', item: x.item, on: x.on !== false })) },
        { priority, onBusy, cut, fadeMs, waitMs, awaitDone },
      ),
    ),
);

server.registerTool(
  'l2d_face_vocab',
  { description: FACE_VOCAB_DESCRIPTION, inputSchema: z.object({}) },
  async () => toolResult(await bridgeApi('/dsh-l2d/api/bridge/face/vocab', { cache: 'no-store' }, 8000)),
);

server.registerTool(
  'l2d_face_compose',
  {
    description: FACE_COMPOSE_DESCRIPTION,
    inputSchema: {
      compose: composeSchema.optional(),
      mood: z.string().optional().describe('预设配方名（与 compose 二选一）'),
      ...busySchema,
      awaitDone: z.boolean().optional(),
    },
  },
  async ({ compose, mood, priority, onBusy, cut, fadeMs, waitMs, awaitDone }) => {
    if (!compose && !mood) return toolResult({ ok: false, reason: 'invalid-command', message: '需要 compose 或 mood' });
    const body = { source: 'llm' };
    if (mood) body.mood = mood;
    else body.compose = compose;
    return toolResult(await bridgeAct('/dsh-l2d/api/bridge/face/compose', body, { priority, onBusy, cut, fadeMs, waitMs, awaitDone }));
  },
);

server.registerTool(
  'l2d_face_describe',
  { description: FACE_DESCRIBE_DESCRIPTION, inputSchema: z.object({}) },
  async () => toolResult(await bridgeApi('/dsh-l2d/api/bridge/face/describe', { cache: 'no-store' }, 8000)),
);

server.registerTool(
  'l2d_regions_release',
  {
    description: REGIONS_RELEASE_DESCRIPTION,
    inputSchema: {
      commandId: z.string().max(64).optional().describe('l2d_regions_act 返回的 commandId（或排队 ticket）'),
      region: z.enum([...BRIDGE_REGIONS]).optional(),
    },
  },
  async ({ commandId, region }) => {
    if (!commandId && !region) return toolResult({ ok: false, reason: 'invalid-command', message: '需要 commandId 或 region' });
    return toolResult(
      await bridgeApi(
        '/dsh-l2d/api/bridge/release',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(commandId ? { commandId } : { region }) },
        8000,
      ),
    );
  },
);

// ---------------------------------------------------------------- AI 节点编辑
// 「当前节点图」= 宿主已导入的分享 JSON（$DSH_HOME/l2d-nodegraphs/<name>.json），按 name 读写。
// 两个工具直连宿主路由（同 l2d_persona 风格，不经 /ai/call 队列）；宿主路由入口统一过
// host-guard 的 guardGraphCall（HOST_GRAPH_TOOLS 白名单），逐 op 校验在 nodegraph-ops.applyOps。
const GRAPH_OP_KINDS = ['add_node', 'remove_node', 'set_param', 'connect', 'disconnect', 'move_node'];

async function graphApi(pathAndQuery, init) {
  const base = await baseUrl();
  if (!base) return { ok: false, reason: 'plugin-offline' };
  try {
    const res = await fetchTimeout(base + pathAndQuery, init);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, reason: 'http-' + res.status };
    }
  } catch {
    cachedBase = '';
    return { ok: false, reason: 'unreachable' };
  }
}

server.registerTool(
  'l2d_graph_get',
  {
    description:
      '只读。读取宿主已导入的节点图（设计层：nodes/edges/pos/props）及其 hash。改图前先调它拿 hash，作为 l2d_graph_apply_ops 的 baseHash。节点类型、参数范围与 op 格式见 docs/nodegraph/NODE-SCHEMA.json。每条动作链属于一个模型：校验按图的绑定模型选清单（docs/nodegraph/models/<modelId>/live2d-ids.json，缺失回退全局），回执带 modelId 与 live2dIdsSource。name 缺省时返回 name-required 及可选名单。',
    inputSchema: {
      name: z.string().min(1).max(64).describe('已导入节点图的名称（GET /dsh-l2d/nodegraphs 列表里的 name）'),
    },
  },
  async ({ name }) => toolResult(await graphApi('/dsh-l2d/api/nodegraph/graph?name=' + encodeURIComponent(name), { cache: 'no-store' })),
);

server.registerTool(
  'l2d_graph_apply_ops',
  {
    description:
      '对已导入的节点图执行一批确定性编辑操作（add_node / remove_node / set_param / connect / disconnect / move_node）。整批原子：任一 op 不合法则全部不生效并返回带 opIndex 与英文 reason 的 errors；全部合法且整图校验通过才写回文件（saved:true）。baseHash 与当前图不一致返回 stale-graph，请重新 l2d_graph_get。动作/表情/参数 ID 按图绑定模型的清单校验（modelId 可选字段可显式指定，缺省用图绑定模型）；strict 绑定模型与宿主当前模型不一致的图，运行会得 409 model-mismatch。',
    inputSchema: {
      name: z.string().min(1).max(64).describe('已导入节点图的名称'),
      ops: z
        .array(z.object({ op: z.enum(GRAPH_OP_KINDS) }).passthrough())
        .max(200)
        .describe('编辑操作数组，字段格式见 docs/nodegraph/NODE-SCHEMA.json 的 ops'),
      baseHash: z.string().regex(/^[0-9a-f]{16}$/).describe('l2d_graph_get 返回的 hash'),
      modelId: z
        .string()
        .max(128)
        .optional()
        .describe('可选。显式指定校验用模型清单（模型文件名去 .model3.json，如 demo-model）；缺省用图的绑定模型'),
    },
  },
  async ({ name, ops, baseHash, modelId }) =>
    toolResult(
      await graphApi('/dsh-l2d/api/nodegraph/apply-ops', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(modelId ? { name, ops, baseHash, modelId } : { name, ops, baseHash }),
      }),
    ),
);

const transport = new StdioServerTransport();
await server.connect(transport);
