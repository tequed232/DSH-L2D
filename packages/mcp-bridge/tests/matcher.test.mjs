/**
 * Local Action Matcher 验收（SUPERVISOR-P12 / P2，ret.* 用例，docs/mcp-bridge/TEST-PLAN.md §2）。
 * 候选身份 = (modelId, actionId) 模型锚定（BOOTSTRAP-DECREE §0.3/§9.1 修正案）。
 * 直跑：node --experimental-sqlite packages/mcp-bridge/tests/matcher.test.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../dsh-l2d-db/src/db.mjs';
import {
  scoreAction, matchIntent, createSuccessRateAdapter, createResultCache,
  DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS,
} from '../action-matcher.mjs';

let passed = 0;
async function okAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matcher-p12-'));
const db = openDb({ path: path.join(tmp, 'matcher.sqlite') });

/** 执行历史 fixture：motion_definitions 父行 + execution_history 样本。 */
function seedHistory(motionId, statuses) {
  db.prepare(
    `INSERT OR IGNORE INTO motion_definitions (id, semantic_key, description, created_at, updated_at)
     VALUES (?, ?, 'seed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
  ).run(motionId, 'sem.' + motionId);
  let i = 0;
  for (const status of statuses) {
    i += 1;
    db.prepare(
      `INSERT OR IGNORE INTO execution_history (id, motion_id, model_id, status, started_at)
       VALUES (?, ?, 'm-cur', ?, '2026-01-01T00:00:00Z')`
    ).run(`${motionId}-h${i}`, motionId, status);
  }
}

const CAND = {
  modelId: 'm-cur',
  actionId: 'act.wave',
  motionId: 'm-1',
  chainId: 'chain-1',
  capabilityId: 'gesture.right_finger',
  statusTags: ['waiting_input', 'running'],
  emotions: [{ emotion: 'happy', expression: 'smile', reviewState: 'approved' }],
};

console.log('P2 Local Action Matcher（ret.*）');

ok('ret.score.weights：五维权重 35/25/20/10/10 单维注入验证', () => {
  const intent = { modelId: 'm-cur', capabilityId: 'gesture.right_finger', status: 'waiting_input', emotion: 'happy', expression: 'smile' };
  const full = scoreAction(intent, CAND, { successRate: () => 1 });
  assert.equal(full.parts.capability, 1);
  assert.equal(full.parts.status, 1);
  assert.equal(full.parts.emotion, 1);
  assert.equal(full.parts.expression, 1);
  assert.equal(full.parts.successRate, 1);
  assert.equal(full.score, 1);
  // 单维：只命中 capability
  const onlyCap = scoreAction(
    { modelId: 'm-cur', capabilityId: 'gesture.right_finger', status: 'error' },
    { ...CAND, emotions: [] },
    { successRate: () => 0 }
  );
  assert.equal(onlyCap.parts.capability, 1);
  assert.equal(onlyCap.parts.status, 0);
  assert.equal(onlyCap.score, 0.35);
  // status 同族半分：waiting_subagent ↔ waiting_input
  const fam = scoreAction(
    { modelId: 'm-cur', capabilityId: 'x', status: 'waiting_subagent' },
    { ...CAND, capabilityId: 'y', emotions: [] },
    { successRate: () => 0 }
  );
  assert.equal(fam.parts.status, 0.5, 'waiting 同族 0.5');
  assert.equal(fam.score, DEFAULT_WEIGHTS.status * 0.5);
});

okAsync('ret.threshold.adopt：score≥0.85 → adopted 且 llmCalls=0', async () => {
  const r = await matchIntent(
    { modelId: 'm-cur', capabilityId: 'gesture.right_finger', status: 'waiting_input', emotion: 'happy' },
    [CAND],
    { successRate: () => 0.5 } // 0.35+0.25+0.2(happy)+0+0.05=0.85 边界
  );
  assert.equal(r.status, 'adopted');
  assert.equal(r.score, 0.85);
  assert.equal(r.llmCalls, 0);
  assert.equal(r.match.actionId, 'act.wave');
});

okAsync('ret.threshold.compat：0.65-0.85 → compat 候选列表', async () => {
  const r = await matchIntent(
    { modelId: 'm-cur', capabilityId: 'gesture.right_finger', status: 'waiting_input' },
    [{ ...CAND, emotions: [] }], // 0.35+0.25+0+0+0.05=0.65
    { successRate: () => 0.5 }
  );
  assert.equal(r.status, 'compat');
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].actionId, 'act.wave');
});

okAsync('ret.threshold.unmatched：<0.65 → unmatched，composer 未注入不偷偷兜底', async () => {
  const r = await matchIntent(
    { modelId: 'm-cur', capabilityId: 'nope', status: 'idle' },
    [CAND],
    { successRate: () => 0.5 }
  );
  assert.equal(r.status, 'unmatched');
  assert.equal(r.composerAvailable, false);
  assert.equal(r.llmCalls, 0);
});

okAsync('ret.capability.fail-closed：registry 不可用 → 全部拒绝', async () => {
  const r = await matchIntent(
    { modelId: 'm-cur', capabilityId: 'gesture.right_finger', status: 'waiting_input' },
    [CAND],
    { registry: { status: 'invalid' }, successRate: () => 1 }
  );
  assert.equal(r.status, 'unmatched');
  assert.match(r.reason, /registry-invalid/);
  // intent 缺 modelId：编程错误直接抛（模型锚定身份，BOOTSTRAP-DECREE §0.3）
  await assert.rejects(() => matchIntent({ capabilityId: 'x' }, [CAND]), /modelId 必填/);
});

ok('ret.history成功率：adapter 只读 execution_history，样本<5 中性 0.5，≥5 按实算', () => {
  seedHistory('m-1', ['completed', 'completed', 'completed', 'failed']);
  const adapter = createSuccessRateAdapter(db);
  const low = adapter({ motionId: 'm-1' });
  assert.equal(low, 0.5, '样本 4 < 5 → 中性');
  seedHistory('m-1', ['completed', 'failed']);
  const real = adapter({ motionId: 'm-1' });
  assert.equal(real, 0.5, '6 样本 3 完成 3 失败 → 0.5');
  seedHistory('m-2', ['completed', 'completed', 'completed', 'completed', 'failed', 'timeout']);
  const rate = adapter({ motionId: 'm-2' });
  assert.equal(rate, 4 / 6, 'completed/(completed+failed+timeout)=4/6 按分母口径');
  seedHistory('m-3', ['completed', 'completed', 'completed', 'completed', 'completed', 'failed']);
  assert.equal(adapter({ motionId: 'm-3' }), 5 / 6);
  // 无 adapter 时成功率维度取中性 0.5
  const parts = scoreAction({ modelId: 'm-cur', capabilityId: 'x' }, { ...CAND, capabilityId: 'x', emotions: [] }, {});
  assert.equal(parts.parts.successRate, 0.5);
});

okAsync('ret.cache：cacheEnabled → 二次同查询命中缓存，命中率指标落账', async () => {
  const cache = createResultCache();
  const opts = {
    settings: { localRetrieval: { enabled: true, cacheEnabled: true } },
    cache, successRate: () => 0.5,
  };
  const intent = { modelId: 'm-cur', capabilityId: 'nope', status: 'idle' };
  const r1 = await matchIntent(intent, [CAND], opts);
  assert.equal(r1.fromCache, undefined);
  const r2 = await matchIntent(intent, [CAND], opts);
  assert.equal(r2.fromCache, true);
  assert.equal(cache.stats.hits, 1);
  assert.equal(cache.stats.misses, 1);
});

okAsync('ret.emotion-routing：needs_review 永不参与检索；同分 preferTaggedActions 生效', async () => {
  // needs_review 命中 intent.emotion 也不计分
  const pending = { ...CAND, emotions: [{ emotion: 'happy', expression: 'smile', reviewState: 'needs_review' }] };
  const parts = scoreAction({ modelId: 'm-cur', capabilityId: 'x', emotion: 'happy' }, { ...CAND, capabilityId: 'x', emotions: pending.emotions }, {});
  assert.equal(parts.parts.emotion, 0);
  // 同分双候选：approved 标签的排前（preferTaggedActions）
  const a = { ...CAND, actionId: 'a.tagged', emotions: [{ emotion: 'calm', expression: 'rest', reviewState: 'approved' }] };
  const b = { ...CAND, actionId: 'b.plain', emotions: [] };
  const r = await matchIntent(
    { modelId: 'm-cur', capabilityId: 'nope', status: 'idle' },
    [b, a],
    { settings: { emotionRouting: { preferTaggedActions: true } }, successRate: () => 0.5 }
  );
  assert.equal(r.status, 'unmatched', '同分 <0.65 仍 unmatched（capability 全零）');
  // 用 compat 分数区间验证排序：两条 compat 候选
  const a2 = { ...CAND, actionId: 'a.tagged', capabilityId: 'cap.x', emotions: [{ emotion: 'calm', expression: 'rest', reviewState: 'approved' }] };
  const b2 = { ...CAND, actionId: 'b.plain', capabilityId: 'cap.x', emotions: [] };
  const r2 = await matchIntent(
    { modelId: 'm-cur', capabilityId: 'cap.x', status: 'waiting_input' },
    [b2, a2],
    { settings: { emotionRouting: { preferTaggedActions: true } }, successRate: () => 0.5 }
  );
  assert.equal(r2.status, 'compat');
  assert.equal(r2.candidates[0].actionId, 'a.tagged', '同分时带 approved 标签者优先');
});

okAsync('ret.model-preference（验收第 12 条）：同分时当前模型优先', async () => {
  const other = { ...CAND, modelId: 'm-other', actionId: 'act.other' };
  const cur = { ...CAND, actionId: 'act.zzz' }; // 字典序更大，验证排序不是靠 actionId
  const r = await matchIntent(
    { modelId: 'm-cur', capabilityId: 'gesture.right_finger', status: 'waiting_input', emotion: 'happy' },
    [other, cur],
    { successRate: () => 0.5 } // 双双 0.85 并列
  );
  assert.equal(r.status, 'adopted');
  assert.equal(r.match.modelId, 'm-cur', '同分当前模型优先，不受 actionId 字典序影响');
  assert.equal(r.match.actionId, 'act.zzz');
});

okAsync('ret.negative.llm-zero（负面一）：命中已有链 → Composer/LLM 调用数=0', async () => {
  let composerCalls = 0;
  const composer = async () => { composerCalls++; return { nodes: [] }; };
  const r = await matchIntent(
    { modelId: 'm-cur', capabilityId: 'gesture.right_finger', status: 'waiting_input', emotion: 'happy' },
    [CAND],
    { successRate: () => 1, composer }
  );
  assert.equal(r.status, 'adopted');
  assert.equal(r.llmCalls, 0);
  assert.equal(composerCalls, 0, '命中已有链绝不触发 Composer');
});

okAsync('ret.negative.no-composer（负面二）：关 Composition 后未命中 → 绝不偷偷调 Composer', async () => {
  let composerCalls = 0;
  const composer = async () => { composerCalls++; return { nodes: [] }; };
  const r = await matchIntent(
    { modelId: 'm-cur', capabilityId: 'nope', status: 'idle' },
    [CAND],
    { settings: { composition: { enabled: false } }, successRate: () => 0.5, composer }
  );
  assert.equal(r.status, 'unmatched');
  assert.equal(composerCalls, 0, '关开关后 Composer 调用计数=0');
  assert.equal(r.composerAvailable, false);
  // 开关开启且注入 composer 才委托（契约路径对照）
  const r2 = await matchIntent(
    { modelId: 'm-cur', capabilityId: 'nope', status: 'idle' },
    [CAND],
    { successRate: () => 0.5, composer }
  );
  assert.equal(r2.status, 'composed');
  assert.equal(composerCalls, 1);
});

okAsync('ret.settings.switch：localRetrieval.enabled=false → disabled 短路', async () => {
  let composerCalls = 0;
  const r = await matchIntent(
    { modelId: 'm-cur', capabilityId: 'x' }, [CAND],
    { settings: { localRetrieval: { enabled: false } }, composer: async () => { composerCalls++; } }
  );
  assert.equal(r.status, 'disabled');
  assert.equal(composerCalls, 0);
});

// ---- CODE-FIX-2 回归（L1 / L2）----

okAsync('ret.cache.guard（L1 回归）：cache 有 get/set 无 stats → 不抛 TypeError，照常工作', async () => {
  // 原实现命中路径直接 cache.stats.hits += 1 → 注入无 stats 的自定义 cache 抛 TypeError
  const store = new Map();
  const statsLessCache = { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v) }; // 无 stats
  const opts = {
    successRate: () => 1,
    settings: { localRetrieval: { cacheEnabled: true } },
    cache: statsLessCache,
  };
  const r1 = await matchIntent({ modelId: 'm-cur', capabilityId: 'gesture.right_finger', status: 'waiting_input' }, [CAND], opts);
  assert.equal(r1.status, 'compat', '首次检索正常返回（0.70 落 compat；原实现此处抛 TypeError）');
  const r2 = await matchIntent({ modelId: 'm-cur', capabilityId: 'gesture.right_finger', status: 'waiting_input' }, [CAND], opts);
  assert.equal(r2.fromCache, true, '无 stats 的 cache 仍可命中缓存');
});

okAsync('ret.threshold.compat-link（L2 回归）：matchThreshold<0.65 时 compat=adopt 联动（区间收缩为空集，语义显式）', async () => {
  // 原实现 compat 恒 0.65：matchThreshold<0.65 时 [0.65, adopt) 为空集，compat 永不可达。
  // 候选分数 0.70 = capability 0.35 + status 0.25 + successRate 0.10（sr=1，精确命中两维）。
  const r = await matchIntent(
    { modelId: 'm-cur', capabilityId: 'gesture.right_finger', status: 'waiting_input' }, [CAND],
    { successRate: () => 1, settings: { localRetrieval: { matchThreshold: 0.5 } } }
  );
  assert.equal(r.status, 'adopted', '0.70 ≥ adopt(0.5)：compat 区间空集 → 按采用处理（口径放宽语义显式化，非静默变形）');
  // adopt 上调（>0.85）时 compat 保持 0.65 不变，区间不塌缩
  const r2 = await matchIntent(
    { modelId: 'm-cur', capabilityId: 'gesture.right_finger', status: 'waiting_input' }, [CAND],
    { successRate: () => 1, settings: { localRetrieval: { matchThreshold: 0.95 } } }
  );
  assert.equal(r2.status, 'compat', 'matchThreshold=0.95 时 0.70 落入 compat（compat 保持 0.65）');
});

console.log(`\n结果：${process.exitCode ? '存在失败' : '全部通过'}（${passed} 项用例）`);
if (process.exitCode) process.exit(1);
