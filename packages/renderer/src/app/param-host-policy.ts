/**
 * Agent 参数托管白名单（Node Ownership 策略，纯逻辑，便于单测）。
 *
 * 背景：外部（Agent）通道对参数的写入必须收敛到一张显式托管白名单。
 * defaultOwnership='none'：Agent 默认不拥有任何参数，只能通过 own() 显式认领
 * 白名单内的参数；白名单外（发型/裙子/配饰/四肢等）一律拒绝外部写入。
 * allowDynamicDiscovery=false：白名单只能经 registerManagedIds() 显式扩展
 * （供已验证姿态参数注入），禁止运行时自动发现新参数。
 * preservePhysics=true：物理输出仍须先经 ownership 认领才能写，物理优先级不变。
 *
 * 红线分层：口型参数（LIPSYNC_PARAMS）在 injector.set() 里最先拒绝，优先级高于
 * 本白名单；registerManagedIds() 亦拒绝登记口型 id（防御纵深）。
 *
 * 通道语义（与 param-injector.ts 的 channel 参数对齐）：
 * - agent 通道：外部 API（setParameters/setParameter/ownParameters）走此通道，
 *   受本白名单约束；
 * - runtime 通道：渲染器既有执行路径（keyframes/ambient/pose/gaze/物理）走此通道，
 *   不受白名单影响——它们不是 Agent 外部写入源。
 */

import { LIPSYNC_PARAMS } from '../../../core/src/index.ts';

/** Node Ownership 策略声明（字段值即契约，禁止放宽）。 */
export interface HostPolicy {
  /** Agent 默认不拥有任何参数；own() 是唯一显式认领入口。 */
  defaultOwnership: 'none';
  /** 模型中不存在的参数一律拒绝（injector 侧由 parameterIndexOf 兜底）。 */
  unknownParameter: 'reject';
  /** 禁止运行时自动发现并托管新参数。 */
  allowDynamicDiscovery: false;
  /** 物理输出默认只读，认领后才能覆盖（物理先算、Agent 后写）。 */
  preservePhysics: true;
}

export const HOST_POLICY: HostPolicy = {
  defaultOwnership: 'none',
  unknownParameter: 'reject',
  allowDynamicDiscovery: false,
  preservePhysics: true,
};

/**
 * 初始托管集：已对照大肥鱼模型（大肥鱼.dsl2d）SQLite parameters 注册表逐一核实，
 * 全部为该模型真实存在的 Parameter ID（ParamAngle* 与 ParamBodyAngle* 范围 ±30，
 * ParamEyeBall* 范围 ±1）。
 *
 * S1-RACE 修复（2026-11-05）：模型里 AngleX/Y/Z（短名）与 ParamAngleX/Y/Z（规范名）
 * 是并存的两套真实参数；overlay 验收契约（overlay-test.html?s1=1 的
 * setParameter('AngleZ', 20)）与外部 MCP 写入使用短名，此前不在托管集内，
 * agent 通道在 setParameterChecked 入口被 not_hostable 拒绝——S1 sticky 断言
 * 由此长期失败（stickyAccepted=false，写入未进入 angleBus→注入链）。
 * 短名与既有 ParamAngle* 条目属同一物理输入族，故一并登记；
 * PositionX/Y/Z 维持拒绝（agent 通道无既有条目对应，留待产品裁决）。
 */
export const MANAGED_PARAM_IDS: readonly string[] = [
  'AngleX',
  'AngleY',
  'AngleZ',
  'ParamAngleX',
  'ParamAngleY',
  'ParamAngleZ',
  'ParamBodyAngleX',
  'ParamBodyAngleY',
  'ParamBodyAngleZ',
  'ParamEyeBallX',
  'ParamEyeBallY',
];

const managed = new Set<string>(MANAGED_PARAM_IDS);

/** 口型红线：任何通道都不放行，registerManagedIds 也不得登记。 */
const MOUTH_BLOCK = new Set<string>(LIPSYNC_PARAMS);

function normalizeId(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/** 参数是否在托管白名单内（外部通道可写/可认领）。 */
export function isHostable(id: string): boolean {
  const key = normalizeId(id);
  return !!key && managed.has(key);
}

/**
 * 显式扩展托管集（已验证姿态参数注入；allowDynamicDiscovery=false 的唯一入口）。
 * 口型 id、空值、重复 id 不登记。@returns 实际新登记的 id。
 */
export function registerManagedIds(ids: Iterable<string>): string[] {
  const accepted: string[] = [];
  for (const raw of ids ?? []) {
    const id = normalizeId(raw);
    if (!id || managed.has(id) || MOUTH_BLOCK.has(id)) continue;
    managed.add(id);
    accepted.push(id);
  }
  return accepted;
}

export type ExternalWriteVerdict = 'ok' | 'not_hostable' | 'lipsync_redline';

/**
 * 外部（agent 通道）写入判定：口型红线优先级最高，其次托管白名单。
 * injector.set() 的 agent 通道闸门与外部入口预检共用本判定，保证口径一致。
 */
export function evaluateExternalWrite(id: string): ExternalWriteVerdict {
  const key = normalizeId(id);
  if (!key) return 'not_hostable';
  if (MOUTH_BLOCK.has(key)) return 'lipsync_redline';
  return managed.has(key) ? 'ok' : 'not_hostable';
}

/** agent 通道 own() 过滤：只保留白名单内参数（口型同拒）。 */
export function filterHostable(ids: Iterable<string>): string[] {
  const out: string[] = [];
  for (const raw of ids ?? []) {
    if (evaluateExternalWrite(raw) === 'ok') out.push(normalizeId(raw));
  }
  return out;
}

/** 诊断快照：当前完整托管集（含显式扩展）。 */
export function managedSnapshot(): string[] {
  return Array.from(managed);
}
