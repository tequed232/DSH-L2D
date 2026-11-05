/**
 * 种子脚本：登记耳/怒两条探针动作链 + Model Adapter 绑定（经 G0-G4 唯一入口）。
 *
 * 证据纪律：
 *  - 只绑定**单参基线探针已 PASS** 的参数（probe_run 5/9-13 耳族、6/14-20 怒族）；
 *  - AngryMove1-8 职责未做视觉确认前，怒链只含 AngryMove 单参数——不预设、不组合；
 *  - 耳链双轨道时间错开，验证 LEar/REar 独立运动；
 *  - provenance 留痕探针编号与证据等级（probe_numeric；视觉语义确认留 GLM 多模态验收）。
 *
 * 用法：node tools/runtime-probe/seed-probe-actions.mjs
 * （幂等：重复执行遇同 semantic_key 不同内容会 VERSION_CONFLICT——那是 R9 纪律，不是 bug）
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODEL_ID = '大肥鱼.dsl2d';

const { openDb } = await import(pathToFileURL(path.join(ROOT, 'packages', 'dsh-l2d-db', 'src', 'db.mjs')).href);
const { createActionsRepository } = await import(pathToFileURL(path.join(ROOT, 'packages', 'dsh-l2d-db', 'src', 'actions-repo.mjs')).href);
const { bindMotionToModel } = await import(pathToFileURL(path.join(ROOT, 'packages', 'dsh-l2d-db', 'src', 'model-adapter.mjs')).href);

const db = openDb({ startDir: ROOT });
const repo = createActionsRepository(db);

const PROVENANCE = (runs) => ({
  source: 'runtime-probe-baseline',
  probeRuns: runs,
  evidenceLevel: 'probe_numeric',   // 数值探针证据；视觉语义确认留 GLM 多模态验收
  createdAt: new Date().toISOString(),
});

// 1) 耳：双轨道错时——左耳先动，右耳 600ms 后动，验证独立性
//    注意：createActionChain 的 chain 字段为 camelCase（schemaVersion/durationMs）
const ear = repo.createActionChain({
  semanticKey: 'motion.ear_twitch_independent',
  description: '兽耳抽动（左/右独立错时）——LEar1/REar1 单参探针 PASS 后的最小组合',
  emotion: 'curious',
  actor: 'runtime-probe-seed',
  provenance: PROVENANCE([5, 9, 10, 11, 12, 13]),
  chain: {
    chain_id: 'chain-ear-twitch-independent-1',
    schemaVersion: '1.0.0',
    loop: false,
    steps: [
      { kind: 'keyframes', params: { track: 'earLeft', keys: [{ t: 0, value: 0 }, { t: 300, value: 1 }, { t: 600, value: 0 }] }, durationMs: 600, interruptible: true },
      { kind: 'keyframes', params: { track: 'earRight', keys: [{ t: 600, value: 0 }, { t: 900, value: 1 }, { t: 1200, value: 0 }] }, durationMs: 1200, interruptible: true },
    ],
  },
});
console.log('ear chain:', JSON.stringify(ear));

// 2) 怒：单参数（AngryMove）——不预设 AngryMove1-8 分工
const angry = repo.createActionChain({
  semanticKey: 'motion.angry_flash_single',
  description: '生气单参闪现（AngryMove）——视觉职责未确认，仅单参最小探针链',
  emotion: 'angry',
  actor: 'runtime-probe-seed',
  provenance: PROVENANCE([6, 14, 15, 16, 17, 18, 19, 20]),
  chain: {
    chain_id: 'chain-angry-flash-single-1',
    schemaVersion: '1.0.0',
    loop: false,
    steps: [
      { kind: 'keyframes', params: { track: 'angryFlash', keys: [{ t: 0, value: 0 }, { t: 300, value: 1 }, { t: 900, value: 0 }] }, durationMs: 900, interruptible: true },
    ],
  },
});
console.log('angry chain:', JSON.stringify(angry));

// 3) 绑定（fail-closed 校验参数都在注册表；upsertMotionBinding 返回 undefined 属正常）
bindMotionToModel(db, {
  motionId: ear.motionId, modelId: MODEL_ID,
  adapter: {
    channels: {
      ear_left: [{ paramId: 'LEar1', weight: 1 }],
      ear_right: [{ paramId: 'REar1', weight: 1 }],
    },
    notes: '仅绑单参探针 PASS 参数；耳族其余（LEar2/3, REar2/3）待视觉归因后进正式桥接',
  },
  notes: 'probe-confirmed: probe_run 5 (LEar1), 11 (REar1)',
});
console.log('ear binding inserted');

bindMotionToModel(db, {
  motionId: angry.motionId, modelId: MODEL_ID,
  adapter: {
    channels: { angry_flash: [{ paramId: 'AngryMove', weight: 1 }] },
    notes: 'AngryMove1-8 职责逐参视觉确认前，仅 AngryMove 单参',
  },
  notes: 'probe-confirmed: probe_run 6 (AngryMove)',
});
console.log('angry binding inserted');
console.log('SEEDED earMotionId=%s angryMotionId=%s', ear.motionId, angry.motionId);
