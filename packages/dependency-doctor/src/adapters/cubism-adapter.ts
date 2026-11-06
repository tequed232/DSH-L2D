/**
 * Cubism SDK / Web Runtime 适配器（sdk + runtime 类）。
 * 只读检测：vendor/live2dcubismcore.min.js 存在性与版本标记提取。
 * SDK 分发受 Live2D 官方许可约束——缺失时只给官方下载引导，不自动安装。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DependencyFinding, ScanContext } from '../types/dependency.ts';
import { extractCoreVersion } from '../core/compatibility-checker.ts';
import { satisfies } from '../core/version-resolver.ts';

export const CORE_RELATIVE_PATH = 'vendor/live2dcubismcore.min.js';

export function checkCubismRuntime(ctx: ScanContext): DependencyFinding {
  const corePath = join(ctx.rootDir, CORE_RELATIVE_PATH);
  if (!existsSync(corePath)) {
    return {
      status: 'missing',
      detail: `未找到 ${CORE_RELATIVE_PATH}（Cubism Web Core 运行时；官方许可下载后放置）`,
    };
  }
  let text = '';
  try {
    text = readFileSync(corePath, 'utf8');
  } catch {
    return { status: 'unverified', detectedPath: corePath, detail: 'Core 文件存在但无法读取内容' };
  }
  const version = extractCoreVersion(text);
  if (!version) {
    return {
      status: 'unverified',
      detectedPath: corePath,
      detail: 'Core 存在但未能从文件内容确认版本（不臆测）',
    };
  }
  const ok = satisfies('>=5.0', version);
  return {
    status: ok ? 'installed' : 'incompatible',
    detectedVersion: version,
    detectedPath: corePath,
    detail: ok ? undefined : `Core 版本 ${version} 低于基线 5.0`,
  };
}

export function checkCubismSdk(ctx: ScanContext): DependencyFinding {
  // SDK 与 Core 同源（Web SDK 分发即含 Core）。Core 就绪 = SDK 就绪；
  // Core 缺失时 SDK 标 missing + 官方下载引导（许可未确认不自动装）。
  const core = checkCubismRuntime(ctx);
  if (core.status === 'installed') {
    return { status: 'installed', detectedVersion: core.detectedVersion, detectedPath: core.detectedPath };
  }
  if (core.status === 'incompatible') {
    return { ...core, detail: (core.detail || '') + '（请从官方来源更新 SDK）' };
  }
  return { ...core, detail: (core.detail || '') + '；下载与使用须遵循 Live2D 官方许可' };
}
