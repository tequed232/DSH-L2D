import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  HIT_SAMPLE_MAX_AGE_MS,
  HIT_SAMPLE_MAX_OFFSET_PX,
  shouldStartDrag,
} from './drag-hit-decision.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---- 用例表：起拖判定两级逻辑 ------------------------------------------------
// ① 样本新鲜且 hitTestAt 命中 → 走原路径（样本优先，不问包围盒）
assert.deepEqual(
  shouldStartDrag({ hitTestAt: true, hitTestBox: false, sampleAvailable: true, sampleAge: 50, sampleOffset: 5 }),
  { start: true, reason: 'sample-hit' },
);

// ② 样本过期（快速移动后点击的典型场景）但包围盒命中 → 起拖
assert.deepEqual(
  shouldStartDrag({ hitTestAt: false, hitTestBox: true, sampleAvailable: true, sampleAge: HIT_SAMPLE_MAX_AGE_MS + 1, sampleOffset: 120 }),
  { start: true, reason: 'sample-unusable-box-hit' },
);

// ②' 采样点距点击点偏差 >16px（渲染包 16px 容差内判定不可靠）→ 包围盒兜底
assert.deepEqual(
  shouldStartDrag({ hitTestAt: false, hitTestBox: true, sampleAvailable: true, sampleAge: 10, sampleOffset: HIT_SAMPLE_MAX_OFFSET_PX + 1 }),
  { start: true, reason: 'sample-unusable-box-hit' },
);

// ③ 双 miss（样本新鲜 + alpha 未命中 + 包围盒未命中）→ 放行到下层页面
assert.deepEqual(
  shouldStartDrag({ hitTestAt: false, hitTestBox: false, sampleAvailable: true, sampleAge: 30, sampleOffset: 5 }),
  { start: false, reason: 'sample-miss' },
);

// ④ 优先级：样本命中优先于包围盒（hitTestAt=true 时即使 box 也 true，原因仍是 sample-hit）
assert.deepEqual(
  shouldStartDrag({ hitTestAt: true, hitTestBox: true, sampleAvailable: true, sampleAge: 0, sampleOffset: 0 }),
  { start: true, reason: 'sample-hit' },
);

// ⑤ 无样本 + 包围盒命中 → 起拖（保守放行互动的旧语义由兜底承接）
assert.deepEqual(
  shouldStartDrag({ hitTestAt: false, hitTestBox: true, sampleAvailable: false }),
  { start: true, reason: 'sample-unusable-box-hit' },
);

// ⑤' 无样本 + 包围盒未命中 → 放行
assert.deepEqual(
  shouldStartDrag({ hitTestAt: false, hitTestBox: false, sampleAvailable: false }),
  { start: false, reason: 'sample-unusable-miss' },
);

// ⑥ 容差边界：偏差/年龄恰好在阈值内视为可用样本，alpha 未命中即真 miss
assert.deepEqual(
  shouldStartDrag({ hitTestAt: false, hitTestBox: false, sampleAvailable: true, sampleAge: HIT_SAMPLE_MAX_AGE_MS, sampleOffset: HIT_SAMPLE_MAX_OFFSET_PX }),
  { start: false, reason: 'sample-miss' },
);

// ⑦ 渲染包缺失 hitTestBox 接口（旧构建）+ hitTestAt 未命中 → 放行（不误吞事件）。
// overlay 传不进采样元数据 → 无负面证据按可用样本处理。
assert.deepEqual(
  shouldStartDrag({ hitTestAt: false, hitTestBox: null }),
  { start: false, reason: 'sample-miss' },
);

// ⑧ legacy：无渲染包命中 API 时保持整盒可交互（旧 overModel 语义）
assert.deepEqual(shouldStartDrag({ legacy: true }), { start: true, reason: 'legacy' });
assert.deepEqual(shouldStartDrag({}), { start: false, reason: 'sample-miss' });
assert.deepEqual(shouldStartDrag(null), { start: false, reason: 'sample-miss' });

// ---- parity：overlay.js 内联副本必须与 mjs 版本行为一致（防两份漂移） ----------
const overlaySrc = readFileSync(path.join(here, 'overlay.js'), 'utf8');
const m = overlaySrc.match(/@drag-hit-decision:inline-start\s*\*\/([\s\S]*?)\/\*\s*@drag-hit-decision:inline-end/);
assert.ok(m, 'overlay.js 缺少 @drag-hit-decision:inline 标记段');
const inlineFn = new Function(m[1] + '\nreturn shouldStartDrag;')();
assert.equal(typeof inlineFn, 'function', '内联段未产出 shouldStartDrag');

const parityCases = [
  { hitTestAt: true, hitTestBox: false, sampleAvailable: true, sampleAge: 50, sampleOffset: 5 },
  { hitTestAt: false, hitTestBox: true, sampleAvailable: true, sampleAge: 9999, sampleOffset: 120 },
  { hitTestAt: false, hitTestBox: true, sampleAvailable: false },
  { hitTestAt: false, hitTestBox: false, sampleAvailable: true, sampleAge: 30, sampleOffset: 5 },
  { hitTestAt: true, hitTestBox: true },
  { hitTestAt: false, hitTestBox: null },
  { legacy: true },
  {},
  null,
];
for (const c of parityCases) {
  assert.deepEqual(inlineFn(c), shouldStartDrag(c), 'parity 不一致: ' + JSON.stringify(c));
}

console.log('drag-hit-decision: all assertions passed');
