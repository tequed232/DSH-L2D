/**
 * MCP 部位联动工具（l2d_regions_get / l2d_regions_act / l2d_regions_release）的描述与请求形状。
 *
 * 描述文字由 body-bridge.mjs 的 describeRegions(分区表) 生成——每个模块能做什么、能写哪些参数，
 * 直接写进工具说明里，LLM 不用先查表。规则和表都只有一份，不在这里另写名单。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_PRIORITIES, BRIDGE_REASONS, BRIDGE_REGIONS, compileBodyTable, describeRegions } from '../../dsh-l2d-plugin/lib/body-bridge.mjs';

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
      return { modelId: id, capabilities: describeRegions(compileBodyTable(table)) };
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

/** l2d_regions_act 的工具说明（给 LLM 看：规则 + 每模块能力 + 原因码）。 */
export function regionsActDescription(loaded) {
  const lines = [
    '按身体部位下发一次联动（五个独立模块 hair 头发 / face 神态 / hands 手部 / torso 腰部躯干 / legs 腿部，加表情层 expression 与形态层 form）。',
    'steps 里的各步同时开始；每步二选一：{region, motion} 播该模块的动作，{region, set:{参数:值}, durationMs?} 把该模块可写参数插值到目标值（durationMs 默认 0 = 当帧到位，到位后保持），{layer:"expression", expression, on} 开关表情，{layer:"form", form:0|1|2} 切形态。',
    '同一模块一条指令只能一步；涉及的模块要全部拿到才执行，否则整条拒绝（不会只做一半）。',
    'priority：LOW < NORMAL < HIGH < FORCE（BACKGROUND 视作 LOW）。严格更高才抢占，只收尾被抢的模块；同级或更低返回 region-busy 并告诉你当前谁占着。onBusy:"wait" + waitMs 可排队等。',
    '成功回执 {ok, commandId, accepted, preempted, warnings}；每个模块做完各发一个 action-done（带 commandId 与 region），awaitDone:true 时本工具等它们都回来再返回。',
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
  }
  return lines.join('\n');
}

export const REGIONS_GET_DESCRIPTION =
  '只读。查看各部位模块现在被谁占着（commandId / priority / source）、在播什么、排队情况、当前表情和最近的 action-done 事件，以及每个模块能做什么、可写哪些参数（capabilities）。下发 l2d_regions_act 前可先看一眼。';

export const REGIONS_RELEASE_DESCRIPTION =
  '释放部位模块：传 commandId 一次释放该指令占着的全部模块（排队中的 ticket 则直接出队），或传 region 只释放一个模块。被释放的模块发 action-done phase=interrupted reason=released。已经写到位的参数值保持不变。';

export { BRIDGE_PRIORITIES, BRIDGE_REGIONS };
