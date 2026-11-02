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
import { actSettled, mergeActEvents, shapeActReceipt } from './act-result.mjs';
import { executeActionSequence, validateActionSequence } from './action-sequence.mjs';

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
    queued = await res.json();
    if (!res.ok || !queued || queued.ok === false) {
      return { ok: false, reason: (queued && (queued.reason || queued.error)) || 'call-rejected' };
    }
  } catch (err) {
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
  async ({ name }) => toolResult(await forward('l2d_set_expression', { name }, 3000)),
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
  async ({ group, index, awaitFinish }) =>
    toolResult(await forward('l2d_play_motion', { group, index, awaitFinish }, awaitFinish ? 15000 : 4000)),
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
    return toolResult(await forward('l2d_act', { chain, bubble, priority, phase }, 12000, 'act'));
  },
);

server.registerTool(
  'l2d_act_sequence',
  {
    description: 'Agent 自主动作编排执行器。先根据当前对话、角色状态和上一段执行回执，自行规划 1~3 段连续动作；每段最多 8 步。程序逐段调用现有 l2d_act，只有上一段明确 completed 才执行下一段。返回 conflict / priority-blocked / interrupted / pending 时必须停止，读取回执后重新规划不同的链，不要原样重试。只允许 expression / motion / pose / look；表情和动作必须使用当前模型真实白名单。可将一个意图拆成回应、动作、收尾等连续演出。',
    inputSchema: {
      segments: z.array(z.object({
        chain: z.array(z.object({
          kind: z.enum(['expression', 'motion', 'pose', 'look']),
          name: z.string().optional(),
          closeMotion: z.string().optional(),
          closeAfterMs: z.number().optional(),
          delayMs: z.number().optional(),
          pose: z.object({
            right: z.enum(['rest', 'finger', 'grass', 'chest']).optional(),
            left: z.enum(['rest', 'finger', 'grass', 'chest']).optional(),
          }).optional(),
          x: z.number().optional(),
          y: z.number().optional(),
        })).min(1).max(8),
        priority: z.enum(['BACKGROUND', 'NORMAL', 'FORCE']).optional(),
        bubble: z.string().max(40).optional(),
      })).min(1).max(3),
    },
  },
  async ({ segments }) => {
    const plan = { segments };
    const validation = validateActionSequence(plan);
    if (!validation.ok) return toolResult({ ok: false, status: 'rejected', reason: 'invalid-sequence', errors: validation.errors, receipts: [] });
    return toolResult(await executeActionSequence(plan, (args) => forward('l2d_act', args, 12000, 'act')));
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

const transport = new StdioServerTransport();
await server.connect(transport);
