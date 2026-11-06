/**
 * 安全分配决策（G2，纯函数，无副作用，fail-closed）。
 *
 * 判定链（全部通过才 allow）：
 *   1. manifest.verified（该肢体能力有真实证据）
 *   2. 参数全部在肢体白名单内（未知参数 fail-closed）
 *   3. 装饰域拒绝（头发/裙摆/配饰永不接管——用户硬约束）
 *   4. 共享枢纽拒绝（S1-S5）
 *   5. 左右肢体约束（不得错误切换）
 *   6. 拓扑零下游（physicsConflict 拒绝）
 * 允许时的相位契约：手臂叶子域 = post（G0 §4.1 路径 B）。
 */
import { isDecorationParameter, isSharedHub, leftRightMismatch } from './analyzer.ts';
import type { CapabilityManifest, LimbAllocationRequest, OwnershipDecision } from './types.ts';

export function decideLimbAllocation(manifest: CapabilityManifest, request: LimbAllocationRequest): OwnershipDecision {
  const rejected: OwnershipDecision['rejected'] = [];
  const reject = (reason: string): OwnershipDecision => ({ decision: 'reject', reason, rejected });

  const limbCap = manifest.limbs.find((l) => l.limb === request.limb);
  if (!limbCap) return reject(`未知肢体：${request.limb}`);
  if (!limbCap.verified) {
    return reject(`肢体 ${request.limb} 能力未验证（fail-closed）：${limbCap.reason || '无证据'}`);
  }

  if (!request.parameters.length) return reject('空参数请求');

  const lrMismatch = leftRightMismatch(request.limb, request.parameters);
  if (lrMismatch) {
    for (const id of request.parameters) rejected.push({ parameterId: id, cause: lrMismatch });
    return reject(lrMismatch);
  }

  for (const id of request.parameters) {
    if (isSharedHub(id)) rejected.push({ parameterId: id, cause: 'shared-hub: 共享枢纽域不可独占（G0 S1-S5）' });
    else if (isDecorationParameter(id)) rejected.push({ parameterId: id, cause: 'decoration: 装饰域永不进 Agent 白名单' });
    else if (!limbCap.parameters.includes(id)) rejected.push({ parameterId: id, cause: 'unknown-param: 不在该肢体白名单（未知参数 fail-closed）' });
    else if (manifest.physics.outputs[id]?.sharedHub) rejected.push({ parameterId: id, cause: 'manifest 判定共享枢纽' });
    else if ((manifest.physics.outputs[id]?.downstreamCount ?? -1) > 0) rejected.push({ parameterId: id, cause: 'topology: 输出存在下游消费者' });
  }
  if (rejected.length) {
    return reject(`${rejected.length} 个参数未通过安全校验（fail-closed）`);
  }
  return { decision: 'allow', reason: '全部参数通过白名单/拓扑/装饰/共享域校验', rejected: [], phase: 'post' };
}

/** Capability Manifest 缓存：modelHash 不匹配即失效重建（模型版本变化 → 缓存正确失效）。 */
export class CapabilityManifestCache {
  private cache: CapabilityManifest | null = null;
  private build: (modelId: string, modelHash: string) => CapabilityManifest;

  constructor(build: (modelId: string, modelHash: string) => CapabilityManifest) {
    this.build = build;
  }

  get(modelId: string, modelHash: string): CapabilityManifest {
    if (this.cache && this.cache.modelId === modelId && this.cache.modelHash === modelHash) {
      return this.cache;
    }
    this.cache = this.build(modelId, modelHash); // hash 变化 → 旧缓存作废
    return this.cache;
  }

  invalidate(): void {
    this.cache = null;
  }
}
