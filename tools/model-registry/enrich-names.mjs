#!/usr/bin/env node
/**
 * dsh-l2d · 参数显示名补齐（S2：语义定位数据准备）
 *
 * 职责：从 大肥鱼.cdi3.json（Cubism 编辑器导出的显示信息文件，一手事实，
 * evidence_level=source_exact）读取全部参数中文名，补齐注册表 name IS NULL 的行。
 *
 * 纪律：
 *  - 只补缺，不覆盖已有 name（0 冲突已实测 2026-11-04；若未来出现冲突，
 *    走 validation_findings 人工裁决，不静默择优）；
 *  - cdi3 名为语义定位提供依据（如 AngryMove=生气移动 / 生气伸缩 / 生气显隐、
 *    LEar1~3=<兽耳PHA/B/C），是 Phase 3 三动作跨参数族桥接的命名证据。
 *
 * 运行：node tools/model-registry/enrich-names.mjs [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../packages/dsh-l2d-db/src/db.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CDI_PATH = path.join(REPO_ROOT, 'DeepSeek免费公皮', 'DeepSeek', '大肥鱼.cdi3.json');
const MODEL_ID = '大肥鱼.dsl2d';
const dryRun = process.argv.includes('--dry-run');

const cdi = JSON.parse(fs.readFileSync(CDI_PATH, 'utf8'));
const cdiNames = new Map((cdi.Parameters ?? []).filter((p) => p.Id).map((p) => [p.Id, p.Name ?? null]));

const db = openDb({ startDir: REPO_ROOT });
const rows = db.prepare('SELECT id, param_id, name FROM parameters WHERE model_id = ?').all(MODEL_ID);

let filled = 0, kept = 0, conflicts = 0, notInCdi = [];
const nowIso = new Date().toISOString();

db.exec('BEGIN IMMEDIATE');
try {
  for (const r of rows) {
    const cdiName = cdiNames.get(r.param_id);
    if (cdiName === undefined) { notInCdi.push(r.param_id); continue; }
    if (r.name === null && cdiName !== null) {
      if (!dryRun) {
        db.prepare('UPDATE parameters SET name = ? WHERE id = ?').run(cdiName, r.id);
      }
      filled += 1;
    } else if (r.name !== null && cdiName !== null && r.name !== cdiName) {
      // 冲突不覆盖，留痕待人工裁决
      if (!dryRun) {
        db.prepare(`
          INSERT INTO validation_findings (model_id, severity, code, message, evidence)
          VALUES (?, 'info', 'name_evidence_conflict', ?, ?)
        `).run(MODEL_ID, `参数 ${r.param_id} 显示名冲突：注册表 vs cdi3，待人工裁决`, JSON.stringify({
          paramId: r.param_id, registered: r.name, cdi3: cdiName,
          sources: { registered: 'prior-ingest', challenger: 'cdi3.json' },
          resolution: 'pending-human-decision', detectedAt: nowIso,
        }));
      }
      conflicts += 1;
    } else {
      kept += 1;
    }
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

const left = db.prepare('SELECT COUNT(*) n FROM parameters WHERE model_id = ? AND name IS NULL').get(MODEL_ID).n;
console.log(`结果（${dryRun ? 'DRY-RUN' : '已写入'}）：补名 ${filled}，保留 ${kept}，冲突留痕 ${conflicts}，cdi3 无此参数 ${notInCdi.length}，仍缺名 ${left}`);

// 语义定位核对（S2 验收点：三动作跨参数族）
const probes = ['LEar1', 'LEar2', 'LEar3', 'REar1', 'REar2', 'REar3', 'AngryMove', 'AngryMove2', 'AngryMove3', 'Param_Angle_Rotation84', 'Clothes5', 'Param52'];
console.log('\n语义定位核对：');
for (const p of probes) {
  const r = db.prepare('SELECT param_id, name, min_value, max_value FROM parameters WHERE model_id = ? AND param_id = ?').get(MODEL_ID, p);
  console.log(`  ${p.padEnd(24)} ${r ? `${r.name ?? '(无名)'}  [${r.min_value}, ${r.max_value}]` : '未注册'}`);
}
db.close();
