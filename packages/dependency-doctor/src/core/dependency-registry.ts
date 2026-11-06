/**
 * 依赖注册表：加载 registry/dependencies.json，装配检测适配器。
 * 单一事实来源：检测项、版本要求、官方来源、许可要求都从这里出。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DependencyCheck, DependencyCategory } from '../types/dependency.ts';
import { checkNode, checkPnpm } from '../adapters/node-adapter.ts';
import { checkCubismSdk, checkCubismRuntime } from '../adapters/cubism-adapter.ts';
import { checkModel } from '../adapters/model-adapter.ts';
import { checkGpu } from '../adapters/gpu-adapter.ts';

interface RegistryEntry {
  id: string;
  name: string;
  category: DependencyCategory;
  requiredVersion: string;
  required: boolean;
  officialSource?: string;
  licenseRequired?: boolean;
  repairSupported?: boolean;
  notes?: string;
}

const REGISTRY_PATH = fileURLToPath(new URL('../registry/dependencies.json', import.meta.url));

/** id → 检测函数装配表（与 registry 条目一一对应，缺装配即报错）。 */
const CHECKERS: Record<string, (ctx: any) => any> = {
  'cubism-sdk': checkCubismSdk,
  'cubism-runtime': checkCubismRuntime,
  'live2d-model': checkModel,
  nodejs: checkNode,
  'nodejs-deps': checkPnpm,
  'gpu-runtime': checkGpu,
};

export function loadRegistry(): RegistryEntry[] {
  const raw = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  const list: RegistryEntry[] = raw.dependencies;
  for (const entry of list) {
    if (!CHECKERS[entry.id]) {
      throw new Error(`registry 条目 ${entry.id} 缺少检测适配器装配`);
    }
  }
  return list;
}

export function buildChecks(): DependencyCheck[] {
  return loadRegistry().map((entry) => ({
    id: entry.id,
    name: entry.name,
    category: entry.category,
    requiredVersion: entry.requiredVersion,
    required: entry.required,
    officialSource: entry.officialSource,
    licenseRequired: entry.licenseRequired,
    check: (ctx: any) => CHECKERS[entry.id](ctx),
  }));
}

export function registryEntry(id: string): RegistryEntry | null {
  return loadRegistry().find((e) => e.id === id) || null;
}
