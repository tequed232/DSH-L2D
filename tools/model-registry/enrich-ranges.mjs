#!/usr/bin/env node
/**
 * dsh-l2d · 参数范围证据补齐（S1 / Phase 3 前置任务 P3-0）
 *
 * 职责：用 py-moc3（读路径 verified，v0.1.0@2fb112e，MIT）从 大肥鱼.moc3 二进制
 * 直读全部参数的 Min/Max/Default（模型作者设定的一手事实），与注册表 diff 后补齐：
 *
 *  1. 注册表 min/max 为 NULL  → 补齐（range_evidence = py-moc3 直读留痕）
 *  2. 注册表已有值且与 moc3 一致 → 仅补 range_evidence 标注（不重写数据）
 *  3. 注册表已有值且与 moc3 冲突 → **不覆盖**，写 validation_findings（如实留痕，
 *     待人工裁决哪个证据源优先——w3-registry 交叉验证 vs moc3 二进制）
 *
 * 纪律：
 *  - 只读模型文件（py-moc3 read 路径），绝不写回模型源目录；
 *  - 证据留痕（source/artifact/verifiedAt）随行写入 range_evidence；
 *  - 冲突显式暴露，不静默择优。
 *
 * 运行：node tools/model-registry/enrich-ranges.mjs [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../packages/dsh-l2d-db/src/db.mjs';
import { upsertParameter } from '../../packages/dsh-l2d-db/src/repo.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PY_MOC3_SRC = path.join(REPO_ROOT, 'vendor', 'thirdparty', 'py-moc3', 'src');
const MOC3_PATH = path.join(REPO_ROOT, 'DeepSeek免费公皮', 'DeepSeek', '大肥鱼.moc3');
const MODEL_ID = '大肥鱼.dsl2d';
const PY_MOC3_REF = 'py-moc3@2fb112e'; // 注册表 toolchain_components 中的锁定版本

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

function readMoc3Params() {
  const out = execFileSync('python', ['-m', 'moc3', 'params', MOC3_PATH, '--json'], {
    encoding: 'utf8',
    timeout: 120000,
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONPATH: PY_MOC3_SRC },
  });
  return JSON.parse(out); // [{ id, min, max, default }]
}

function main() {
  if (!fs.existsSync(MOC3_PATH)) {
    console.error(`模型文件不存在：${MOC3_PATH}`);
    process.exit(1);
  }
  const db = openDb({ startDir: REPO_ROOT });
  const model = db.prepare('SELECT model_id FROM models WHERE model_id = ?').get(MODEL_ID);
  if (!model) {
    console.error(`模型 '${MODEL_ID}' 未注册，先运行 tools/model-registry/ingest.mjs`);
    process.exit(1);
  }

  console.log(`读取 moc3 参数（${PY_MOC3_REF}，只读）…`);
  const moc3Params = readMoc3Params();
  console.log(`  moc3 内参数：${moc3Params.length}`);

  const registered = db.prepare('SELECT param_id, min_value, max_value, default_value, range_evidence FROM parameters WHERE model_id = ?').all(MODEL_ID);
  const regMap = new Map(registered.map((r) => [r.param_id, r]));
  console.log(`  注册表参数：${registered.length}`);

  const evidence = { source: PY_MOC3_REF, artifact: 'moc3-binary', artifactPath: 'DeepSeek免费公皮/DeepSeek/大肥鱼.moc3', verifiedAt: new Date().toISOString() };
  const stats = { filled: 0, annotated: 0, conflicts: 0, missingInRegistry: [], skipped: 0 };
  const nowIso = new Date().toISOString();

  const fillAll = () => {
    for (const p of moc3Params) {
      if (!p.id) continue;
      const reg = regMap.get(p.id);
      if (!reg) {
        stats.missingInRegistry.push(p.id);
        continue;
      }
      const hasRange = reg.min_value !== null && reg.max_value !== null;
      if (!hasRange) {
        // 1. NULL → 补齐
        if (!dryRun) {
          upsertParameter(db, {
            modelId: MODEL_ID, paramId: p.id,
            minValue: p.min, maxValue: p.max, defaultValue: p.default,
            rangeEvidence: evidence,
          });
        }
        stats.filled += 1;
      } else {
        const sameMin = Math.abs(reg.min_value - p.min) < 1e-6;
        const sameMax = Math.abs(reg.max_value - p.max) < 1e-6;
        if (sameMin && sameMax) {
          // 2. 一致 → 仅补证据标注（若尚无）
          if (!reg.range_evidence && !dryRun) {
            upsertParameter(db, {
              modelId: MODEL_ID, paramId: p.id,
              minValue: reg.min_value, maxValue: reg.max_value, defaultValue: reg.default_value,
              rangeEvidence: evidence,
            });
          }
          stats.annotated += 1;
        } else {
          // 3. 冲突 → 不覆盖，validation_findings 留痕
          if (!dryRun) {
            db.prepare(`
              INSERT INTO validation_findings (model_id, severity, code, message, evidence)
              VALUES (?, 'warn', 'range_evidence_conflict', ?, ?)
            `).run(MODEL_ID, `参数 ${p.id} 范围证据冲突：注册表 vs moc3 二进制，待人工裁决`, JSON.stringify({
              paramId: p.id,
              registered: { min: reg.min_value, max: reg.max_value },
              moc3Binary: { min: p.min, max: p.max },
              sources: { registered: 'w3-registry-cross-validated', challenger: PY_MOC3_REF },
              resolution: 'pending-human-decision',
              detectedAt: nowIso,
            }));
          }
          stats.conflicts += 1;
        }
      }
    }
  };
  const txWrap = () => (dryRun ? fillAll() : require_txn(fillAll));
  function require_txn(fn) {
    // 复用 db.mjs 事务原语
    return import('../../packages/dsh-l2d-db/src/db.mjs').then(({ withTransaction }) => withTransaction(db, fn));
  }

  (async () => {
    await txWrap();
    const left = db.prepare('SELECT COUNT(*) n FROM parameters WHERE model_id = ? AND min_value IS NULL').get(MODEL_ID).n;
    console.log(`\n结果（${dryRun ? 'DRY-RUN' : '已写入'}）：`);
    console.log(`  补齐（NULL→moc3 值）: ${stats.filled}`);
    console.log(`  一致标注证据: ${stats.annotated}`);
    console.log(`  冲突留痕（未覆盖）: ${stats.conflicts}`);
    console.log(`  moc3 有而注册表缺: ${stats.missingInRegistry.length}${stats.missingInRegistry.length ? ' → ' + stats.missingInRegistry.slice(0, 5).join(', ') + (stats.missingInRegistry.length > 5 ? ' …' : '') : ''}`);
    console.log(`  注册表仍无范围参数: ${left}`);
    // 目标通道核对（P3-0 验收点）
    const targets = ['Param_Angle_Rotation84', 'Param_Angle_Rotation85', 'Param_Angle_Rotation86', 'Param_Angle_Rotation87', 'Clothes5', 'Param52'];
    console.log('\n  P3-0 目标通道：');
    for (const t of targets) {
      const r = db.prepare('SELECT param_id, min_value, max_value, default_value, range_evidence FROM parameters WHERE model_id = ? AND param_id = ?').get(MODEL_ID, t);
      console.log(`    ${t.padEnd(24)} ${r ? `[${r.min_value}, ${r.max_value}] default=${r.default_value}${r.range_evidence ? ' ✅evidence' : ' ⚠️no-evidence'}` : '未注册'}`);
    }
    db.close();
  })();
}

main();
