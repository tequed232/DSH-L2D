/**
 * Verify CLI：runtime_verified 判据检查器（只读）。
 *
 * 从 SQLite 读 probe_runs / execution_history / parameters / bindings，
 * 对 RUNTIME-VERIFICATION-PLAN 的 V1–V7 判据逐项给出 PASS/FAIL/BLOCKED。
 *
 * 纪律：本工具**只判不写**——模型级 runtime_verified 的写入仍须
 * upsertModel(runtimeEvidence) 且经人工确认（任务书红线：视觉归因完成前不得标记）。
 *
 * 用法：node tools/runtime-probe/verify.mjs [--model 大肥鱼.dsl2d]
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODEL_ID = process.argv.includes('--model')
  ? process.argv[process.argv.indexOf('--model') + 1]
  : '大肥鱼.dsl2d';

const { openDb } = await import(pathToFileURL(path.join(ROOT, 'packages', 'dsh-l2d-db', 'src', 'db.mjs')).href);
const db = openDb({ startDir: ROOT });

const results = [];
const judge = (id, name, status, detail) => results.push({ id, name, status, detail });

// V1 宿主与渲染：有成功 execution_history / probe_run 即证明渲染循环真实运行
const probeCount = db.prepare('SELECT COUNT(*) n FROM probe_runs').get().n;
judge('V1', '渲染宿主真实运行（probe_runs 存在）', probeCount > 0 ? 'PASS' : 'BLOCKED', `${probeCount} 条 probe_run`);

// V2 模型加载与注册一致
const model = db.prepare('SELECT * FROM models WHERE model_id = ?').get(MODEL_ID);
const paramTotal = db.prepare('SELECT COUNT(*) n FROM parameters WHERE model_id = ?').get(MODEL_ID)?.n ?? 0;
const withRange = db.prepare('SELECT COUNT(*) n FROM parameters WHERE model_id = ? AND min_value IS NOT NULL AND max_value IS NOT NULL').get(MODEL_ID)?.n ?? 0;
judge('V2', `模型已注册且 509 参数 Hard 边界齐备`, model && paramTotal > 0 && withRange === paramTotal ? 'PASS' : 'FAIL',
  `paramTotal=${paramTotal}, withRange=${withRange}`);

// V3 Nodes 与实况一致：绑定参数全部在注册表
const bindings = db.prepare('SELECT * FROM motion_model_bindings WHERE model_id = ? AND compatible = 1').all(MODEL_ID);
let staleBinding = null;
for (const b of bindings) {
  const adapter = JSON.parse(b.adapter_json ?? '{}');
  for (const entries of Object.values(adapter.channels ?? {})) {
    for (const e of entries) {
      const known = db.prepare('SELECT 1 FROM parameters WHERE model_id = ? AND param_id = ?').get(MODEL_ID, e.paramId);
      if (!known) staleBinding = `${b.motion_id}:${e.paramId}`;
    }
  }
}
judge('V3', '绑定参数与注册表一致（无 STALE）', staleBinding ? 'FAIL' : 'PASS', staleBinding ?? `${bindings.length} 个 compatible 绑定`);

// V4 单参基线探针覆盖：耳族 6 + 怒族 8 + 尾族 4
const FAMILIES = {
  ear: ['LEar1', 'LEar2', 'LEar3', 'REar1', 'REar2', 'REar3'],
  angry: ['AngryMove', 'AngryMove2', 'AngryMove3', 'AngryMove4', 'AngryMove5', 'AngryMove6', 'AngryMove7', 'AngryMove8'],
  tail: ['Param_Angle_Rotation84', 'Param_Angle_Rotation85', 'Param_Angle_Rotation86', 'Param_Angle_Rotation87'],
};
for (const [fam, params] of Object.entries(FAMILIES)) {
  const missing = params.filter((p) => {
    const node = db.prepare('SELECT id FROM nodes WHERE model_id = ? AND node_key = ?').get(MODEL_ID, p);
    if (!node) return true;
    const runs = db.prepare('SELECT COUNT(*) n FROM probe_runs WHERE parameter_node_id = ?').get(node.id).n;
    return runs === 0;
  });
  judge(`V4-${fam}`, `${fam} 族单参基线探针覆盖（${params.length} 参数）`, missing.length ? 'BLOCKED' : 'PASS', missing.length ? `缺: ${missing.join(',')}` : '全覆盖');
}

// V5 组合链执行：三动作 execution_history completed
const execs = db.prepare(`
  SELECT m.semantic_key, e.status FROM execution_history e
  JOIN motion_definitions m ON m.id = e.motion_id WHERE e.model_id = ?
`).all(MODEL_ID);
const completed = execs.filter((e) => e.status === 'completed');
const chainOK = ['emotion.happy.tail_sway', 'motion.ear_twitch_independent', 'motion.angry_flash_single']
  .every((k) => completed.some((e) => e.semantic_key === k));
judge('V5', '三动作链真实执行且完成', chainOK ? 'PASS' : 'BLOCKED',
  `completed=${completed.map((e) => e.semantic_key).join(',') || '无'}`);

// V6 安全边界：双层边界落地数 + 探针无硬违规
const dual = db.prepare('SELECT COUNT(*) n FROM parameters WHERE model_id = ? AND soft_min IS NOT NULL AND soft_max IS NOT NULL').get(MODEL_ID)?.n ?? 0;
judge('V6', '双层边界（Hard+Soft）已落地', dual >= 16 ? 'PASS' : 'FAIL', `dual-layer 参数 ${dual}（裁决要求 16 项冲突）`);

// V7 视觉归因（人为闸口）：GLM 多模态 QA 未完成前恒 BLOCKED
judge('V7', '视觉语义归因（GLM 多模态 QA + 人工确认）', 'BLOCKED',
  'ANGRYMOVE-OBSERVATION-DRAFT 初筛已产出；最终职责表与耳族/表情归因未复核——runtime_verified 不允许标记');

const verdict = results.some((r) => r.status === 'FAIL') ? 'FAIL'
  : results.every((r) => r.status === 'PASS') ? 'ALL_PASS_RUNTIME_VERIFIED_ELIGIBLE'
  : 'BLOCKED_PENDING_VISUAL_QA';

console.log(JSON.stringify({ modelId: MODEL_ID, verdict, results }, null, 2));
console.error(`\nverify: ${verdict} （只判不写；runtime_verified 标记须人工确认后经 upsertModel(runtimeEvidence)）`);
if (verdict === 'FAIL') process.exitCode = 2;
