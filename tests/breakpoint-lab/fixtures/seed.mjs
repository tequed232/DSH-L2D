/**
 * 断点实验数据播种：临时目录构建真实 actions.db（@dsh/db Schema v4）。
 * 3 条动作链（2 个绑定 + 1 个未绑）+ 2 个模型 + 1 条参数范围，全部经
 * 真实 Repository API 写入（不手搓 SQL 绕过验证）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../../../packages/dsh-l2d-db/src/db.mjs';
import { createActionsRepository, resolveActionModelHash } from '../../../packages/dsh-l2d-db/src/actions-repo.mjs';
import { upsertModel, upsertParameter } from '../../../packages/dsh-l2d-db/src/repo.mjs';

export const MANIFEST = JSON.parse(fs.readFileSync(new URL('./model-manifest.json', import.meta.url), 'utf8'));

const PROVENANCE = {
  assets: [{ id: 'bp-a1', sourceType: 'image', originalPath: '/bp/1.png', contentHash: 'sha256:' + 'c'.repeat(64) }],
  analyses: [{ id: 'bp-an1', assetId: 'bp-a1', modelName: 'bp-vlm', analysis: { action: 'bp-lab' } }],
};

/**
 * @param {{dir: string}} opts 临时目录（调用方负责创建与清理）
 * @returns {{db, repo, dbPath, motions: Record<string, {motionId, chainId}>, modelHashOf: (modelId) => string}}
 */
export function seedLabDb({ dir }) {
  const dbPath = path.join(dir, 'actions.db');
  const db = openDb({ path: dbPath });
  for (const m of MANIFEST.models) {
    upsertModel(db, { modelId: m.modelId, title: m.title, sourcePath: m.sourcePath, packageHash: m.packageHash });
  }
  const repo = createActionsRepository(db, { snapshotDir: path.join(dir, 'motions') });

  const chainOf = (tag) => ({
    schemaVersion: '1.0',
    steps: [{ step_index: 0, kind: 'keyframes', params: { track: 'tailSway', keys: [{ t: 0, value: -1 }, { t: 450, value: 1 }] }, durationMs: 450 }],
    ...({ tag }),
  });
  const motions = {};
  for (const m of MANIFEST.motions) {
    const r = repo.createActionChain({ semanticKey: m.semanticKey, description: `bp-lab ${m.semanticKey}`, chain: chainOf(m.semanticKey), provenance: PROVENANCE, sourceId: 'bp-lab-seed' });
    motions[m.semanticKey] = { motionId: r.motionId, chainId: r.chainId, version: r.version };
  }
  for (const m of MANIFEST.motions) {
    if (!m.bindModel) continue;
    db.prepare('INSERT INTO motion_model_bindings (motion_id, model_id, adapter_json, compatible, verified_at) VALUES (?, ?, NULL, 1, ?)')
      .run(motions[m.semanticKey].motionId, m.bindModel, new Date().toISOString());
  }
  for (const p of MANIFEST.parameters) {
    upsertParameter(db, { modelId: p.modelId, paramId: p.paramId, minValue: p.min, maxValue: p.max });
  }

  const manifestModel = (modelId) => MANIFEST.models.find((m) => m.modelId === modelId);
  return {
    db, repo, dbPath, motions,
    modelHashOf: (modelId) => manifestModel(modelId).packageHash,
    resolveActionModelHash: (motionId) => resolveActionModelHash(db, motionId),
  };
}
