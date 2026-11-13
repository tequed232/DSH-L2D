/**
 * OACA-2 · 编译产物 → 动作注册表 同步桥（插件侧薄适配层）。
 *
 * 为什么需要这一层（而不是直接改 action-compiler.mjs）：
 *  - action-compiler 属**受保护范围**（LLM 编译器纪律：只产出文件系统 bundle，
 *    不直接写生产库）。注册表写入是"发布之后"的另一件事，必须在其外部完成。
 *  - 分工：compiler 决定"哪些动作被编译/被拒"（四层校验结论），本模块只做**形状搬运**
 *    —— bundle.actions → manifest.actions（字段白名单）+ publishBundleToDb 落库。
 *    本模块不重算校验结论、不改 status、不发明字段。
 *
 * 纪律：
 *  - 未发布（result.published 缺失/无 revision）→ 不写库，返回 {ok:false,
 *    reason:'not-published'}；绝不"半发布"或写空 manifest。
 *  - 幂等由 DB 层保证（同 (modelId, revision) 覆盖同一行）；本层不另做去重状态。
 *  - requiresOwn 原样带走：运行时必须先 own 再写（ownership 约束不在编译期解决）。
 */
import { publishBundleToDb } from '../../dsh-l2d-db/src/action-manifest-repo.mjs';

export const MANIFEST_VERSION = 1;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * 把 bundle 里的单个动作条目裁剪成 manifest 允许的字段（白名单，不整条透传）。
 * 保留 `status/reason/errors/layers/warnings`：四层校验结论与被拒原因必须可审计
 * （QA F-6 / 方案 §6 第 3 条「published 行必须带四层校验结果」）——
 * 否则 `action_manifests.manifest_json` 里只剩 status，排查时看不到被哪一层拒绝、
 * 也看不到 ownership/requires-own 这类 L3 warning。
 *
 * layers/errors/warnings 恒出现（缺失时为 null/[]），让消费方读字段不必先判存在性；
 * reason 只在有归因时出现（不给通过的动作凭空补字段）。
 */
function toManifestAction(action) {
  return {
    actionId: action.actionId,
    graphId: action.graphId,
    category: action.category ?? 'misc',
    triggers: Array.isArray(action.triggers) ? action.triggers : [],
    priority: action.priority ?? 'NORMAL',
    interruptible: action.interruptible !== false,
    parameters: action.parameters && typeof action.parameters === 'object' ? action.parameters : {},
    requiredControls: Array.isArray(action.requiredControls) ? action.requiredControls : [],
    requiresOwn: Array.isArray(action.requiresOwn) ? action.requiresOwn : [],
    graphHash: action.graphHash ?? null,
    status: action.status,
    // ---- 四层校验结论（schema / capability / safety / execution）----
    // execution 在 OACA-1 阶段是 {status:'skipped', reason:'deferred-to-oaca-4'}，
    // 原样保留，绝不改写成 pass。
    layers: action.layers && typeof action.layers === 'object' ? action.layers : null,
    errors: Array.isArray(action.errors) ? action.errors : [],
    warnings: Array.isArray(action.warnings) ? action.warnings : [],
    ...(action.reason ? { reason: action.reason } : {}),
  };
}

/**
 * 同步一次 compileModelActions() 的结果到注册表。
 *
 * @param {object} input
 * @param {import('node:sqlite').DatabaseSync} input.db 已迁移的库连接（bridgeDb，不新建连接）
 * @param {object} input.result compileModelActions 的返回值（需含 bundle 与 published）
 * @returns {{ok: true, manifestId: string, revision: number, publishedActions: string[]}
 *          | {ok: false, reason: string, message?: string}}
 */
export function syncCompiledBundle({ db, result } = {}) {
  if (!db) return { ok: false, reason: 'db-required' };
  if (!result || typeof result !== 'object') return { ok: false, reason: 'invalid-result' };

  const bundle = result.bundle;
  const published = result.published;
  if (!bundle || !isNonEmptyString(bundle.modelId)) {
    return { ok: false, reason: 'invalid-bundle' };
  }
  // 未发布（dryRun / 全被拒 / 落盘失败）→ 不动库，如实返回原因
  if (!published || published.ok === false || !Number.isInteger(published.revision)) {
    return { ok: false, reason: 'not-published', message: published && published.reason ? String(published.reason) : 'published 缺失或无 revision' };
  }

  const actions = Array.isArray(bundle.actions) ? bundle.actions : [];
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    modelId: bundle.modelId,
    capabilityRevision: String(bundle.capabilityRevision ?? ''),
    compilerVersion: String(bundle.compilerVersion ?? ''),
    revision: published.revision,
    compiledAt: bundle.compiledAt ?? null,
    actions: actions.map(toManifestAction),
  };

  const out = publishBundleToDb(db, {
    modelId: bundle.modelId,
    capabilityRevision: manifest.capabilityRevision,
    compilerVersion: manifest.compilerVersion,
    revision: published.revision,
    manifest,
    actions,
  });
  return { ok: true, ...out };
}
