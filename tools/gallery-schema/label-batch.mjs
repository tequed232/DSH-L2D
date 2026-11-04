#!/usr/bin/env node
/**
 * 批量标注入库脚本（幂等）
 *
 * 读取 batches/*.json（gallery-static-art-v1 模板的人工/目视标注批），
 * 校验 field/evidenceLevel 枚举，写入 gallery_labels（needs_review）。
 * reclassify=true 时回写 gallery_items.source_class；reject=true 时仅登记 notes。
 *
 * 用法：node tools/gallery-schema/label-batch.mjs <batch.json> [--db <路径>]
 */
import fs from 'node:fs';
import { openDb } from '../../packages/dsh-l2d-db/src/db.mjs';
import { upsertGalleryLabel, upsertGalleryItem, GALLERY_LABEL_FIELDS, GALLERY_SOURCE_CLASSES } from '../../packages/dsh-l2d-db/src/repo.mjs';

const args = process.argv.slice(2);
const file = args[0];
if (!file) {
  console.error('用法：node tools/gallery-schema/label-batch.mjs <batch.json> [--db <路径>]');
  process.exit(2);
}
const dbIdx = args.indexOf('--db');
const db = openDb(dbIdx >= 0 ? { path: args[dbIdx + 1] } : { startDir: process.cwd() });

const batch = JSON.parse(fs.readFileSync(file, 'utf8'));
let labels = 0, relabeled = 0, rejected = 0, skipped = 0;

for (const item of batch.items) {
  const row = db.prepare('SELECT id FROM gallery_items WHERE file_name = ?').get(item.fileName);
  if (!row) {
    console.warn(`[skip] 未登记: ${item.fileName}`);
    skipped += 1;
    continue;
  }
  if (item.reject) {
    upsertGalleryItem(db, {
      fileName: item.fileName,
      realFormat: db.prepare('SELECT real_format FROM gallery_items WHERE file_name=?').get(item.fileName).real_format,
      ext: db.prepare('SELECT ext FROM gallery_items WHERE file_name=?').get(item.fileName).ext,
      sourceClass: 'other',
      reviewState: 'rejected',
      notes: `batch ${batch.batchId}: ${item.note}`,
    });
    rejected += 1;
    continue;
  }
  if (item.reclassify) {
    if (!GALLERY_SOURCE_CLASSES.includes(item.reclassify)) throw new Error(`非法 reclassify: ${item.reclassify}`);
    const cur = db.prepare('SELECT * FROM gallery_items WHERE file_name=?').get(item.fileName);
    upsertGalleryItem(db, { fileName: item.fileName, realFormat: cur.real_format, ext: cur.ext, width: cur.width, height: cur.height, sizeBytes: cur.size_bytes, sha256: cur.sha256, sourceClass: item.reclassify, reviewState: 'labeled', notes: `batch ${batch.batchId}: ${item.note ?? ''}` });
    relabeled += 1;
  }
  for (const l of item.labels ?? []) {
    if (!GALLERY_LABEL_FIELDS.includes(l.field)) throw new Error(`${item.fileName}: 非法 field ${l.field}`);
    if (!['source_exact', 'parser_derived', 'inferred'].includes(l.evidenceLevel ?? 'inferred')) throw new Error(`${item.fileName}: 非法 evidenceLevel`);
    upsertGalleryLabel(db, {
      itemId: row.id,
      field: l.field,
      value: l.value,
      confidence: l.confidence ?? null,
      evidenceLevel: l.evidenceLevel ?? 'inferred',
      evidence: { batch: batch.batchId, promptTemplate: batch.promptTemplate, promptVersion: batch.promptVersion, annotator: batch.annotator, ...(l.evidence ?? {}), ...(l.note ? { note: l.note } : {}) },
      reviewState: 'needs_review',
    });
    labels += 1;
  }
  if (!item.reclassify) {
    const cur = db.prepare('SELECT review_state FROM gallery_items WHERE file_name=?').get(item.fileName);
    if (cur.review_state === 'pending') {
      const c2 = db.prepare('SELECT * FROM gallery_items WHERE file_name=?').get(item.fileName);
      upsertGalleryItem(db, { fileName: item.fileName, realFormat: c2.real_format, ext: c2.ext, width: c2.width, height: c2.height, sizeBytes: c2.size_bytes, sha256: c2.sha256, sourceClass: c2.source_class, reviewState: 'labeled', notes: c2.notes });
    }
  }
}

const snap = db.prepare(`
  SELECT source_class AS cls, review_state AS st, COUNT(*) AS n FROM gallery_items GROUP BY source_class, review_state
`).all();
console.log(JSON.stringify({ batch: batch.batchId, labelsWritten: labels, reclassified: relabeled, rejected, skipped, itemStates: snap }, null, 1));
db.close();
