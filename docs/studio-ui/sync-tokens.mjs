/**
 * 把 docs/studio-ui/studio-tokens.css 的标记块同步到下游分发文件。
 * 用法：node docs/studio-ui/sync-tokens.mjs
 * 幂等：已有标记块则整体替换，没有则追加；保持各目标文件原有换行风格。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const src = fs.readFileSync(path.join(here, 'studio-tokens.css'), 'utf8');
const begin = '/* ===== BEGIN STUDIO TOKENS v1 =====';
const end = '/* ===== END STUDIO TOKENS v1 ===== */';
const a = src.indexOf(begin);
const b = src.indexOf(end);
if (a < 0 || b < 0 || b < a) throw new Error('真源标记缺失');
const block = src.slice(a, b + end.length);

const targets = [
  'packages/dsh-l2d-plugin/assets/ui-tokens.css',
  'apps/stage-web/src/styles/ui-tokens.css',
];

for (const rel of targets) {
  const file = path.join(root, rel);
  let text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const normalized = block.replace(/\r?\n/g, eol);
  const hasBegin = text.indexOf(begin);
  const hasEnd = text.indexOf(end);
  if (hasBegin >= 0 && hasEnd > hasBegin) {
    text = text.slice(0, hasBegin) + normalized + text.slice(hasEnd + end.length);
  } else {
    if (!text.endsWith(eol)) text += eol;
    text += eol + normalized + eol;
  }
  fs.writeFileSync(file, text);
  console.log('SYNC OK  ' + rel + '  (' + normalized.length + ' chars, eol=' + JSON.stringify(eol) + ')');
}
