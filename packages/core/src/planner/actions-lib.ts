/**
 * SQLite Actions Lib 查询集成（PR-D）。
 * 不新建动作数据库、不加新表：通过依赖注入复用 @dsh/db actions-repo 的既有能力；
 * 本文件定义规划侧需要的最小查询面 + 模型版本校验 + 成功率记账接口。
 * 正式 DB 接线在 Runtime 侧接入时完成（本 PR 只定契约与内存实现用于测试）。
 */
import type { MotionPlan, PlannerIntent } from './types.ts';

/** 动作定义（来自 Actions Lib 的入库记录投影）。 */
export interface ActionRecord {
  actionId: string;
  /** 动作类型（与 MotionPlanStep.type 同词汇） */
  type: 'motion3' | 'expression' | 'parameter' | 'keyframes';
  name: string;
  /** 可用模型版本键集合（modelHash 前缀即可） */
  compatibleModelHashes: string[];
  /** 执行统计（真实执行结果回写） */
  attempts: number;
  successes: number;
}

/** 规划侧最小查询面（由 actions-repo 适配实现）。 */
export interface ActionsLibQuery {
  findAction(actionName: string): ActionRecord | null;
  /** 模型版本校验：动作与当前 modelHash 兼容才可用于规划 */
  isCompatible(record: ActionRecord, modelHash: string): boolean;
  /** 记录真实执行结果（phase: end/interrupted/failed 三态，failed 计入成功率分母不计分子） */
  recordOutcome(actionId: string, phase: 'end' | 'interrupted' | 'failed'): void;
  successRate(actionId: string): number | null;
}

/** 内存实现（测试与无 DB 环境的降级路径；生产实现由 @dsh/db 适配注入）。 */
export class InMemoryActionsLib implements ActionsLibQuery {
  private records = new Map<string, ActionRecord>();

  seed(records: ActionRecord[]): void {
    for (const r of records) this.records.set(r.name, r);
  }

  findAction(actionName: string): ActionRecord | null {
    return this.records.get(actionName) || null;
  }

  isCompatible(record: ActionRecord, modelHash: string): boolean {
    if (!record.compatibleModelHashes.length) return false; // 无版本证据 = 不可用（fail-closed）
    return record.compatibleModelHashes.some((h) => modelHash.startsWith(h) || h === '*');
  }

  recordOutcome(actionId: string, phase: 'end' | 'interrupted' | 'failed'): void {
    for (const r of this.records.values()) {
      if (r.actionId !== actionId) continue;
      r.attempts++;
      if (phase === 'end') r.successes++; // interrupted/failed 都不算成功
    }
  }

  successRate(actionId: string): number | null {
    for (const r of this.records.values()) {
      if (r.actionId !== actionId) continue;
      return r.attempts ? r.successes / r.attempts : null;
    }
    return null;
  }
}

/** 规划期查询：动作可用性 = 存在 + 模型版本兼容（模型版本变化后旧记录不可用）。 */
export function queryActionAvailability(lib: ActionsLibQuery, actionName: string, modelHash: string): { available: boolean; reason?: string } {
  const record = lib.findAction(actionName);
  if (!record) return { available: false, reason: `动作 ${actionName} 未入库` };
  if (!lib.isCompatible(record, modelHash)) return { available: false, reason: `动作 ${actionName} 与当前模型版本（${modelHash.slice(0, 8)}）不兼容` };
  return { available: true };
}

/** 计划执行后的回写入口（Runtime 侧在终态回调里调用；本 PR 不接线执行）。 */
export function reportPlanOutcome(lib: ActionsLibQuery, plan: MotionPlan, phase: 'end' | 'interrupted' | 'failed'): void {
  for (const step of plan.actions) {
    if (step.type === 'motion3') {
      const record = lib.findAction(step.payload.name || '');
      if (record) lib.recordOutcome(record.actionId, phase);
    }
  }
  void planSeqGuard;
}
const planSeqGuard: unique symbol = Symbol('planner-actions-lib');
export type { PlannerIntent };
