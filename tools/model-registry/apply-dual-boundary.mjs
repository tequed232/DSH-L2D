#!/usr/bin/env node
/**
 * dsh-l2d · 双层边界落地（2026-11-05 用户裁决执行）
 *
 * 裁决：16 项范围证据冲突不二选一，采用双层：
 *  - Hard Boundary（min_value/max_value）← moc3 作者定义理论边界（硬性限幅）
 *  - Soft Motion Envelope（soft_min/soft_max）← w3-registry 实测摆幅（动作推荐）
 *  - 原始证据保留（range_evidence 重写为双层记录但含原始来源与旧值；
 *    validation_findings 的 evidence 追加 resolution 字段，原内容不删除）
 *
 * 前置：schema v6（soft_min/soft_max 列）已迁移。
 * 运行：node tools/model-registry/apply-dual-boundary.mjs [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { openDb } from '../../packages/dsh-l2d-db/src/db.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PY_MOC3_SRC = path.join(REPO_ROOT, 'vendor', 'thirdparty', 'py-moc3', 'src');
const MOC3_PATH = path.join(REPO_ROOT, 'DeepSeek免费公皮', 'DeepSeek', '大肥鱼.moc3');
const MODEL_ID = '大肥鱼.dsl2d';
const dryRun = process.argv.includes('--dry-run');

// 1. moc3 理论边界（Hard 来源）
const moc3Params = JSON.parse(execFileSync('python', ['-m', 'moc3', 'params', MOC3_PATH, '--json'], {
  encoding: 'utf8', timeout: 120000, cwd: REPO_ROOT,
  env: { ...process.env, PYTHONPATH: PY_MOC3_SRC },
}));
const moc3Map = new Map(moc3Params.map((p) => [p.id, p]));

const db = openDb({ startDir: REPO_ROOT });
const findings = db.prepare(`
  SELECT id, evidence FROM validation_findings
  WHERE model_id = ? AND code = 'range_evidence_conflict' AND message LIKE '%待人工裁决%'
`).all(MODEL_ID);

console.log(`待裁决冲突 findings：${findings.length}`);
let applied = 0, skipped = 0;
const nowIso = new Date().toISOString();

db.exec('BEGIN IMMEDIATE');
try {
  for (const f of findings) {
    const ev = JSON.parse(f.evidence);
    if (ev.resolution !== 'pending-human-decision') { skipped += 1; continue; }
    const m = moc3Map.get(ev.paramId);
    if (!m) { console.error(`  moc3 无 ${ev.paramId}，跳过`); skipped += 1; continue; }

    const dualEvidence = {
      layers: {
        hard: { min: m.min, max: m.max, source: 'py-moc3@2fb112e:moc3-binary', role: 'hard-safety-boundary' },
        soft: { min: ev.registered.min, max: ev.registered.max, source: 'w3-registry-cross-validated', role: 'soft-motion-envelope' },
      },
      history: { originalRegistered: ev.registered, originalSource: ev.sources?.registered ?? 'unknown', conflictDetectedAt: ev.detectedAt },
      resolvedAt: nowIso,
      policy: 'dual-layer-2026-11-05',
    };

    if (!dryRun) {
      db.prepare(`
        UPDATE parameters SET min_value = ?, max_value = ?, soft_min = ?, soft_max = ?, range_evidence = ?
        WHERE model_id = ? AND param_id = ?
      `).run(m.min, m.max, ev.registered.min, ev.registered.max, JSON.stringify(dualEvidence), MODEL_ID, ev.paramId);
      // findings 追加 resolution（原 evidence 字段保留，仅扩展）
      const updatedEv = { ...ev, resolution: 'resolved-dual-layer', resolvedAt: nowIso, policy: 'dual-layer-2026-11-05' };
      db.prepare('UPDATE validation_findings SET message = ?, evidence = ? WHERE id = ?')
        .run(`参数 ${ev.paramId} 范围证据冲突：已按双层边界落地（Hard=moc3，Soft=w3-registry）`, JSON.stringify(updatedEv), f.id);
    }
    applied += 1;
    console.log(`  ${ev.paramId.padEnd(12)} Hard=[${m.min},${m.max}] Soft=[${ev.registered.min},${ev.registered.max}]`);
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

console.log(`\n结果（${dryRun ? 'DRY-RUN' : '已写入'}）：落地 ${applied}，跳过 ${skipped}`);
if (!dryRun) {
  // 验证：16 项参数应双层齐备
  const check = db.prepare(`
    SELECT param_id, min_value, max_value, soft_min, soft_max FROM parameters
    WHERE model_id = ? AND param_id IN ('ShockR','ShockL','Param31','Param32','Param28','Param30','Startwinkle','Param36','Param39','Param41','Param42','Param43','Param62','Param59','Param60','Param61')
  `).all(MODEL_ID);
  const dual = check.filter((r) => r.min_value !== null && r.soft_min !== null).length;
  console.log(`双层齐备验证：${dual}/16`);
}
db.close();
