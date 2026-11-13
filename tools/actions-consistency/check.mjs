#!/usr/bin/env node
/**
 * Phase 1 · 动作真源一致性巡检
 *
 * 背景：同一个动作现在可能存在于三处 ——
 *   ① SQLite `compiled_actions`（唯一查询真源）
 *   ② `$DSH_HOME/l2d-action-bundles/<model>/rev-<n>/manifest.json`（编译快照）
 *   ③ `$DSH_HOME/l2d-nodegraphs/<graphId>.json`（可执行图，物化产物）
 * 三者没有任何一致性约束，任一环节出错都会得到"接口说有动作、实际跑不起来"。
 *
 * 本工具做四方比对（DB / manifest / 图文件 / 指针），**只读**，不改任何数据。
 *
 * 用法：
 *   node tools/actions-consistency/check.mjs                 # 人读
 *   node tools/actions-consistency/check.mjs --json          # 机器可读
 *   node tools/actions-consistency/check.mjs --home <dir> --db <file>
 *
 * 退出码：0 = 无 error（warning 允许）；1 = 存在 error；2 = 环境缺失（无库/无目录）
 * 注意：读 SQLite 需要 `--experimental-sqlite`（与本仓其他 db 命令一致）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const HOME = path.resolve(arg('home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh')));
const DB_FILE = path.resolve(arg('db', path.join(HOME, 'l2d-bridge.sqlite')));
const AS_JSON = process.argv.includes('--json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  if (!fs.existsSync(DB_FILE)) {
    const out = { ok: false, reason: 'db-missing', db: DB_FILE, home: HOME };
    if (AS_JSON) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    else console.log(`环境缺失：找不到库 ${DB_FILE}（可用 --db 指定）`);
    process.exit(2);
  }

  const { openDb } = await import(new URL('../../packages/dsh-l2d-db/src/db.mjs', import.meta.url).href);
  const db = openDb({ path: DB_FILE });

  const models = db
    .prepare("SELECT DISTINCT model_id FROM compiled_actions WHERE status = 'published'")
    .all()
    .map((r) => r.model_id);

  const report = { ok: true, home: HOME, db: DB_FILE, models: [], issues: [] };

  for (const modelId of models) {
    const dbActions = db
      .prepare(
        `SELECT action_id, graph_id, graph_hash, manifest_id, status, runtime_verified, approved
         FROM compiled_actions WHERE model_id = ? AND status = 'published' ORDER BY action_id`,
      )
      .all(modelId);

    const bundleDir = path.join(HOME, 'l2d-action-bundles', modelId.replace(/[\\/:*?"<>|]/g, '_'));
    const pointer = readJson(path.join(bundleDir, 'current.json'));
    const manifest = pointer ? readJson(path.join(bundleDir, `rev-${pointer.revision}`, 'manifest.json')) : null;

    const modelReport = {
      modelId,
      revision: pointer ? pointer.revision : null,
      dbPublished: dbActions.length,
      manifestPublished: manifest ? manifest.actions.filter((a) => a.status === 'compiled').length : null,
      missingGraph: [],
      orphanGraph: [],
      manifestMismatch: [],
      missingManifest: !manifest,
    };

    if (!manifest) {
      report.issues.push({
        level: 'error',
        code: 'manifest-missing',
        modelId,
        detail: `DB 有 ${dbActions.length} 条 published，但没有找到 current.json/manifest.json：${bundleDir}`,
      });
    } else {
      const byId = new Map(manifest.actions.map((a) => [a.actionId, a]));
      for (const row of dbActions) {
        const m = byId.get(row.action_id);
        if (!m) {
          modelReport.manifestMismatch.push({ actionId: row.action_id, why: 'manifest 中不存在' });
          report.issues.push({ level: 'error', code: 'db-action-not-in-manifest', modelId, actionId: row.action_id });
          continue;
        }
        if (m.graphId !== row.graph_id || m.graphHash !== row.graph_hash) {
          modelReport.manifestMismatch.push({
            actionId: row.action_id,
            why: `graphId/graphHash 不一致（db=${row.graph_id}/${row.graph_hash} manifest=${m.graphId}/${m.graphHash}）`,
          });
          report.issues.push({ level: 'error', code: 'manifest-graph-mismatch', modelId, actionId: row.action_id });
        }
      }
    }

    // 图文件存在性 + 物化指纹
    for (const row of dbActions) {
      const file = path.join(HOME, 'l2d-nodegraphs', `${row.graph_id}.json`);
      const doc = readJson(file);
      if (!doc) {
        modelReport.missingGraph.push(row.action_id);
        report.issues.push({
          level: 'error',
          code: 'graph-file-missing',
          modelId,
          actionId: row.action_id,
          detail: `已发布动作的图不在图仓：${file}（派发会返回 404 graph-not-found）`,
        });
        continue;
      }
      const markerGraphId = doc && doc.meta && doc.meta.oaca && doc.meta.oaca.graphId;
      if (markerGraphId && markerGraphId !== row.graph_id) {
        report.issues.push({
          level: 'error',
          code: 'graph-marker-mismatch',
          modelId,
          actionId: row.action_id,
          detail: `图内 meta.oaca.graphId=${markerGraphId}，与库中 graph_id=${row.graph_id} 不符`,
        });
      }
    }

    // 孤儿图（有 oaca 标记但库里没有对应 published 动作）
    const graphDir = path.join(HOME, 'l2d-nodegraphs');
    let files = [];
    try {
      files = fs.readdirSync(graphDir).filter((f) => f.endsWith('.json'));
    } catch {
      files = [];
    }
    const publishedGraphIds = new Set(dbActions.map((r) => r.graph_id));
    for (const f of files) {
      const doc = readJson(path.join(graphDir, f));
      const marker = doc && doc.meta && doc.meta.oaca;
      if (!marker) continue;
      if (marker.graphId && !publishedGraphIds.has(marker.graphId)) {
        modelReport.orphanGraph.push(f);
        report.issues.push({
          level: 'warning',
          code: 'orphan-graph',
          modelId,
          detail: `图仓里有编译器产出的孤儿图 ${f}（其动作未发布/已下线），不影响派发但可清理`,
        });
      }
    }

    report.models.push(modelReport);
  }

  db.close();
  report.ok = report.issues.every((i) => i.level !== 'error');

  if (AS_JSON) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    console.log('动作真源一致性巡检');
    console.log(`  home = ${report.home}`);
    console.log(`  db   = ${report.db}`);
    console.log('');
    if (!report.models.length) {
      console.log('  没有任何 model 存在 published 动作（未编译过，属正常初始状态）');
    }
    for (const m of report.models) {
      console.log(`  ${m.modelId}`);
      console.log(`    revision=${m.revision}  dbPublished=${m.dbPublished}  manifestPublished=${m.manifestPublished}`);
      if (m.manifestMismatch.length) console.log(`    manifest 不一致: ${JSON.stringify(m.manifestMismatch)}`);
      if (m.missingGraph.length) console.log(`    缺图: ${m.missingGraph.join(', ')}`);
      if (m.orphanGraph.length) console.log(`    孤儿图: ${m.orphanGraph.join(', ')}`);
    }
    console.log('');
    const errors = report.issues.filter((i) => i.level === 'error');
    const warnings = report.issues.filter((i) => i.level === 'warning');
    console.log(`结论：${report.ok ? '无 error' : '存在 error'}（error=${errors.length} warning=${warnings.length}）`);
    for (const i of report.issues) console.log(`  [${i.level}] ${i.code} ${i.modelId || ''} ${i.actionId || ''} ${i.detail || ''}`);
  }

  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('巡检异常：' + String((err && err.message) || err));
  process.exit(1);
});
