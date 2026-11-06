/**
 * 诊断引擎：scan 编排。scan() 只检测不修改环境（设计铁律）。
 * 顺序：SDK/Runtime 先行（model 的兼容性交叉判定依赖 SDK 版本）。
 */
import type { DependencyCheck, DependencyReport, ScanContext } from '../types/dependency.ts';
import { buildChecks } from './dependency-registry.ts';

/** 扫描顺序：SDK → Runtime → Model（兼容性交叉判定）→ Node → pnpm → GPU */
const ORDER = ['cubism-sdk', 'cubism-runtime', 'live2d-model', 'nodejs', 'nodejs-deps', 'gpu-runtime'];

export async function scanAll(ctx: ScanContext, checks?: DependencyCheck[]): Promise<DependencyReport[]> {
  const list = checks || buildChecks();
  const byId = new Map(list.map((c) => [c.id, c]));
  const reports = new Map<string, DependencyReport>();
  const out: DependencyReport[] = [];
  for (const id of ORDER) {
    const check = byId.get(id);
    if (!check) continue;
    let finding;
    try {
      finding = await check.check({ ...ctx, reports });
    } catch (e) {
      finding = { status: 'unverified', detail: `检测器异常：${String(e)}` };
    }
    const report: DependencyReport = {
      id: check.id,
      name: check.name,
      category: check.category,
      requiredVersion: check.requiredVersion,
      detectedVersion: finding.detectedVersion,
      detectedPath: finding.detectedPath,
      status: finding.status,
      required: check.required,
      officialSource: check.officialSource,
      licenseRequired: check.licenseRequired,
      detail: finding.detail,
      missingFiles: finding.missingFiles,
      repairSupported: false,
      checkedAt: new Date().toISOString(),
    };
    reports.set(check.id, report);
    out.push(report);
  }
  // registry 有而 ORDER 漏掉的项（防呆）追加到尾部
  for (const check of list) {
    if (!ORDER.includes(check.id)) {
      out.push(await scanOne(check, ctx, reports));
    }
  }
  return out;
}

export async function scanOne(
  check: DependencyCheck,
  ctx: ScanContext,
  reports?: Map<string, DependencyReport>,
): Promise<DependencyReport> {
  let finding;
  try {
    finding = await check.check({ ...ctx, reports });
  } catch (e) {
    finding = { status: 'unverified', detail: `检测器异常：${String(e)}` };
  }
  return {
    id: check.id,
    name: check.name,
    category: check.category,
    requiredVersion: check.requiredVersion,
    detectedVersion: finding.detectedVersion,
    detectedPath: finding.detectedPath,
    status: finding.status,
    required: check.required,
    officialSource: check.officialSource,
    licenseRequired: check.licenseRequired,
    detail: finding.detail,
    missingFiles: finding.missingFiles,
    repairSupported: false,
    checkedAt: new Date().toISOString(),
  };
}
