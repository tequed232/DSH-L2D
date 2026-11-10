/**
 * MCP 部位联动工具（l2d_regions_get / l2d_regions_act / l2d_regions_release）的描述与请求形状。
 *
 * 描述文字由 body-bridge.mjs 的 describeRegions(分区表) 生成——每个模块能做什么、能写哪些参数，
 * 直接写进工具说明里，LLM 不用先查表。规则和表都只有一份，不在这里另写名单。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRIDGE_CUTS,
  BRIDGE_ON_BUSY,
  BRIDGE_PRIORITIES,
  BRIDGE_REASONS,
  BRIDGE_REGIONS,
  compileBodyTable,
  describeRegions,
  pickFaceUnitsFile,
} from '../../dsh-l2d-plugin/lib/body-bridge.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MODELS_DIR = path.resolve(here, '../../../docs/nodegraph/models');

/**
 * 找一张分区表生成描述：DSH_L2D_MODEL_ID 指定的模型优先，否则取 models 目录里第一张 body-regions.json。
 * 找不到时返回 null（描述退化为通用说明，调用时宿主仍会按真实表校验）。
 */
export function loadCapabilitiesForDescription(options = {}) {
  const dir = options.modelsDir || DEFAULT_MODELS_DIR;
  const fsImpl = options.fs || fs;
  const wanted = options.modelId || process.env.DSH_L2D_MODEL_ID || '';
  let ids = [];
  try {
    ids = fsImpl.readdirSync(dir).sort();
  } catch {
    return null;
  }
  if (wanted) ids = [wanted, ...ids.filter((x) => x !== wanted)];
  for (const id of ids) {
    if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) continue;
    try {
      const table = JSON.parse(fsImpl.readFileSync(path.join(dir, id, 'body-regions.json'), 'utf8'));
      // 神态部件表可选：face-units.json 优先，没有再 face-vocab.json；坏了就不写 compose 能力
      let faceUnits = null;
      const faceName = pickFaceUnitsFile((n) => {
        try {
          return fsImpl.statSync(path.join(dir, id, n)).isFile();
        } catch {
          return false;
        }
      });
      if (faceName) {
        try {
          faceUnits = JSON.parse(fsImpl.readFileSync(path.join(dir, id, faceName), 'utf8'));
        } catch {
          faceUnits = null;
        }
      }
      return { modelId: id, faceFile: faceName || '', capabilities: describeRegions(compileBodyTable(table, { faceUnits })) };
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

/** cut 三个取值的说明（l2d_regions_act / l2d_face_compose / l2d_accessory_set 共用）。 */
export const CUT_DESCRIPTION =
  'cut（onBusy=blend 时生效，默认 next）：' +
  'now = 立刻切（情绪突变、被吓到、被打断时用；手部仍按手势路径先关后开，不会两个手势直接交叉）；' +
  'next = 等当前动作到下一个可衔接点再切（说话停顿处换动作用，最常用；手部最多等 600ms，超时按高优先级强切）；' +
  'after = 等当前动作播完再接（不想打断正在做的动作时用）。';

export const ON_BUSY_DESCRIPTION =
  'onBusy：blend（默认）按 cut 衔接，旧动作在衔接点交叉淡变到新动作；wait 排队等模块空出来；reject 被占就立即返回 region-busy。' +
  '低优先级永远不能用 now / next 打断高优先级（自动变成 after）；同一模块只保留最新一条待执行指令，旧的返回 superseded。';

/** l2d_regions_act 的工具说明（给 LLM 看：规则 + 每模块能力 + 原因码）。 */
export function regionsActDescription(loaded) {
  const lines = [
    '按身体部位下发一次联动（五个独立模块 hair 头发 / face 神态 / hands 手部 / torso 腰部躯干 / legs 腿部，加表情层 expression 与形态层 form）。',
    'steps 里的各步同时开始；每步一种：{region, motion} 播该模块的动作；{region, set:{参数:值}, durationMs?} 把该模块可写参数插值到目标值（durationMs 默认 0 = 当帧到位，到位后保持）；' +
      '{region:"face", compose:{dimensions:{慵懒:0.6, 挑逗:0.7}, units?, recipes?, side?, energy?, expressions?, enterMs?, holdMs?}} 按情绪维度/部件组合神态（细节见 l2d_face_compose）；{region:"face", mood:"妩媚"} 用预设配方；' +
      '{layer:"expression", expression, on} 开关表情；{layer:"accessory", item, on?} 戴/摘饰品（饰品全部可同时佩戴，各自独立开关）；{layer:"form", form:0|1|2} 切形态。',
    '同一模块一条指令只能一步；涉及的模块要全部拿到才执行，否则整条拒绝（不会只做一半）。',
    'priority：LOW < NORMAL < HIGH < FORCE（BACKGROUND 视作 LOW），默认 NORMAL。' + ON_BUSY_DESCRIPTION,
    CUT_DESCRIPTION + ' fadeMs 是交叉淡变时长，默认 300，范围 200–400。',
    '成功回执 {ok, commandId, accepted, preempted, cut:{mode, atMs, fadeMs, waitedMs}, gesture?, warnings}；排队时 {queued, ticket, readyInMs}。每个模块做完各发一个 action-done（带 commandId 与 region），awaitDone:true 时本工具等它们都回来再返回。',
    '规则：物理输出只读（要让头发动，转头写 face 的 AngleX/Y/Z，或写 torso 的 LeanInput / ParamBreath / Position*）；ParamMouthOpenY 等口型参数是红线；尾巴/兽耳等未分区参数第一版不开放；表情「前倾」会转成 torso 写 LeanInput、「脱鞋」转成 legs 写 Clothes4（模块优先）；眼型表情（圈圈眼/屑/爱心眼/＞＜）互斥，三个体型表情互斥且形态层优先。',
    '失败原因：' + BRIDGE_REASONS.join(' / ') + '。region-busy / expression-conflict 是正常仲裁结果，换时机或提高优先级，不要原样重试。',
  ];
  if (loaded && loaded.capabilities) {
    const caps = loaded.capabilities;
    lines.push('当前模型 ' + loaded.modelId + ' 的模块能力：');
    for (const name of BRIDGE_REGIONS) {
      const r = caps.regions[name];
      const motions = r.motions.length ? '动作 ' + r.motions.join('、') : '无动作';
      lines.push('- ' + name + '（' + r.label + '）：' + motions + '；可写参数 ' + (r.writable.length ? r.writable.join(', ') : '（无）'));
    }
    lines.push('- expression：' + caps.expression.expressions.join('、') + '；互斥组 ' + caps.expression.mutexGroups.map((g) => g.expressions.join('/')).join('；'));
    lines.push('- form：0=默认体型 1=体型1 2=体型2（管 ' + caps.form.params.join('、') + '）');
    if (caps.accessory && caps.accessory.slots) {
      lines.push('- accessory（全部可同时佩戴）：' + caps.accessory.slots.map((sl) => sl.label + ' ' + sl.items.map((it) => it.id + '=' + it.label).join('/')).join('；'));
    }
    if (caps.face) {
      lines.push('- face compose 情绪维度：' + caps.face.dimensions.join('、') + '；预设配方 mood：' + caps.face.recipes.join('、'));
    }
  }
  return lines.join('\n');
}

export const REGIONS_GET_DESCRIPTION =
  '只读。查看各部位模块现在被谁占着（commandId / priority / source）、在播什么、排队情况、当前表情和最近的 action-done 事件，以及每个模块能做什么、可写哪些参数（capabilities）。下发 l2d_regions_act 前可先看一眼。';

export const REGIONS_RELEASE_DESCRIPTION =
  '释放部位模块：传 commandId 一次释放该指令占着的全部模块（排队中的 ticket 则直接出队），或传 region 只释放一个模块。被释放的模块发 action-done phase=interrupted reason=released。已经写到位的参数值保持不变。';

export const ACCESSORY_SET_DESCRIPTION =
  '戴上或摘下饰品。所有饰品都可以同时佩戴、互不冲突，每个独立开关（没有同槽替换）：items:[{item:"monocle", on:true}, {item:"flower-1", on:false}]。' +
  '鞋 / 裙长 / 胸口衣服属于腿部 / 躯干模块，会占用对应模块；眼镜、钢盆、尾巴走表情层但彼此不互斥。l2d_regions_get 的 accessories 字段返回每个槽当前戴着什么。';

export const FACE_VOCAB_DESCRIPTION =
  '只读。返回当前模型的神态部件表原文（face-units.json，没有则 face-vocab.json）：参数含义与范围、neverWrite、动作单元 actionUnits、表情单元、合成算法、预设配方 recipes、13 个情绪维度表。下发 l2d_face_compose 前看一眼就知道能用哪些维度和部件。';

export const FACE_COMPOSE_DESCRIPTION =
  '组合神态：compose.dimensions 写情绪维度强度（对象 {慵懒:0.6, 挑逗:0.7} 或数组 [{dimension, intensity}]），也可直接给 units:{部件:强度} 或 recipes。' +
  '部件权重 = Σ 维度强度 × 该维度的部件权重，能量 = 强度加权平均；超过阈值的表情单元（脸红等）自动开；对立部件相互抵消；有方向的部件统一用 side（"L" 或 "R"）；自带轻微摆动，眨眼乘在睁眼值上。' +
  'enterMs 默认 1000 渐入，holdMs 到时自动渐出（不给就一直保持，用 l2d_regions_release 释放）。' +
  '回执 written:[{param, value, meaning, contributions:[{unit, amount}]}] 和 blocked（口型红线、被高优先级占着的其他模块等被跳过的部件）。头部转动 AngleX/Y/Z 属 face，前倾 LeanInput 属 torso。';

export const FACE_DESCRIBE_DESCRIPTION =
  '只读。读模型当前神态参数，反推各部件大概强度（非负最小二乘，左右两侧都试），用来确认现在脸上是什么表情。';

export { BRIDGE_CUTS, BRIDGE_ON_BUSY, BRIDGE_PRIORITIES, BRIDGE_REGIONS };
