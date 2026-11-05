/**
 * Local Action Matcher（SUPERVISOR-P12 / P2）。
 *
 * 职责（裁决书 §3）：意图 → 本地确定性检索 → 加权打分 → 阈值判定 →
 * 命中只做权限/依赖校验（LLM 调用数=0），未命中且未开 Composer → unmatched，
 * 绝不偷偷兜底。本文件顶层**不 import 任何 Composer/LLM 模块**（负面测试
 * ret.negative.no-composer 的静态事实）；Composer 仅可经构造参数注入，且只在
 * composition.enabled===true 时被调用（P4 交付前无人注入，P2 天然零 LLM）。
 *
 * 候选身份（BOOTSTRAP-DECREE §0.3/§9.1 修正案）：**模型锚定**——候选自带
 * modelId，intent 必填 modelId；同分时当前模型优先（验收第 12 条）。
 *
 * 五维加权（裁决书 §3）：capability 35 / status 25 / emotion 20 / expression 10 /
 * 历史成功率 10。成功率经 createSuccessRateAdapter(db) **只读 execution_history**
 * （裁定 1：唯一事实源，单 adapter，Matcher 不碰表、不跨表 join；bridge_actions
 * 不合并，P6 如需并入只扩 adapter 喂同一聚合）。样本 <5 → 0.5 中性值
 * （不冒充模型置信度）。阈值 ≥0.85 采用 / 0.65-0.85 查兼容 / <0.65 未命中，
 * 均可配置（settings.localRetrieval.matchThreshold）。
 *
 * 情绪纪律：只认 review_state='approved' 标签（needs_review 永不参与检索，
 * 承接 61 条标签人工审计裁决）。
 */

export const DEFAULT_WEIGHTS = Object.freeze({
  capability: 0.35,
  status: 0.25,
  emotion: 0.20,
  expression: 0.10,
  successRate: 0.10,
});

export const DEFAULT_THRESHOLDS = Object.freeze({ adopt: 0.85, compat: 0.65 });

/** status 同族（半分）：两种 waiting 语义近邻；其余只认精确匹配。 */
const STATUS_FAMILIES = Object.freeze({
  waiting_input: 'waiting',
  waiting_subagent: 'waiting',
});

function familyOf(status) {
  return STATUS_FAMILIES[status] || null;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 单候选打分（纯函数）。intent: {modelId, capabilityId, status, emotion?, expression?}；
 * candidate: {modelId, actionId, motionId, chainId, capabilityId, statusTags[],
 *             emotions[{emotion, expression, reviewState}]}。
 * @returns {{score: number, parts: {capability,status,emotion,expression,successRate}}}
 */
export function scoreAction(intent, candidate, { weights = DEFAULT_WEIGHTS, successRate } = {}) {
  const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };

  const capability = intent.capabilityId && candidate.capabilityId && intent.capabilityId === candidate.capabilityId ? 1 : 0;

  let status = 0;
  const tags = Array.isArray(candidate.statusTags) ? candidate.statusTags : [];
  if (intent.status && tags.includes(intent.status)) status = 1;
  else if (intent.status && familyOf(intent.status) && tags.some((t) => familyOf(t) === familyOf(intent.status))) status = 0.5;

  const approved = Array.isArray(candidate.emotions) ? candidate.emotions.filter((e) => e && e.reviewState === 'approved') : [];
  const emotion = intent.emotion && approved.some((e) => e.emotion === intent.emotion) ? 1 : 0;
  const expression = intent.expression && approved.some((e) => e.expression === intent.expression) ? 1 : 0;

  const rate = typeof successRate === 'function' ? successRate(candidate) : 0.5;
  const successRateScore = Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 0.5;

  const parts = { capability, status, emotion, expression, successRate: successRateScore };
  const score = w.capability * capability + w.status * status + w.emotion * emotion + w.expression * expression + w.successRate * successRateScore;
  return { score: Math.round(score * 10000) / 10000, parts };
}

/**
 * execution_history 成功率 adapter（裁定 1：唯一事实源、只读、单入口）。
 * 样本 <5 → 0.5 中性；否则 completed / (completed+failed+timeout)。
 * P6 如需并入 bridge_actions，只在此扩第二数据源喂同一聚合。
 */
export function createSuccessRateAdapter(db, { minSamples = 5 } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('createSuccessRateAdapter: db 必填');
  const stmt = db.prepare(
    `SELECT status, COUNT(*) AS n FROM execution_history WHERE motion_id = ? GROUP BY status`
  );
  return (candidate) => {
    const motionId = candidate && candidate.motionId;
    if (!motionId) return 0.5;
    let completed = 0;
    let failed = 0;
    let samples = 0;
    for (const row of stmt.all(String(motionId))) {
      samples += row.n;
      if (row.status === 'completed') completed += row.n;
      else if (row.status === 'failed' || row.status === 'timeout') failed += row.n;
    }
    if (samples < minSamples) return 0.5;
    const denom = completed + failed;
    return denom > 0 ? completed / denom : 0.5;
  };
}

/** 排序比较：score desc → 当前模型优先（验收 12）→ 情绪标签优先（可配）→ actionId 稳定序。 */
function compareCandidates(a, b, { intentModelId, preferTagged }) {
  if (b.score !== a.score) return b.score - a.score;
  const aOwn = a.modelId === intentModelId ? 0 : 1;
  const bOwn = b.modelId === intentModelId ? 0 : 1;
  if (aOwn !== bOwn) return aOwn - bOwn;
  if (preferTagged) {
    const aTag = a.approvedCount > 0 ? 0 : 1;
    const bTag = b.approvedCount > 0 ? 0 : 1;
    if (aTag !== bTag) return aTag - bTag;
  }
  return String(a.actionId).localeCompare(String(b.actionId));
}

/**
 * 意图检索主入口。
 * @param {object} intent {modelId 必填, capabilityId, status, emotion?, expression?}
 * @param {Array} candidates 模型锚定候选（repo/上层注入；Matcher 不直查表）
 * @param {object} [options]
 * @param {{localRetrieval?: {enabled?: boolean, matchThreshold?: number, cacheEnabled?: boolean},
 *          composition?: {enabled?: boolean}}} [options.settings] 裁决书 §6 默认全开
 * @param {object} [options.registry] Capability Registry 门面 {status:'available'|...}（fail-closed）
 * @param {(rateContext) => number} [options.successRate] 成功率函数（createSuccessRateAdapter 产物）
 * @param {(intent) => Promise<object>|object} [options.composer] Composer 注入（P4 交付前无人注入）
 * @returns {Promise<object>}
 *   {status:'adopted', match, score, llmCalls:0} |
 *   {status:'compat', candidates, score} |
 *   {status:'unmatched', reason?, composerAvailable?} |
 *   {status:'disabled'} | {status:'composed', result}
 */
export async function matchIntent(intent, candidates, options = {}) {
  if (!isPlainObject(intent) || typeof intent.modelId !== 'string' || !intent.modelId) {
    throw new Error('matchIntent: intent.modelId 必填（BOOTSTRAP-DECREE 模型锚定身份）');
  }
  const settings = options.settings || {};
  const local = settings.localRetrieval || {};
  if (local.enabled === false) return { status: 'disabled', reason: 'localRetrieval-disabled' };

  // fail-closed：registry 不可用/损坏 → 一切能力断言拒绝放行
  const registry = options.registry;
  if (registry && registry.status !== 'available') {
    return { status: 'unmatched', reason: `registry-${registry.status || 'unavailable'}`, llmCalls: 0 };
  }

  const thresholds = {
    adopt: Number.isFinite(local.matchThreshold) ? local.matchThreshold : DEFAULT_THRESHOLDS.adopt,
    compat: DEFAULT_THRESHOLDS.compat,
  };

  // 缓存（P2：进程内结果缓存 + 命中率指标；SQLite 持久化留 P5，见报告 Known Issues）
  const cacheEnabled = local.cacheEnabled === true;
  const cache = cacheEnabled && options.cache && typeof options.cache.get === 'function' ? options.cache : null;
  const cacheKey = cache ? JSON.stringify([intent.modelId, intent.capabilityId, intent.status, intent.emotion, intent.expression]) : null;
  if (cache) {
    const hit = cache.get(cacheKey);
    if (hit) {
      options.cache.stats.hits += 1;
      return { ...hit, fromCache: true, llmCalls: 0 };
    }
    options.cache.stats.misses += 1;
  }

  const preferTagged = settings.emotionRouting?.preferTaggedActions === true;
  const scored = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => {
      const { score, parts } = scoreAction(intent, candidate, { successRate: options.successRate });
      const approvedCount = Array.isArray(candidate.emotions)
        ? candidate.emotions.filter((e) => e && e.reviewState === 'approved').length
        : 0;
      return { ...candidate, score, parts, approvedCount };
    })
    .sort((a, b) => compareCandidates(a, b, { intentModelId: intent.modelId, preferTagged }));

  const top = scored[0];
  let result;
  if (top && top.score >= thresholds.adopt) {
    result = {
      status: 'adopted',
      match: { modelId: top.modelId, actionId: top.actionId, motionId: top.motionId, chainId: top.chainId, capabilityId: top.capabilityId },
      score: top.score,
      parts: top.parts,
      llmCalls: 0, // 命中已有链：LLM 调用数=0（负面测试一）
    };
    // GALLERY-BRIDGE §4.2（22:30 裁定修订）：命中时取该情绪 score 排序 top-1，
    // 附图底线 score ≥ 30（top-N 相对排序，绝对阈值 60 废弃——实测分布 [0,51.4]
    // 结构性偏低，top-N 自适应分布漂移）。无 ≥30 的图不附，不空凑。
    // gallery 经注入（读文件/护栏在 gallery-source），未注入不附，行为与 P12 完全一致。
    const gallery = options.gallery;
    if (gallery && typeof gallery.top === 'function' && intent.emotion) {
      try {
        const [row] = await gallery.top(intent.emotion, 1);
        if (row && Number(row.score) >= 30) {
          result.attachment = {
            itemId: row.itemId,
            score: row.score,
            sourceClass: row.sourceClass,
            emotionSummary: row.emotionSummary || '',
            base64: row.base64 || null,
            mimeType: row.mimeType || null,
            fileMissing: row.fileMissing === true,
            oversized: row.oversized === true,
          };
        }
      } catch {
        /* 附图失败不影响检索结果（状态解耦原则） */
      }
    }
  } else if (top && top.score >= thresholds.compat) {
    result = {
      status: 'compat',
      candidates: scored.filter((c) => c.score >= thresholds.compat).map(({ modelId, actionId, score }) => ({ modelId, actionId, score })),
      score: top.score,
      llmCalls: 0,
    };
  } else {
    // 未命中：绝不偷偷调 Composer——只有 composition.enabled 且显式注入 composer 才委托
    const composer = options.composer;
    const compositionEnabled = settings.composition?.enabled !== false; // 裁决书默认开
    if (composer && compositionEnabled) {
      const composed = await composer(intent);
      result = { status: 'composed', result: composed, llmCalls: 1 };
    } else {
      result = { status: 'unmatched', reason: 'below-threshold', composerAvailable: !!composer && compositionEnabled, llmCalls: 0 };
    }
  }

  if (cache) options.cache.stats && options.cache.set(cacheKey, result);
  return result;
}

/** 进程内结果缓存（命中率指标；SQLite 持久化 P5 落地）。 */
export function createResultCache() {
  const store = new Map();
  return {
    stats: { hits: 0, misses: 0 },
    get: (k) => store.get(k) ?? null,
    set: (k, v) => store.set(k, v),
  };
}
