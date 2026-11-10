/**
 * 动作库只读 API（/api/actions）：宿主插件路由 /dsh-l2d/api/actions 与 dev-server /api/actions 共用。
 *
 * 数据来源：<仓库根>/data/bootstrap-state.sqlite（可用 DSH_L2D_ACTIONS_DB 覆盖），
 * 只出 status='validated' 且对当前模型 compatible=1 的动作链（模型 id 缺省 大肥鱼.dsl2d，
 * 可用 DSH_L2D_ACTIONS_MODEL_ID 覆盖）。
 * 只读纪律：DatabaseSync readOnly、每次请求独立连接；库缺失 / 损坏 / 无 sqlite → 空集，前端静默降级不 500。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..', '..');
export const DEFAULT_ACTIONS_DB_FILE = path.join(REPO_ROOT, 'data', 'bootstrap-state.sqlite');
export const DEFAULT_ACTIONS_MODEL_ID = '大肥鱼.dsl2d';

export function actionsSource(env = process.env) {
  return {
    dbFile: env.DSH_L2D_ACTIONS_DB || DEFAULT_ACTIONS_DB_FILE,
    modelId: env.DSH_L2D_ACTIONS_MODEL_ID || DEFAULT_ACTIONS_MODEL_ID,
  };
}

/** @returns {Promise<Array<{chainId, motionId, semanticKey, emotion, chainJson, adapterJson}>>} */
export async function queryValidatedActions(source = actionsSource()) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(source.dbFile, { readOnly: true });
    try {
      return db
        .prepare(
          `SELECT c.id AS chainId, d.id AS motionId, d.semantic_key AS semanticKey,
                  d.emotion AS emotion, c.chain_json AS chainJson, b.adapter_json AS adapterJson
           FROM action_chains c
           JOIN motion_definitions d ON d.id = c.motion_id
           JOIN motion_model_bindings b ON b.motion_id = d.id
           WHERE d.status = 'validated' AND b.compatible = 1 AND b.model_id = ?
           ORDER BY d.semantic_key`,
        )
        .all(source.modelId)
        .map((row) => ({ ...row }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** 路由处理：只接 GET。返回 {status, payload}（405 时 payload 为纯文本）。 */
export async function handleActionsRequest(method, source) {
  if (method && method !== 'GET') return { status: 405, text: 'use GET' };
  return { status: 200, payload: { ok: true, actions: await queryValidatedActions(source || actionsSource()) } };
}
