/**
 * Cubism / 模型格式兼容性矩阵（PR-E）。
 *
 * 关键约束：SDK 版本、运行时版本与模型格式必须兼容。
 * moc3 版本字节（文件第 13 字节附近）→ 支持的最低 Cubism SDK 大版本：
 *   1..2 → SDK 3.x；3 → SDK 4.0；4 → SDK 4.2；5 → SDK 5.0；6+ → SDK 5.1/6.x。
 * 这是 Live2D 官方 moc3 格式演进；不兼容组合显式标 incompatible。
 */

export interface ModelFormatInfo {
  /** moc3 文件头版本字节（0-255；读取失败为 null） */
  moc3Version: number | null;
}

export interface CompatVerdict {
  compatible: boolean;
  reason?: string;
  /** 建议的最低 SDK 大版本 */
  minSdkMajor?: number;
}

export function moc3MinSdkMajor(versionByte: number | null): number | null {
  return requiredSdkMajor(versionByte);
}

/** moc3 版本 → 最低 Cubism Web SDK（Core）大版本（保守官方口径）。 */
export function requiredSdkMajor(moc3Version: number | null): number | null {
  if (moc3Version == null) return null;
  if (moc3Version <= 2) return 3;
  if (moc3Version === 3) return 4;
  if (moc3Version === 4) return 4; // moc3 v4 由 Cubism 4.2 引入
  if (moc3Version === 5) return 5;
  return 6;
}

export function checkSdkModelCompat(sdkMajor: number | null, model: ModelFormatInfo): CompatVerdict {
  if (sdkMajor == null) {
    return { compatible: false, reason: 'SDK 版本未知，无法判定兼容性' };
  }
  const need = requiredSdkMajor(model.moc3Version);
  if (need == null) {
    // 模型版本读不出：不臆测，交由 unverified 主流程
    return { compatible: true, reason: 'moc3 版本字节未读取到，兼容性待运行时确认' };
  }
  if (sdkMajor >= need) return { compatible: true, minSdkMajor: need };
  return {
    compatible: false,
    reason: `模型 moc3 v${model.moc3Version} 需要 Cubism SDK >= ${need}，当前 SDK 为 ${sdkMajor}.x`,
    minSdkMajor: need,
  };
}

/** 从 Cubism Core bundle 文本提取版本（官方文件头含 "Cubism X.Y" 或 version 常量）。 */
export function extractCoreVersion(coreSourceText: string): string | null {
  const patterns = [
    /Cubism\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)/,
    /version["'\s:=]+([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i,
  ];
  for (const re of patterns) {
    const m = coreSourceText.match(re);
    if (m) return m[1];
  }
  return null;
}

/** moc3 头部版本字节读取（第 12 字节为版本，官方格式）。只读 16 字节，不加载模型。 */
export function readMoc3Version(buf: Uint8Array): number | null {
  if (!buf || buf.length < 13) return null;
  // 头四字节 "MOC3"，随后 8 字节其他字段，第 12 字节为版本
  const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  if (magic !== 'MOC3') return null;
  return buf[12];
}
