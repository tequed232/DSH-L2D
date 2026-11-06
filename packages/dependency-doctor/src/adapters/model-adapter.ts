/**
 * Live2D 模型资源适配器（model 类）。
 *
 * 关键语义：.model3.json 存在不代表模型完整——必须解析 FileReferences，
 * 逐一校验 moc3 / 纹理 / physics3 / pose / motion3 / expression 文件存在性，
 * 缺失时指出具体文件路径。模型属用户资源：不覆盖、不假定统一分发。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { DependencyFinding, ScanContext } from '../types/dependency.ts';
import { readMoc3Version, checkSdkModelCompat } from '../core/compatibility-checker.ts';

export interface Model3Json {
  FileReferences?: {
    Moc?: string;
    Textures?: string[];
    Physics?: string;
    Pose?: string;
    DisplayInfo?: string;
    Motions?: Record<string, Array<{ File?: string; Sound?: string }>>;
    Expressions?: Array<{ File?: string; Name?: string }>;
  };
}

/** 列出 modelDir 下的 model3.json（单层目录；模型引用文件可能在其子目录，存在性按相对路径校验）。 */
export function listModel3Json(modelDir: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(modelDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (name.toLowerCase().endsWith('.model3.json')) {
      const full = join(modelDir, name);
      try {
        if (existsSync(full)) out.push(full);
      } catch {
        /* ignore */
      }
    }
  }
  return out.sort();
}

/** 解析 model3.json 引用清单 → 相对模型目录的文件路径全集。 */
export function collectReferencedFiles(model3Path: string, json: Model3Json): string[] {
  const refs = json.FileReferences || {};
  const files: string[] = [];
  if (refs.Moc) files.push(refs.Moc);
  for (const t of refs.Textures || []) files.push(t);
  if (refs.Physics) files.push(refs.Physics);
  if (refs.Pose) files.push(refs.Pose);
  if (refs.DisplayInfo) files.push(refs.DisplayInfo);
  for (const group of Object.values(refs.Motions || {})) {
    for (const m of group || []) {
      if (m.File) files.push(m.File);
      if (m.Sound) files.push(m.Sound);
    }
  }
  for (const e of refs.Expressions || []) if (e.File) files.push(e.File);
  return files;
}

export function checkModel(ctx: ScanContext): DependencyFinding {
  const dir = ctx.modelDir || join(ctx.rootDir, 'DeepSeek免费公皮', 'DeepSeek');
  const candidates = listModel3Json(dir);
  if (!candidates.length) {
    return {
      status: 'missing',
      detectedPath: dir,
      detail: `模型目录 ${dir} 下未找到 .model3.json（请导入模型或选择模型目录）`,
    };
  }
  const model3Path = candidates[0];
  let json: Model3Json;
  try {
    json = JSON.parse(readFileSync(model3Path, 'utf8'));
  } catch (e) {
    return { status: 'incompatible', detectedPath: model3Path, detail: `model3.json 解析失败：${String(e)}` };
  }
  const modelDirAbs = dirname(model3Path);
  const referenced = collectReferencedFiles(model3Path, json);
  const missingFiles: string[] = [];
  for (const rel of referenced) {
    if (!rel) continue;
    if (!existsSync(join(modelDirAbs, rel))) missingFiles.push(rel);
  }
  // moc3 版本字节 → SDK 兼容性交叉判定（SDK 报告先于 model 检测时）
  let moc3Version: number | null = null;
  const mocRel = json.FileReferences?.Moc;
  if (mocRel) {
    try {
      moc3Version = readMoc3Version(readFileSync(join(modelDirAbs, mocRel)));
    } catch {
      moc3Version = null;
    }
  }
  const sdkReport = ctx.reports?.get('cubism-sdk');
  if (sdkReport?.detectedVersion && moc3Version != null) {
    const sdkMajor = parseInt(sdkReport.detectedVersion, 10);
    const verdict = checkSdkModelCompat(sdkMajor, { moc3Version });
    if (!verdict.compatible) {
      return {
        status: 'incompatible',
        detectedPath: model3Path,
        detail: verdict.reason,
        missingFiles: missingFiles.length ? missingFiles : undefined,
      };
    }
  }
  if (missingFiles.length) {
    return {
      status: 'incompatible',
      detectedPath: model3Path,
      detail: `model3.json 引用的 ${missingFiles.length} 个资源文件缺失（模型不完整）`,
      missingFiles,
    };
  }
  return {
    status: 'installed',
    detectedPath: model3Path,
    detail: `模型完整：${referenced.length} 个引用文件全部存在${moc3Version != null ? `（moc3 v${moc3Version}）` : ''}`,
  };
}
