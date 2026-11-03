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
import { randomUUID } from 'node:crypto';
import { resolveBase } from './discover.mjs';
import { actSettled, mergeActEvents, shapeActReceipt } from './act-result.mjs';
import { executeActionSequence, validateActionSequence } from './action-sequence.mjs';
import { CHOREOGRAPHY } from '../../dsh-l2d-plugin/lib/choreography.mjs';
import { findReservedParams, validateActChain, validateExpressionName, validateMotionGroup } from './validate.mjs';

let cachedBase = '';

async function baseUrl() {
  if (cachedBase) return cachedBase;
  cachedBase = await resolveBase();
  return cachedBase;
}

function normalize(result) {
  if (!result || typeof result !== 'object') return { ok: false, reason: 'empty' };
  if (result.ok === false && !result.reason && result.error) {
    return { ...result, reason: String(result.error) };
  }
  return result;
}

async function forward(name, args, timeoutMs, mode) {
  const base = await baseUrl();
  if (!base) {
    return { ok: false, reason: 'plugin-offline' };
  }
  let queued;
  try {
    const res = await fetch(base + '/dsh-l2d/ai/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, args: args || {} }),
    });
    // 守卫拒绝的 4xx 是 text/plain（如 "reserved-param: ParamMouthOpenY"），
    // 先 res.json() 会抛 SyntaxError 掉进 catch，被误报成 unreachable 并清掉缓存地址。
    // 正确顺序：先读文本 → 尽力解析 → 再看状态码。
    const text = await res.text();
    try {
      queued = text ? JSON.parse(text) : null;
    } catch {
      queued = { ok: false, reason: text.slice(0, 200) || 'call-rejected' };
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: (queued && (queued.reason || queued.error)) || 'call-rejected',
        status: res.status,
      };
    }
    if (!queued || queued.ok === false) {
      return { ok: false, reason: (queued && (queued.reason || queued.error)) || 'call-rejected' };
    }
  } catch (err) {
    // 只有网络层失败才清缓存地址
    cachedBase = '';
    return { ok: false, reason: 'unreachable' };
  }

  const id = queued.id;
  const started = Date.now();
  let events = [];
  let acceptResult = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(base + '/dsh-l2d/ai/result?id=' + encodeURIComponent(id), { cache: 'no-store' });
      if (res.ok) {
        const body = await res.json();
        if (body && Array.isArray(body.events)) events = mergeActEvents(events, body.events);
        if (body && body.ready) {
          acceptResult = normalize(body.result);
          if (acceptResult && Array.isArray(acceptResult.events)) {
            events = mergeActEvents(events, acceptResult.events);
          }
        }
        if (acceptResult) {
          const waitForTerminal = mode === 'act' && acceptResult.accepted === true;
          if (!waitForTerminal || actSettled(events, acceptResult.runId)) {
            return mode === 'act' ? shapeActReceipt(acceptResult, events) : acceptResult;
          }
        }
      }
    } catch {
      /* 下一轮再取 */
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  if (mode === 'act' && acceptResult && acceptResult.accepted === true) {
    return shapeActReceipt(acceptResult, events);
  }
  return { ok: false, reason: 'timeout', events };
}

function toolResult(result) {
  const text = JSON.stringify(result);
  const benign =
    result &&
    (result.reason === 'skipped' ||
      result.reason === 'conflict' ||
      result.reason === 'priority-blocked' ||
      result.reason === 'pending' ||
      result.status === 'skipped' ||
      result.status === 'conflict');
  return {
    content: [{ type: 'text', text }],
    isError: result && result.ok === false && !benign,
  };
}

/** Workspace Action Protocol：响应信封原样输出。rejected/failed 是正常信封不是 MCP 错误；只有传输层失败才 isError。 */
const ACTION_TERMINAL = new Set(['completed', 'failed', 'rejected']);

function envelopeResult(envelope, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(envelope) }], isError };
}

async function submitAgentAction(base, envelope) {
  const res = await fetch(base + '/dsh-l2d/agent/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  // 守卫拒绝的 4xx 是 text/plain；先读文本再尽力解析，避免 SyntaxError 误报 unreachable。
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok || !body || typeof body !== 'object') {
    return {
      err: {
        ok: false,
        reason: (body && (body.reason || body.error)) || text.slice(0, 200) || 'submit-rejected',
        status: res.status,
      },
    };
  }
  return { envelope: body };
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
    description: '切换模型自带表情。名字必须是模型里真实存在的表情。',
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
    description: '播放动作组。打开/关闭是成对状态，重复打开会得到 skipped，右臂冲突会得到 conflict。这是正常结果，换一个动作，不要原样重试。',
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
    description: '混合动作编排入口。简单状态反应优先传 presetState（error/attention/working/thinking/idle/bootstrap/user-direct），程序复用 choreography.mjs 已验证的预设链；复杂对话、情绪或多阶段演出则由 Agent 自行生成 segments（1~3 段，每段最多 8 步）。两者只能选一个。程序逐段调用现有 l2d_act，只有上一段明确 completed 才执行下一段。返回 conflict / priority-blocked / interrupted / pending 时必须停止，读取回执后重新规划不同的链，不要原样重试。只允许 expression / motion / pose / look；表情和动作必须使用当前模型真实白名单。',
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
      })).min(1).max(3).optional(),
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
    const validation = validateActionSequence(plan);
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
        const res = await fetch(base + '/dsh-l2d/balance.json', { cache: 'no-store' });
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
      const response = await fetch(base + '/dsh-l2d/workspace/ensure', { method: 'POST' });
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
      const response = await fetch(base + '/dsh-l2d/workspace/status.json', { cache: 'no-store' });
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
        const res = await fetch(base + '/dsh-l2d/persona.json', { cache: 'no-store' });
        if (!res.ok) return toolResult({ ok: false, reason: 'http-' + res.status });
        return toolResult(await res.json());
      }
      const body = action === 'reset' ? { reset: true } : { patch: patch || {} };
      const res = await fetch(base + '/dsh-l2d/persona.json', {
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
  'l2d_agent_action',
  {
    description:
      '通过双向动作协议（Workspace Action Protocol）提交一个工作区动作并等待执行结果。action.name 必须是宿主白名单内的 l2d_* 工具（如 l2d_look_at、l2d_emote、l2d_act），动作会经宿主守卫校验白名单与参数；被守卫拒绝时返回 status=rejected 的响应信封，这是正常结果而不是错误——读 summary 后改用别的动作，不要原样重试。waitMs（默认 8000，0=只提交立即返回）内拿到 completed/failed/rejected 即返回完整响应信封（summary/status/result/followUp 原样给出）；超时则返回当时状态（accepted/executing）并附 requestId 与续查端点。userIntent 写入 user.intent，是宿主理解动作目的的依据。返回的是协议信封 JSON，不是自然语言。',
    inputSchema: {
      action: z
        .object({
          name: z.string().min(1).describe('宿主白名单内的 l2d_* 工具名，例如 l2d_look_at'),
          target: z.string().optional().describe('动作目标，可选'),
          parameters: z.record(z.string(), z.unknown()).optional().describe('动作参数，透传给宿主工具'),
        })
        .describe('要执行的动作'),
      userIntent: z.string().min(1).describe('用户意图（写入 user.intent），例如「看右侧」'),
      workspaceNote: z.string().optional().describe('附加到 workspace.stateSummary 后面的备注，可选'),
      requestId: z
        .string()
        .regex(/^[\w.-]{4,64}$/)
        .optional()
        .describe('请求关联 ID，缺省自动生成 req_<随机>；跨调用续查时必须复用同一个值'),
      waitMs: z
        .number()
        .int()
        .min(0)
        .max(30000)
        .optional()
        .describe('等待终态的毫秒数，默认 8000；0=只提交立即返回 accepted'),
    },
  },
  async ({ action, userIntent, workspaceNote, requestId, waitMs }) => {
    const base = await baseUrl();
    if (!base) return envelopeResult({ ok: false, reason: 'plugin-offline' }, true);
    const rid = requestId || 'req_' + randomUUID().replace(/-/g, '').slice(0, 20);
    const envelope = {
      requestId: rid,
      type: 'workspace.action',
      action: {
        name: action.name,
        ...(action.target !== undefined ? { target: action.target } : {}),
        ...(action.parameters !== undefined ? { parameters: action.parameters } : {}),
      },
      workspace: {
        id: 'dsh-l2d',
        name: 'DSH-L2D',
        type: 'development',
        ...(workspaceNote !== undefined ? { stateSummary: workspaceNote } : {}),
      },
      user: { intent: userIntent },
      responseFormat: { requireAction: true, requireSummary: true, language: 'zh-CN' },
    };
    let submitted;
    try {
      submitted = await submitAgentAction(base, envelope);
    } catch {
      cachedBase = '';
      return envelopeResult({ ok: false, reason: 'unreachable', requestId: rid }, true);
    }
    if (submitted.err) return envelopeResult({ ...submitted.err, requestId: rid }, true);

    const wait = waitMs === undefined ? 8000 : waitMs;
    let latest = submitted.envelope;
    if (wait > 0 && !ACTION_TERMINAL.has(latest.status)) {
      const deadline = Date.now() + wait;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        try {
          const res = await fetch(base + '/dsh-l2d/agent/action/result?requestId=' + encodeURIComponent(rid), { cache: 'no-store' });
          if (res.ok) {
            const env = await res.json();
            if (env && typeof env === 'object' && typeof env.status === 'string') {
              latest = env;
              if (ACTION_TERMINAL.has(env.status)) return envelopeResult(env);
            }
          }
          // 404 = 信封尚未登记，继续等
        } catch {
          /* 下一轮再取 */
        }
      }
      // 超时：返回当前状态 + 续查提示（不包装成自然语言，信封字段原样保留）
      return envelopeResult({
        ...latest,
        followUp: { required: true, description: `动作仍在 ${latest.status}，未在 ${wait}ms 内到达终态。可携带同一 requestId 续查：GET ${base}/dsh-l2d/agent/action/result?requestId=${encodeURIComponent(rid)}` },
        timedOut: true,
      });
    }
    return envelopeResult(latest);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
