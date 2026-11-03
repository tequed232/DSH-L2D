#!/usr/bin/env node
/**
 * 生成 W3 五官标定的 jobs 清单（参数扫描 + 表情 + 冲突组）。
 * 输出 spec 给 run.mjs：node tools/facial-calibration/run.mjs --spec spec.json
 *
 * 用法：node tools/facial-calibration/make-spec.mjs > spec-facial.json
 */
const jobs = [];
const P = (name, params, note = '') => jobs.push({ name, params, note });

// 0) 中性基线
P('cal_baseline', {});

// 1) 眼睑开合（0..1.5，def 1）
for (const v of [0, 0.35, 0.7, 1.5]) {
  P(`cal_eyeOpen_${v}`.replace('.', 'p'), { ParamEyeLOpen: v, ParamEyeROpen: v });
}
// 单侧（验证左右独立）
P('cal_eyeOpen_L0_R1', { ParamEyeLOpen: 0, ParamEyeROpen: 1 });

// 2) 眯眼（0..1）
for (const v of [0.25, 0.5, 0.75, 1]) {
  P(`cal_squint_${v}`.replace('.', 'p'), { LEyeSquint: v, REyeSquint: v });
}

// 3) 笑眼（-1..1）
for (const v of [-1, -0.5, 0.5, 1]) {
  P(`cal_eyeSmile_${String(v).replace('-', 'm').replace('.', 'p')}`, { EyeSmile: v });
}

// 4) 眉毛升降（-1..1），并验证左右独立
for (const v of [-1, -0.5, 0.5, 1]) {
  P(`cal_brow_${String(v).replace('-', 'm').replace('.', 'p')}`, { ParamBrowLY: v, ParamBrowRY: v });
}
P('cal_brow_asym_L1_Rm1', { ParamBrowLY: 1, ParamBrowRY: -1 });

// 5) 眉毛内收（0..1）
for (const v of [0.5, 1]) P(`cal_browInner_${v}`, { BrowInnerUp: v });

// 6) 嘴角（0..1），左右独立
for (const v of [0.5, 1]) P(`cal_mouthSmile_${v}`, { MouthSmile_L: v, MouthSmile_R: v });
P('cal_mouthSmile_asym_L1_R0', { MouthSmile_L: 1, MouthSmile_R: 0 });

// 7) 张嘴（0..1）
for (const v of [0.35, 0.7, 1]) P(`cal_jawOpen_${String(v).replace('.', 'p')}`, { JawOpen: v });

// 8) 鼓腮 / 嘟嘴（0..1）
for (const v of [0.5, 1]) P(`cal_cheekPuff_${v}`, { CheeckPuff: v });
for (const v of [0.5, 1]) P(`cal_mouthPucker_${v}`, { Mouthpucker: v });

// 9) 眼睛族 key3-6（参数直写，验证「同写两个会怎样」）
P('cal_key3_1', { key3: 1 });
P('cal_key4_1', { key4: 1 });
P('cal_key3_1_key4_1', { key3: 1, key4: 1 });
P('cal_key5_1_key6_1', { key5: 1, key6: 1 });
P('cal_key6_1', { key6: 1 });

// 10) Clothes2 体型（0/0.4/1）
P('cal_clothes2_0', { Clothes2: 0 });
P('cal_clothes2_1', { Clothes2: 1 });

// 11) LeanInput（-30/30），并记录 gaze 身体通道同写冲突
P('cal_lean_m30', { LeanInput: -30 });
P('cal_lean_30', { LeanInput: 30 });

// 12) 21 个表情（长时间等待，表情淡入约 1s，headless 帧率偏低）
const EXPRESSIONS = [
  '兔牙', '加载', '单片眼镜', '圈圈眼', '屑', '流泪', '爱心眼', '脱鞋', '脸红', '钢盆',
  '裙长切换', '黑框眼镜', '黑脸', '＞＜', '体型1', '体型2', '默认体型', '前倾', '尾巴开关', '流冷汗', '胸口衣服',
];
for (const name of EXPRESSIONS) {
  jobs.push({ name: `expr_${name}`, params: {}, expr: name, waitMs: 3500 });
}
// 表情互斥组：先爱心眼再圈圈眼（验证切换时的叠加/淡出）
jobs.push({ name: 'expr_switch_heart_then_circle', params: {}, expr: '爱心眼', waitMs: 3500 });
jobs.push({ name: 'expr_switch_heart_then_circle_2', params: {}, expr: '圈圈眼', waitMs: 3500 });
jobs.push({ name: 'expr_clear_after_circle', params: {}, expr: null, waitMs: 3500 });

process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), jobs }, null, 1) + '\n');
