/**
 * P2 · 纹理清单与 GPU 资源预算计算器（纯函数，零依赖）。
 *
 * 输入模型资源清单（model3.json 引用的纹理尺寸、像素格式、mipmap、引用计数），
 * 输出每纹理估算字节、合计预算与纹理档位建议（2048/1024/512）。
 *
 * 估算公式：宽 × 高 × 像素格式字节数 × (mipmap ? 1.33 : 1)。
 * 参考值：RGBA8 2048² + mipmap ≈ 5.6MB/张，5 张 ≈ 28MB ≤ 32MB → 1024 档可行。
 *
 * 注意：引用计数只用于清单对账（LAppTextureManager 按文件名缓存，
 * 同路径重复引用在 GPU 上只有一份），不参与字节数估算。
 *
 * 本阶段只做预算计算与档位决策（产报告）；运行时降采样是后续批次，
 * 默认不改加载行为。
 */

/** 纹理档位：纹理最长边不超过该值 */
export type TextureTier = 2048 | 1024 | 512;

export const TEXTURE_TIERS: TextureTier[] = [2048, 1024, 512];

/** 默认低配预算：32MB（RGBA8 1024² × 5 张 + mipmap ≈ 28MB 留有余量） */
export const DEFAULT_BUDGET_BYTES = 32 * 1024 * 1024;

/** mipmap 链额外显存系数（完整链 ≈ 1/3 额外，保守取 1.33） */
export const MIPMAP_FACTOR = 1.33;

/** 像素格式 → 每像素字节数。默认 rgba8（Cubism 渲染路径的标准上传格式） */
export const PIXEL_FORMAT_BYTES: Record<string, number> = {
  rgba8: 4,
  bgra8: 4,
  rgb8: 3,
  rgba4: 2,
  la8: 2,
  l8: 1,
};

/** 像素格式未知时的兜底（按最贵常用格式算，避免低估） */
export const DEFAULT_PIXEL_FORMAT = 'rgba8';

/** 单张纹理清单条目（调用方从 model3.json / cdi3 解析或实测喂入） */
export interface TextureInventoryItem {
  /** 纹理路径或标识（相对 model3.json） */
  id: string;
  /** 实际像素宽（PNG 头实测，不取文件体积） */
  width: number;
  height: number;
  /** 像素格式，默认 rgba8 */
  pixelFormat?: string;
  /** 是否生成 mipmap（当前渲染路径 texImage2D 后固定 generateMipmap） */
  mipmap?: boolean;
  /** 被 model3.json / cdi3 引用的次数；去重后的唯一纹理 GPU 只驻留一份 */
  refCount?: number;
  /** 磁盘文件字节数（可选，仅报告用，不参与显存估算） */
  fileBytes?: number;
}

/** 档位选项：'auto' 按预算自动选档，或用户显式覆盖 */
export type TextureTierOption = TextureTier | 'auto';

export interface TextureBudgetOptions {
  /** 显存预算字节数，默认 32MB */
  budgetBytes?: number;
  /** 档位：'auto'（默认）或用户覆盖的固定档 */
  tier?: TextureTierOption;
}

/** 单张纹理在某档位下的估算 */
export interface TextureEstimate {
  id: string;
  /** 原始宽高 */
  width: number;
  height: number;
  /** 该档位下的目标宽高（可能等于原始尺寸） */
  tierWidth: number;
  tierHeight: number;
  pixelFormat: string;
  mipmap: boolean;
  refCount: number;
  /** 估算显存字节数（该档位） */
  bytes: number;
  /** 磁盘文件字节数（可选透传） */
  fileBytes?: number;
}

/** 预算报告 */
export interface TextureBudgetReport {
  /** 建议档位；'auto' 且所有档位都超预算时仍给出 512 并标记不可行 */
  tier: TextureTier;
  /** 该档位合计是否在预算内 */
  tierFeasible: boolean;
  /** 是否应用了用户档位覆盖 */
  overrideApplied: boolean;
  /** 原始尺寸（不降档）合计估算字节 */
  originalBytes: number;
  /** 建议档位合计估算字节 */
  totalBytes: number;
  /** 预算字节数 */
  budgetBytes: number;
  /** 每纹理明细（按建议档位估算，含原始宽高） */
  perTexture: TextureEstimate[];
  /** 警告：原始超预算、档位超预算（模型超出低配预算）等 */
  warnings: string[];
}

/** 校验并补全单张纹理输入；非法尺寸返回 null（调用方决定是否跳过/告警） */
function normalizeItem(item: TextureInventoryItem): {
  id: string;
  width: number;
  height: number;
  pixelFormat: string;
  mipmap: boolean;
  refCount: number;
  fileBytes?: number;
} | null {
  const w = Math.floor(Number(item?.width));
  const h = Math.floor(Number(item?.height));
  if (!item?.id || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return null;
  }
  const fmt = typeof item.pixelFormat === 'string' && PIXEL_FORMAT_BYTES[item.pixelFormat]
    ? item.pixelFormat
    : DEFAULT_PIXEL_FORMAT;
  return {
    id: item.id,
    width: w,
    height: h,
    pixelFormat: fmt,
    mipmap: item.mipmap !== false,
    refCount: Math.max(1, Math.floor(Number(item.refCount) || 1)),
    ...(item.fileBytes !== undefined ? { fileBytes: Math.max(0, Number(item.fileBytes) || 0) } : {}),
  };
}

/** 单张纹理在给定宽高下的估算字节（宽×高×像素格式×mipmap 系数） */
export function estimateTextureBytesAtSize(
  width: number,
  height: number,
  pixelFormat: string,
  mipmap: boolean,
): number {
  const bpp = PIXEL_FORMAT_BYTES[pixelFormat] ?? PIXEL_FORMAT_BYTES[DEFAULT_PIXEL_FORMAT];
  const base = width * height * bpp;
  return Math.round(mipmap ? base * MIPMAP_FACTOR : base);
}

/** 单张纹理按原始尺寸的估算字节 */
export function estimateTextureBytes(item: TextureInventoryItem): number {
  const n = normalizeItem(item);
  if (!n) return 0;
  return estimateTextureBytesAtSize(n.width, n.height, n.pixelFormat, n.mipmap);
}

/** 档位缩放：最长边钳到 tier，等比缩，不下采样放大（scale ≤ 1） */
export function scaledSizeForTier(width: number, height: number, tier: TextureTier): {
  tierWidth: number;
  tierHeight: number;
} {
  const longest = Math.max(width, height);
  if (longest <= tier) return { tierWidth: width, tierHeight: height };
  const scale = tier / longest;
  return {
    tierWidth: Math.max(1, Math.floor(width * scale)),
    tierHeight: Math.max(1, Math.floor(height * scale)),
  };
}

/**
 * 计算纹理预算与档位建议。
 *
 * - tier='auto'：从 2048 → 512 依次降档，取第一个合计 ≤ budgetBytes 的档位；
 *   全部超预算时给出 512 + 不可行 + 「模型超出低配预算」警告。
 * - tier 为具体值：用户覆盖，直接按该档估算（是否可行照实标记）。
 * - 原始尺寸合计超预算时追加警告（无论档位是否可行）。
 */
export function computeTextureBudget(
  items: TextureInventoryItem[],
  options: TextureBudgetOptions = {},
): TextureBudgetReport {
  const budgetBytes = Math.max(
    1,
    Math.floor(Number(options.budgetBytes) || DEFAULT_BUDGET_BYTES),
  );

  const norm = (items || []).map(normalizeItem).filter((n): n is NonNullable<typeof n> => n !== null);
  const warnings: string[] = [];
  if (norm.length < (items || []).length) {
    warnings.push(`跳过 ${(items || []).length - norm.length} 条无效纹理条目（缺 id 或尺寸非法）`);
  }

  const originalBytes = norm.reduce(
    (sum, n) => sum + estimateTextureBytesAtSize(n.width, n.height, n.pixelFormat, n.mipmap),
    0,
  );
  if (originalBytes > budgetBytes) {
    warnings.push(
      `原始纹理合计约 ${formatMB(originalBytes)}，超出低配预算 ${formatMB(budgetBytes)}`,
    );
  }

  const estimateAt = (tier: TextureTier): { total: number; per: TextureEstimate[] } => {
    let total = 0;
    const per: TextureEstimate[] = norm.map((n) => {
      const { tierWidth, tierHeight } = scaledSizeForTier(n.width, n.height, tier);
      const bytes = estimateTextureBytesAtSize(tierWidth, tierHeight, n.pixelFormat, n.mipmap);
      total += bytes;
      return {
        id: n.id,
        width: n.width,
        height: n.height,
        tierWidth,
        tierHeight,
        pixelFormat: n.pixelFormat,
        mipmap: n.mipmap,
        refCount: n.refCount,
        bytes,
        ...(n.fileBytes !== undefined ? { fileBytes: n.fileBytes } : {}),
      };
    });
    return { total, per };
  };

  let tier: TextureTier;
  let overrideApplied = false;

  if (options.tier && options.tier !== 'auto') {
    tier = options.tier;
    overrideApplied = true;
  } else {
    // 自动选档：从高到低取第一个进预算的档位；都不行给 512（不可行）
    tier = TEXTURE_TIERS[TEXTURE_TIERS.length - 1];
    for (const t of TEXTURE_TIERS) {
      if (estimateAt(t).total <= budgetBytes) {
        tier = t;
        break;
      }
    }
  }

  const { total, per } = estimateAt(tier);
  const tierFeasible = total <= budgetBytes;
  if (!tierFeasible) {
    warnings.push(
      `模型超出低配预算：${tier} 档合计约 ${formatMB(total)}，仍超 ${formatMB(budgetBytes)} 预算`,
    );
  }
  if (overrideApplied && !tierFeasible) {
    warnings.push(`用户指定档位 ${tier} 超出预算（覆盖仍然生效，照实标记不可行）`);
  }

  return {
    tier,
    tierFeasible,
    overrideApplied,
    originalBytes,
    totalBytes: total,
    budgetBytes,
    perTexture: per,
    warnings,
  };
}

function formatMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}
