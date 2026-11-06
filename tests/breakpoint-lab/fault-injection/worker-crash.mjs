/**
 * 崩溃子进程（被父进程真实 SIGKILL）。多模式：
 *   tx      —— 提交基线后开启未决事务写入第 3 行，落标记后挂住等杀（验证回滚）
 *   resolve —— P0 Resolve：读链落状态文件，落标记后挂住等杀（验证重启重查）
 *   p5      —— P4/P5 执行侧：admit + own 后落标记挂住等杀（纯逻辑，验证不复活）
 *   verify  —— 重启后的校验模式：重新查询并与中断前状态文件比对
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeMarker } from './checkpoint.mjs';

function argOf(flag, def = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : def;
}

const mode = argOf('--mode');
const dbPath = argOf('--db');
const statePath = argOf('--state');
const markerPath = argOf('--marker');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function holdUntilKilled() {
  // 挂住等 SIGKILL（不优雅退出，模拟真实崩溃）：永不 resolve 的 Promise +
  // 保活句柄，进程只能被外部 SIGKILL 终止
  setInterval(() => {}, 60000);
  return new Promise(() => {});
}

async function main() {
  if (mode === 'tx') {
    const { openDb } = await import(pathToFileURL(path.join(ROOT, 'packages/dsh-l2d-db/src/db.mjs')).href);
    const db = openDb({ path: dbPath });
    const row = (semanticKey) => ['id-' + semanticKey, semanticKey, '', '', '', '', '', 1, 'validated', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'];
    // 基线：已提交 2 行
    db.prepare('INSERT INTO motion_definitions (id, semantic_key, description, emotion, expression, gaze, body_language, version, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(...row('bp.tx.committed-1'));
    db.prepare('INSERT INTO motion_definitions (id, semantic_key, description, emotion, expression, gaze, body_language, version, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(...row('bp.tx.committed-2'));
    // 未决事务：第 3 行写入后不提交
    db.exec('BEGIN');
    db.prepare('INSERT INTO motion_definitions (id, semantic_key, description, emotion, expression, gaze, body_language, version, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(...row('bp.tx.inflight-3'));
    const n = db.prepare('SELECT COUNT(*) n FROM motion_definitions').get().n;
    writeMarker(markerPath, JSON.stringify({ inTxCount: n }));
    await holdUntilKilled(); // ← SIGKILL 落点
  }

  if (mode === 'resolve') {
    const { openDb } = await import(pathToFileURL(path.join(ROOT, 'packages/dsh-l2d-db/src/db.mjs')).href);
    const { createActionsRepository } = await import(pathToFileURL(path.join(ROOT, 'packages/dsh-l2d-db/src/actions-repo.mjs')).href);
    const db = openDb({ path: dbPath });
    const repo = createActionsRepository(db, { snapshotDir: path.join(path.dirname(dbPath), 'motions') });
    const motion = repo.getMotionBySemanticKey('bp.tail_sway_a');
    const chain = repo.getActionChain(motion.id, 1);
    // P0 Resolve 中断：已查询、尚未执行；状态落盘后进程被杀
    fs.writeFileSync(statePath, JSON.stringify({ motionId: motion.id, chainId: chain.id, version: 1, semanticKey: 'bp.tail_sway_a', resolvedAt: new Date().toISOString() }));
    writeMarker(markerPath);
    await holdUntilKilled(); // ← SIGKILL 落点
  }

  if (mode === 'verify') {
    // 重启后的 P0：不信任中断前状态文件，全部重新查询
    const { openDb } = await import(pathToFileURL(path.join(ROOT, 'packages/dsh-l2d-db/src/db.mjs')).href);
    const { createActionsRepository } = await import(pathToFileURL(path.join(ROOT, 'packages/dsh-l2d-db/src/actions-repo.mjs')).href);
    const db = openDb({ path: dbPath });
    const repo = createActionsRepository(db, { snapshotDir: path.join(path.dirname(dbPath), 'motions') });
    const before = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const motion = repo.getMotionBySemanticKey(before.semanticKey); // 重走 Resolve
    const chain = repo.getActionChain(motion.id, 1);
    const consistent = motion.id === before.motionId && chain.id === before.chainId && chain.steps.length > 0;
    fs.writeFileSync(statePath + '.verify', JSON.stringify({ consistent, motionId: motion.id, chainId: chain.id }));
    process.exit(consistent ? 0 : 3);
  }

  if (mode === 'p5') {
    // P4/P5 执行侧纯逻辑：admit 占槽 + own 认领，然后进程被杀
    const { ActGate } = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/index.ts')).href);
    const { ParamOwnership } = await import(pathToFileURL(path.join(ROOT, 'packages/renderer/src/app/param-ownership.ts')).href);
    const gate = new ActGate();
    const ownership = new ParamOwnership();
    const adm = gate.admit({ priority: 'ambient', source: 'bp-lab', steps: 2 });
    ownership.own(['ParamAngleX', 'ParamEyeBallX'], 1200);
    fs.writeFileSync(statePath, JSON.stringify({ runId: adm.runId, accepted: adm.accepted, owned: ownership.list() }));
    writeMarker(markerPath);
    await holdUntilKilled(); // ← SIGKILL 落点
  }

  console.error(`worker: 未知模式 ${mode}`);
  process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(2); });
