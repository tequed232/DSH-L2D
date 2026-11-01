/**
 * 从 dist/capabilities.json 生成 AI function-calling 工具定义。
 *
 * 设计取舍：不把 509 个裸参数直接暴露给模型。
 *   - 参数名是 VTS 转换来的自定义名（AngleX / CheeckPuff / AngleXbs2…），LLM 无法可靠推断语义
 *   - 枚举 509 项会占用大量上下文，且模型仍会写错
 * 所以暴露的是「语义工具」：表情、动作组、视线、情绪合成、姿态重置。
 * 需要精细控制时用 l2d_set_parameters，并附带关键参数白名单与取值范围。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CAP_FILE = path.join(ROOT, 'dist', 'capabilities.json');
const OUT_FILE = path.join(ROOT, 'dist', 'ai-tools.json');

const cap = JSON.parse(fs.readFileSync(CAP_FILE, 'utf8'));

const expressions = (cap.expressions || []).map((e) => e.name || e);
const motionGroups = (cap.motionGroups || []).map((g) => g.name || g);

/** 成对动作组：必须成对使用，否则会停在奇怪的状态 */
const PAIRED = motionGroups
  .filter((n) => /打开|关闭/.test(n))
  .reduce((acc, n) => {
    acc[n] = true;
    return acc;
  }, {});

const tools = [
  {
    type: 'function',
    function: {
      name: 'l2d_set_pose',
      description:
        '控制四肢姿势。使用预设枚举，不要手写底层参数；right/left 可同时给，未给的一侧保持 rest。动作播放期间会被拒绝，稍后重试即可。',
      parameters: {
        type: 'object',
        properties: {
          right: {
            type: 'string',
            enum: ['rest', 'finger', 'grass', 'chest'],
            description: '右手姿势：rest 自然放下，finger 竖食指，grass 拿狗尾巴草，chest 手放胸前',
          },
          left: {
            type: 'string',
            enum: ['rest', 'finger', 'grass', 'chest'],
            description: '左手姿势，语义同 right',
          },
        },
        anyOf: [{ required: ['right'] }, { required: ['left'] }],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'l2d_set_expression',
      description:
        '切换角色表情。表情是预设的整体面部状态，切换后会保持。适合表达明确情绪，不要每句话都调用。',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            enum: expressions,
            description: '表情名称，必须从枚举中选择',
          },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'l2d_play_motion',
      description:
        '播放一次动作。注意：带「打开/关闭」的动作是成对的状态切换，必须先「打开」再「关闭」才能回到默认姿态，不要只播一半。',
      parameters: {
        type: 'object',
        properties: {
          group: {
            type: 'string',
            enum: motionGroups,
            description: '动作组名，必须从枚举中选择',
          },
          index: {
            type: 'integer',
            minimum: 0,
            description: '同组内的动作下标，默认 0',
          },
        },
        required: ['group'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'l2d_look_at',
      description:
        '控制视线与头部朝向。以角色为原点，x 向右为正、y 向上为正，范围 -1 到 1。用于「看向某个方向」「思考时看右上」等。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', minimum: -1, maximum: 1, description: '水平方向，-1 最左，1 最右' },
          y: { type: 'number', minimum: -1, maximum: 1, description: '垂直方向，-1 最下，1 最上' },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'l2d_set_parameters',
      description:
        '直接设置底层参数，用于表情动作覆盖不到的细微调整。参数值范围通常是 -30 到 30（角度制），面部开合类参数是 0 到 1。不确定参数名时不要调用。',
      parameters: {
        type: 'object',
        properties: {
          values: {
            type: 'object',
            description: '参数名到数值的映射，例如 {"AngleX": 12, "AngleY": -6}',
            additionalProperties: { type: 'number' },
          },
        },
        required: ['values'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'l2d_play_keyframes',
      description:
        '用关键帧自己编排一段动作。这是最灵活的能力：把若干个参数随时间的变化描述出来，引擎会插值播放。适合做出预设动作里没有的手势、点头、摇头、惊讶后仰等。限制：最多 8 条轨道、每条最多 32 个关键帧、总时长不超过 10 秒；参数名必须真实存在，值会被钳制到参数自身范围。',
      parameters: {
        type: 'object',
        properties: {
          tracks: {
            type: 'array',
            maxItems: 8,
            description: '轨道列表，每条描述一个参数随时间的取值',
            items: {
              type: 'object',
              properties: {
                param: {
                  type: 'string',
                  description: '参数名，例如 ParamAngleZ、AngleX、ParamEyeLOpen',
                },
                keys: {
                  type: 'array',
                  maxItems: 32,
                  description: '[[时间ms, 值], ...]，按时间从早到晚',
                  items: {
                    type: 'array',
                    minItems: 2,
                    maxItems: 2,
                    items: { type: 'number' },
                  },
                },
              },
              required: ['param', 'keys'],
            },
          },
          duration: {
            type: 'integer',
            description: '总时长毫秒，缺省取最后一个关键帧的时间',
          },
          loop: { type: 'boolean', description: '是否循环播放，默认 false' },
        },
        required: ['tracks'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'l2d_stop_keyframes',
      description: '停止正在播放的关键帧动画。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'l2d_reset_pose',
      description: '把所有参数恢复默认值，回到自然站姿。用于结束一段表演后收尾。',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const payload = {
  generatedAt: new Date().toISOString(),
  model: cap.name,
  summary: {
    expressions: expressions.length,
    motionGroups: motionGroups.length,
    params: Object.keys(cap.params || {}).length,
  },
  pairedMotionGroups: Object.keys(PAIRED),
  motionSlots: [
    {
      base: '抚胸手',
      open: '抚胸手打开',
      close: '抚胸手关闭',
      side: 'left',
    },
    {
      base: '竖手指',
      open: '竖手指打开',
      close: '竖手指关闭',
      side: 'right',
      pose: 'finger',
    },
    {
      base: '狗尾巴草',
      open: '狗尾巴草打开',
      close: '狗尾巴草关闭',
      side: 'right',
      pose: 'grass',
    },
  ],
  tools,
};

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), 'utf8');

console.log('[gen-ai-tools] 已生成 ' + OUT_FILE);
console.log('  表情 ' + expressions.length + ' / 动作组 ' + motionGroups.length + ' / 工具 ' + tools.length);
console.log('  成对动作组: ' + (Object.keys(PAIRED).join(', ') || '无'));
