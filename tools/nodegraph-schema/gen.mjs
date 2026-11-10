#!/usr/bin/env node
/**
 * 生成 docs/nodegraph/NODE-SCHEMA.json（机器可读节点说明）。
 * 数据源唯一：packages/dsh-l2d-plugin/lib/nodegraph-schema.mjs 的 buildNodeSchema()，
 * ai-edit 提示词用的是同一个函数，不手抄两份。
 *
 * 用法：
 *   node tools/nodegraph-schema/gen.mjs          # 写文件
 *   node tools/nodegraph-schema/gen.mjs --check  # 只比对，不一致退出码 1（测试用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNodeSchema } from '../../packages/dsh-l2d-plugin/lib/nodegraph-schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCHEMA_FILE = path.join(ROOT, 'docs', 'nodegraph', 'NODE-SCHEMA.json');

export function renderSchema() {
  return JSON.stringify(buildNodeSchema(), null, 2) + '\n';
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const text = renderSchema();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(SCHEMA_FILE) ? fs.readFileSync(SCHEMA_FILE, 'utf8') : '';
    if (current !== text) {
      console.error('NODE-SCHEMA.json 与代码定义不一致，请运行 node tools/nodegraph-schema/gen.mjs');
      process.exit(1);
    }
    console.log('NODE-SCHEMA.json 与代码定义一致');
  } else {
    fs.writeFileSync(SCHEMA_FILE, text, 'utf8');
    console.log('已写入 ' + path.relative(ROOT, SCHEMA_FILE));
  }
}
