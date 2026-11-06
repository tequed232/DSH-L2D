/**
 * Node.js / 包管理器适配器（project 类）。
 * 只读检测：process 版本、pnpm 可用性。不执行安装。
 */
import { statSync } from 'node:fs';
import type { DependencyFinding, ScanContext } from '../types/dependency.ts';
import { satisfies } from '../core/version-resolver.ts';

export function checkNode(ctx: ScanContext): DependencyFinding {
  const detected = process.version.replace(/^v/, '');
  const ok = satisfies('>=22', detected);
  return {
    status: ok ? 'installed' : 'incompatible',
    detectedVersion: detected,
    detectedPath: process.execPath,
    detail: ok ? undefined : `需要 Node >= 22，当前 ${detected}`,
  };
}

export function checkPnpm(ctx: ScanContext): DependencyFinding {
  // pnpm 可用性以 node_modules/.pnpm 存在为旁证（安装由宿主引导，不在 scan 内执行）
  const dir = ctx.rootDir + '/node_modules/.pnpm';
  let ok = false;
  try {
    ok = statSync(dir).isDirectory();
  } catch {
    ok = false;
  }
  return {
    status: ok ? 'installed' : 'missing',
    detectedPath: ok ? dir : undefined,
    detail: ok ? undefined : '依赖尚未安装（pnpm install 未执行或失败）',
  };
}
