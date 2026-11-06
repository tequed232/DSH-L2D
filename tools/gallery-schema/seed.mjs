#!/usr/bin/env node
/**
 * 图库语义流水线种子（幂等，可重复运行）
 *
 * 1) 注册三个提示词模板（与 docs/图库语义分析流水线.md §3 正文一致）
 * 2) 写入首批标注：dafeiyu-mature-character-sheet.png（来自 2026-11-04 总控目视设定表）
 *
 * 用法：node tools/gallery-schema/seed.mjs [--db <数据库路径>]
 */
import { openDb } from '../../packages/dsh-l2d-db/src/db.mjs';
import { upsertPromptTemplate, upsertGalleryLabel, upsertGalleryItem } from '../../packages/dsh-l2d-db/src/repo.mjs';

const args = process.argv.slice(2);
const dbIdx = args.indexOf('--db');
const db = openDb(dbIdx >= 0 ? { path: args[dbIdx + 1] } : { startDir: process.cwd() });

const SCHEMA_REF = 'tools/gallery-schema/semantic-label.schema.json';
const PARAM_REF = 'tools/gallery-schema/reference/dafeiyu-parameters.txt';

// ---------------------------------------------------------------- 提示词模板

const TEMPLATES = [
  {
    templateId: 'gallery-character-sheet-v1',
    version: '1.0.0',
    targetClass: 'character_sheet',
    body: `你是 Live2D 角色设定表标注员。对输入的设定表图像执行以下任务，只依据图内可见事实，禁止想象图中不存在的部件。

任务：
1. 部件清单：逐一列出可见的身体/装饰部件（发、耳、尾、鳍、服装件、配饰、鞋袜），每个部件给出出现区域（三视图-正面/侧面/背面 或 细节窗N）。
2. 视图对应：说明设定表包含哪几个视图，各视图展示的部件差异（如背面可见蝴蝶结与尾巴全貌）。
3. 文字标注：抄录图中所有文字标签（有则录，无则不录），凡抄录的标签 evidenceLevel=source_exact 且 evidence.quote=原文。
4. 配色：主色/辅色（hex 估值，标 inferred）。
5. 动态暗示：哪些部件天然适合做摆动/物理（如尾巴、裙摆、后发），只列出，不绑定参数。

输出：符合 ${SCHEMA_REF} 的 JSON。fileName 由调用方提供。所有 value 用 snake_case。`,
  },
  {
    templateId: 'gallery-static-art-v1',
    version: '1.0.0',
    targetClass: 'fan_art',
    body: `你是 Live2D 角色参考图标注员（适用于 fan_art/screenshot/photo/poster）。对输入图像：

1. 表情（expression）：识别面部表情（如 smile/smirk/blush/cry/angry），每项给 confidence。
2. 姿态（pose）：描述身体姿态（如 hand_on_cheek/standing/arms_crossed），只描述看得见的。
3. 服装（outfit）：与设定表词表比对；出现设定表中不存在的服装变体时照实记录，不强行套用。
4. 部件（part）：仅当部件清晰可见且与设定表部件一致时记录，value 沿用设定表词表；linkedNodeKey 仅在词表能对应 ${PARAM_REF} 中真实参数族时填写，否则留空。
5. 画风/场景（style/scene）：简短记录。
6. 角色一致性：若图像主体明显不是目标角色（大肥鱼/蓝发女仆鲸鱼娘），在 notes 说明并标记 review_state=pending 退回，不产出标签。

输出：符合 ${SCHEMA_REF} 的 JSON。不确定的项宁可漏标（少标不罚，错标罚）。`,
  },
  {
    templateId: 'gallery-gif-motion-v1',
    version: '1.0.0',
    targetClass: 'gif_reference',
    body: `你是动作参考分析员（适用于 gif_reference）。对输入 GIF：

1. 动作分解：把动效分解为相位（如 蓄力-爆发-回弹），标注各相位大致时长占比。
2. 运动线索（motion_cue）：每相位一条，value 用 snake_case（如 tail_swing/skirt_flare/bounce）。
3. 幅度与循环：判断是否循环、节奏快慢（快/中/慢）。
4. 参数族假设：对照 ${PARAM_REF} 中的真实参数族（如 Skirt*、Movement*、AngryMove、SweatBurst），给出可能的实现参数族候选（evidenceLevel=inferred，confidence<=0.6）；禁止断言具体绑定——绑定验证属 Model Inspector 的 probe_runs，不由图库标注裁决。

输出：符合 ${SCHEMA_REF} 的 JSON。`,
  },
];

for (const t of TEMPLATES) {
  upsertPromptTemplate(db, { ...t, status: 'active', schemaRef: SCHEMA_REF });
  console.log(`[template] ${t.templateId}@${t.version} -> active`);
}

// ---------------------------------------------------------------- 首批标注（设定表）

const SHEET = 'dafeiyu-mature-character-sheet.png';
const item = db.prepare('SELECT id, review_state FROM gallery_items WHERE file_name = ?').get(SHEET);
if (!item) {
  console.error(`[seed] 未找到 ${SHEET}，请先运行 scan.mjs`);
  process.exit(1);
}

// 目视事实（2026-11-04 总控直接查看设定表图像）：三视图（正/侧/背）+ 6 个细节窗。
// 设定表本身是自我描述材料：部件可见性记 source_exact；画风/配色推断记 inferred。
const SEEDS = [
  { field: 'part', value: 'whale_tail', evidence: { region: '三视图-侧面/背面', note: '蓝色鲸尾鳍，背面视图全貌' }, linkedParamFamily: null },
  { field: 'part', value: 'whale_fin_ears', evidence: { region: '头部两侧', note: '鲸鳍状耳发翼' } },
  { field: 'part', value: 'maid_headdress', evidence: { region: '头顶', note: '白色荷叶边头饰' } },
  { field: 'part', value: 'long_wavy_hair', evidence: { region: '全身', note: '蓝色长卷发，背面过腰' } },
  { field: 'part', value: 'whale_embroidery', evidence: { region: '细节窗2', note: '围裙上的鲸鱼刺绣' } },
  { field: 'part', value: 'blue_bow_accessories', evidence: { region: '头部/胸前/背部', note: '多处蓝色蝴蝶结' } },
  { field: 'outfit', value: 'navy_maid_dress', evidence: { region: '三视图-正面', note: '深蓝女仆装+金线纹样' } },
  { field: 'outfit', value: 'white_apron', evidence: { region: '三视图-正面', note: '双层荷叶边围裙' } },
  { field: 'outfit', value: 'white_tights_black_shoes', evidence: { region: '细节窗6', note: '白袜+黑玛丽珍高跟鞋' } },
  { field: 'pose', value: 'three_view_standing', evidence: { region: '全图', note: '正/侧/背三视站姿' } },
  { field: 'expression', value: 'smile_open_mouth', evidence: { region: '正面+细节窗1', note: '张口笑' } },
  { field: 'color', value: 'navy_white_blue_palette', confidence: 0.9, evidenceLevel: 'inferred' },
  { field: 'style', value: 'anime_soft_shading', confidence: 0.8, evidenceLevel: 'inferred' },
];

let labeled = 0;
for (const s of SEEDS) {
  upsertGalleryLabel(db, {
    itemId: item.id,
    field: s.field,
    value: s.value,
    confidence: s.confidence ?? (s.evidenceLevel === 'source_exact' ? 1.0 : 0.8),
    evidenceLevel: s.confidence ? 'inferred' : 'source_exact',
    evidence: s.evidence,
    reviewState: 'needs_review',
    linkedNodeId: null, // 桥接待 Model Inspector 注册 nodes 后回填
  });
  labeled += 1;
}
upsertGalleryItem(db, {
  fileName: SHEET, realFormat: 'png', ext: 'png',
  width: db.prepare('SELECT width FROM gallery_items WHERE file_name=?').get(SHEET).width,
  height: db.prepare('SELECT height FROM gallery_items WHERE file_name=?').get(SHEET).height,
  sizeBytes: db.prepare('SELECT size_bytes FROM gallery_items WHERE file_name=?').get(SHEET).size_bytes,
  sha256: db.prepare('SELECT sha256 FROM gallery_items WHERE file_name=?').get(SHEET).sha256,
  sourceClass: 'character_sheet', reviewState: 'labeled',
  notes: '首批标注完成（种子）；动态暗示：鲸尾/裙摆/后发适合物理摆动',
});
console.log(`[seed] ${SHEET}: ${labeled} 条标签写入（needs_review）`);
db.close();
