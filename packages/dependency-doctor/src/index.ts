/**
 * Dependency Doctor 对外 API（PR-E）。
 *
 *   const doctor = createDependencyDoctor({ rootDir, modelDir? });
 *   const reports = await doctor.scan();          // 只检测
 *   const plan = await doctor.planRepair(reports); // 只产计划
 *   await doctor.executeRepair(plan, auth);        // 须用户授权，仅白名单操作
 *   const readiness = doctor.assertRuntimeReady(reports); // 未就绪 → BLOCKED + 原因
 *
 * 诊断与安装严格分离；授权由调用方（宿主 / Setup Wizard UI）收集后显式传入。
 */
import type {
  DependencyReport,
  InstallPlan,
  RepairAuthorization,
  RepairResult,
  RuntimeReadiness,
  ScanContext,
} from './types/dependency.ts';
import { scanAll } from './core/diagnostic-engine.ts';
import { planRepair, assertAuthorized } from './installer/install-planner.ts';
import { runInstall } from './installer/package-installer.ts';

export interface DependencyDoctorOptions {
  rootDir: string;
  modelDir?: string;
  fetchImpl?: typeof fetch;
}

export interface DependencyDoctor {
  scan(): Promise<DependencyReport[]>;
  planRepair(reports: DependencyReport[]): Promise<InstallPlan>;
  /** 执行修复计划：authorization 缺失/granted!==true 一律拒绝。 */
  executeRepair(plan: InstallPlan, authorization: RepairAuthorization): Promise<RepairResult[]>;
  verify(): Promise<DependencyReport[]>;
  assertRuntimeReady(reports: DependencyReport[]): RuntimeReadiness;
}

export function createDependencyDoctor(options: DependencyDoctorOptions): DependencyDoctor {
  const ctx: ScanContext = { rootDir: options.rootDir, modelDir: options.modelDir };
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  async function scan(): Promise<DependencyReport[]> {
    return scanAll(ctx);
  }

  async function planRepairFor(reports: DependencyReport[]): Promise<InstallPlan> {
    return planRepair(reports);
  }

  async function executeRepair(plan: InstallPlan, authorization: RepairAuthorization): Promise<RepairResult[]> {
    const results: RepairResult[] = [];
    for (const step of plan.steps) {
      if (!authorization.stepIds.includes(step.id)) continue; // 未授权的 step 跳过
      try {
        assertAuthorized(plan, authorization, step.id); // 双重闸：plan 内存在 + 授权匹配
        if (step.kind === 'npm-install') {
          const mode = step.packageSpec ? 'add' : 'install';
          const r = await runInstall({ mode, packageSpec: step.packageSpec, cwd: ctx.rootDir });
          results.push({ stepId: step.id, ok: r.ok, error: r.ok ? undefined : `退出码 ${r.code}：${r.output.slice(-400)}` });
        } else {
          // download / 其他：PR-E 核心版不落地自动下载（SDK 许可前置），留待宿主层扩展
          results.push({ stepId: step.id, ok: false, error: `step 类型 ${step.kind} 需宿主层扩展执行` });
        }
      } catch (e) {
        results.push({ stepId: step.id, ok: false, error: String(e) });
      }
    }
    return results;
  }

  async function verify(): Promise<DependencyReport[]> {
    return scan(); // 复检 = 重新 scan（幂等）
  }

  function assertRuntimeReady(reports: DependencyReport[]): RuntimeReadiness {
    const blocked: RuntimeReadiness['blocked'] = [];
    for (const r of reports) {
      if (!r.required) continue;
      if (r.status === 'installed') continue;
      blocked.push({
        id: r.id,
        name: r.name,
        status: r.status,
        reason: r.detail || `状态 ${r.status}，要求 ${r.requiredVersion}`,
      });
    }
    return { ready: blocked.length === 0, blocked };
  }

  return { scan, planRepair: planRepairFor, executeRepair, verify, assertRuntimeReady };
}

export * from './types/dependency.ts';
export { scanAll, scanOne } from './core/diagnostic-engine.ts';
export { planRepair, assertAuthorized } from './installer/install-planner.ts';
export { verifyFileIntegrity, sha256File } from './installer/integrity-verifier.ts';
export { isOfficialSource } from './installer/download-manager.ts';
export { buildCommand } from './installer/package-installer.ts';
export { satisfies, parseVersion } from './core/version-resolver.ts';
export { checkSdkModelCompat, requiredSdkMajor, readMoc3Version, extractCoreVersion } from './core/compatibility-checker.ts';
export { collectReferencedFiles, listModel3Json } from './adapters/model-adapter.ts';
