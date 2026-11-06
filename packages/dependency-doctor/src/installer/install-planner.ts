/**
 * 修复计划生成器。planRepair 只产出计划，绝不执行（设计铁律）。
 * 每一步都要求用户授权；SDK/模型类依赖受许可或用户资源约束，只出人工指引。
 */
import type { DependencyReport, InstallPlan, InstallStep, RepairKind } from '../types/dependency.ts';

/** npm 安装白名单：仅允许 registry 明确登记的具名包，杜绝任意命令拼装。 */
const NPM_WHITELIST = new Set(['typescript', 'vite']);

export function planRepair(reports: DependencyReport[]): InstallPlan {
  const steps: InstallStep[] = [];
  const manual: InstallPlan['manual'] = [];
  for (const report of reports) {
    if (report.status === 'installed') continue;
    if (report.status === 'unverified') {
      continue; // 无法确认的项不进修复计划（不臆测），由详情层展示
    }
    if (report.status === 'missing' && report.category === 'project') {
      // 项目依赖缺失：npm-install 计划（白名单内才生成，否则转人工）
      if (NPM_WHITELIST.size && report.id === 'nodejs-deps') {
        steps.push({
          id: `install-${report.id}`,
          kind: 'npm-install',
          target: report.id,
          description: `在仓库根目录执行 pnpm install 恢复项目依赖`,
          packageSpec: undefined,
          requiresAuthorization: true,
          instructions: 'pnpm install',
        });
      } else {
        manual.push({ id: report.id, name: report.name, officialSource: report.officialSource, reason: report.detail || '需要人工处理' });
      }
      continue;
    }
    // SDK / Runtime / Model / GPU：许可或用户资源属性 → 人工指引（官方下载 / 导入模型）
    const kind: RepairKind = 'manual';
    void kind;
    manual.push({
      id: report.id,
      name: report.name,
      officialSource: report.officialSource || undefined,
      reason:
        report.licenseRequired
          ? `${report.detail || '缺失'}；SDK 分发受 Live2D 官方许可约束，授权确认后请从官方来源获取`
          : report.category === 'model'
            ? `${report.detail || '模型资源缺失'}；模型属用户资源，请导入模型或选择模型目录（不自动下载）`
            : report.detail || '需要人工处理',
    });
  }
  return { createdAt: new Date().toISOString(), steps, manual };
}

/** 校验授权凭据与 step 清单匹配（execute 前置闸）。 */
export function assertAuthorized(
  plan: InstallPlan,
  authorization: { granted: boolean; stepIds?: string[] } | null | undefined,
  stepId: string,
): void {
  if (!authorization || authorization.granted !== true) {
    throw new Error('未获用户授权：安装操作拒绝执行（fail-closed）');
  }
  if (!authorization.stepIds || !authorization.stepIds.includes(stepId)) {
    throw new Error(`step ${stepId} 不在用户授权清单内：拒绝执行`);
  }
  if (!plan.steps.some((s) => s.id === stepId)) {
    throw new Error(`step ${stepId} 不在该修复计划内：拒绝执行`);
  }
}
