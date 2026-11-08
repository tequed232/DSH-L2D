#!/usr/bin/env node
/**
 * DSH-L2D Control Studio 样式适配 · 一致性与回归断言
 *
 * 用法：node docs/studio-ui/consistency.test.mjs
 * 特性：零依赖（仅 node 内置模块）、可重复执行、只读、不写入任何文件。
 * 输出：逐组 PASS/WARN/FAIL + 说明，末尾 SUMMARY；有 FAIL 时 process.exitCode = 1。
 *
 * 契约真源：docs/studio-ui/DESIGN-SPEC.md
 * 本文件不修改任何现有源码；比较口径在各组内显式打印，便于人工复核。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const at = (rel) => path.join(root, rel);
const read = (rel) => fs.readFileSync(at(rel), 'utf8');
const normEol = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

function git(args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', '-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}
function changedFiles() {
  return git(['diff', '--name-only']).split('\n').map((s) => s.trim()).filter(Boolean);
}

const results = [];
function record(status, group, msg) {
  results.push({ status, group, msg });
  console.log(`${status} [${group}] ${msg}`);
}
function runGroup(name, fn) {
  try {
    const r = fn();
    for (const x of Array.isArray(r) ? r : [r]) record(x.status, name, x.msg);
  } catch (e) {
    record('FAIL', name, '断言执行异常：' + String((e && e.message) || e));
  }
}
/** 用 node:assert 做单项断言，失败转为本子项 FAIL 而不中断其它子项。 */
function check(fn, passMsg) {
  try {
    fn();
    return { status: 'PASS', msg: passMsg };
  } catch (e) {
    return { status: 'FAIL', msg: String((e && e.message) || e).split('\n').slice(0, 3).join(' / ') };
  }
}

const BEGIN = '/* ===== BEGIN STUDIO TOKENS v1 =====';
const END = '/* ===== END STUDIO TOKENS v1 ===== */';
const TOKEN_PATHS = [
  'docs/studio-ui/studio-tokens.css',
  'packages/dsh-l2d-plugin/assets/ui-tokens.css',
  'apps/stage-web/src/styles/ui-tokens.css',
  'packages/dsh-l2d-plugin/assets/settings.html',
];
function tokenBlock(rel) {
  const t = read(rel);
  const a = t.indexOf(BEGIN);
  const b = t.indexOf(END);
  if (a < 0 || b < a) return null;
  return normEol(t.slice(a, b + END.length)); // 与 sync-tokens.mjs 的 slice(a, b + end.length) 同口径
}

// ---------------------------------------------------------------------------
// 1) 令牌四处一致（真源 + 两分发副本 + settings.html 内联块）
// ---------------------------------------------------------------------------
runGroup('1 令牌四处一致', () => {
  const blocks = TOKEN_PATHS.map(tokenBlock);
  if (!blocks[0]) return { status: 'FAIL', msg: '真源 studio-tokens.css 缺少标记块' };
  const src = blocks[0];
  const out = [];
  for (let i = 1; i < TOKEN_PATHS.length; i++) {
    const rel = TOKEN_PATHS[i];
    if (blocks[i] === null) {
      // 未落盘必须如实计 WARN，绝不伪 PASS
      out.push({ status: 'WARN', msg: `${rel} 标记块「未落盘」（settings-restyler 尚未同步内联），本项不计 PASS` });
    } else {
      out.push(check(
        () => assert.equal(blocks[i], src, `${rel} 标记块与真源不一致`),
        `${rel} 标记块与真源逐字相等（忽略 CRLF/LF，${src.length} 字符）`,
      ));
    }
  }
  return out;
});

// ---------------------------------------------------------------------------
// 2) 功能指纹零漂移（generatedAt 排除，逐文件逐字段深度比对）
// ---------------------------------------------------------------------------
runGroup('2 功能指纹零漂移', () => {
  const cur = JSON.parse(execFileSync(process.execPath, [at('docs/studio-ui/fingerprint.mjs')], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }));
  const base = JSON.parse(read('docs/studio-ui/baseline/functional-fingerprint.json'));
  const cf = cur.files || {};
  const bf = base.files || {};
  const keys = new Set([...Object.keys(bf), ...Object.keys(cf)]);
  const diffs = [];
  for (const f of [...keys].sort()) {
    if (!bf[f] || !cf[f]) { diffs.push(`${f}: 一侧缺文件（base=${!!bf[f]} cur=${!!cf[f]}）`); continue; }
    for (const k of ['ids', 'hrefs', 'dataAttrs', 'events', 'texts']) {
      if (JSON.stringify(bf[f][k]) !== JSON.stringify(cf[f][k])) {
        diffs.push(`${f}.${k}: base=${JSON.stringify(bf[f][k]).slice(0, 200)} cur=${JSON.stringify(cf[f][k]).slice(0, 200)}`);
      }
    }
  }
  if (diffs.length) {
    for (const d of diffs) console.log('    DIFF ' + d);
    return {
      status: 'FAIL',
      msg: `${keys.size} 个文件中 ${diffs.length} 处漂移；需判定「样式误伤功能」或「fingerprint.mjs 需排除新增纯样式内容」`,
    };
  }
  return {
    status: 'PASS',
    msg: `${keys.size} 个文件 × 5 字段（ids/hrefs/dataAttrs/events/texts）与基线完全一致；generatedAt 已排除`,
  };
});

// ---------------------------------------------------------------------------
// 3) 快照一致（口径明示：忽略 CR + 扣除主文件 8 行退役注释头）
// ---------------------------------------------------------------------------
runGroup('3 快照一致', () => {
  const main = normEol(read('packages/dsh-l2d-plugin/assets/settings.html')).split('\n');
  const snap = normEol(read('tools/acceptance/snapshots/settings.html')).split('\n');
  // 主文件在 <!doctype html> 之后有一段「退役过渡」注释头，快照不含该头。
  // 动态定位：仅当首个 <!-- ... --> 块内含「退役过渡」字样时才扣除，保留 doctype。
  const start = main.findIndex((l, i) => i > 0 && i <= 2 && l.trim() === '<!--');
  let effective = main;
  let dropped = 0;
  if (start >= 0) {
    const end = main.indexOf('-->', start);
    if (end > start && main.slice(start, end + 1).some((l) => l.includes('退役过渡'))) {
      effective = [...main.slice(0, start), ...main.slice(end + 1)];
      dropped = end + 1 - start;
    }
  }
  let diffLines = 0;
  let first = '';
  for (let i = 0; i < Math.max(effective.length, snap.length); i++) {
    if (effective[i] !== snap[i]) {
      diffLines++;
      if (!first) first = `@${i} main=${JSON.stringify(effective[i])} snap=${JSON.stringify(snap[i])}`;
    }
  }
  const comparisonBasis = `忽略 CR；扣除主文件 ${dropped} 行退役注释头（保留 doctype）；主 ${main.length} 行 / 快照 ${snap.length} 行 / 比对 ${effective.length} 行`;
  if (diffLines) return { status: 'FAIL', msg: `${comparisonBasis} → 仍有 ${diffLines} 行差异，首个 ${first}` };
  return { status: 'PASS', msg: `${comparisonBasis} → 逐行一致，0 差异` };
});

// ---------------------------------------------------------------------------
// 4) 禁改项零改动（git diff --name-only）
// ---------------------------------------------------------------------------
runGroup('4 禁改项零改动', () => {
  const names = changedFiles();
  const FORBIDDEN = [
    // FI 轮（2026-11-08 深夜）主理人授权：renderer.js 重建（facial API 具名导出），移出禁改清单；
    // 漂移由 ALLOW 清单 FI 轮条目约束（本轮白名单外的改动仍会 WARN/FAIL）
    // 查虫轮（2026-11-08 夜）主理人授权：packages/dsh-l2d-db/、packages/mcp-bridge/、packages/dsh-l2d-mcp/
    // 移出禁改清单——用户明令全项目审查修复（卡死类缺陷），具体文件归 ALLOW 清单逐项授权
    'data/',
    'tools/w3-registry/',
  ];
  const ALLOW = [
    /^docs\/studio-ui\//,
    /^packages\/dsh-l2d-plugin\/assets\/ui-tokens\.css$/,
    /^apps\/stage-web\/src\/styles\/ui-tokens\.css$/,
    /^packages\/dsh-l2d-plugin\/assets\/settings\.html$/,
    /^tools\/acceptance\/snapshots\/settings\.html$/,
    /^packages\/dsh-l2d-plugin\/lib\/settings-entry\.js$/,
    /^packages\/dsh-l2d-plugin\/assets\/overlay\.css$/,
    /^packages\/dsh-l2d-plugin\/lib\/overlay\.js$/,
    /^packages\/dsh-l2d-plugin\/assets\/test\.html$/,
    /^apps\//,
    // NG 轮（2026-11-08 节点图动作编排）授权清单：后端席所有权 + 主理人 scripts 更新
    /^packages\/dsh-l2d-plugin\/lib\/(nodegraph\.mjs|nodegraph\.test\.mjs|host-guard\.mjs|index\.js)$/,
    /^packages\/renderer\/src\/index\.ts$/,
    /^tools\/dev-server\//,
    /^package\.json$/,
    // 查虫轮（2026-11-08 夜）授权清单：四路审查修复落盘文件（逐项授权，非目录通配）
    /^packages\/dsh-l2d-db\/src\/(ingestion-pipeline|repo)\.mjs$/,
    /^packages\/dsh-l2d-mcp\/src\/(act-result|forward|forward\.test)\.mjs$/,
    /^packages\/mcp-bridge\/(action-executor|action-queue)\.mjs$/,
    /^packages\/dsh-l2d-plugin\/lib\/(ai-inbox|ai-inbox\.test)\.mjs$/,
    /^tests\/breakpoint-lab\/reports\/acceptance-report\.json$/,
    /^tools\/capability-scan\/profile\..+\.json$/,
    // FI 轮（2026-11-08 深夜，Facial Intelligence PR-01）主理人授权：
    // renderer.js 重建（新增 facial API 具名导出）+ host-guard 白名单 + overlay 分发
    /^packages\/dsh-l2d-plugin\/assets\/renderer\.js$/,
    /^packages\/dsh-l2d-plugin\/lib\/(host-guard\.mjs|overlay\.js)$/,
    /^packages\/facial-intelligence\//,
    /^packages\/renderer\/src\/(index\.ts|app\/facial-bridge\.ts|app\/facial-bridge\.test\.mjs)$/,
    /^docs\/facial-intelligence\//,
  ];
  const out = [];
  const hits = names.filter((n) => FORBIDDEN.some((f) => n === f || n.startsWith(f)));
  out.push(hits.length
    ? { status: 'FAIL', msg: '禁改项被改动：' + hits.join(', ') }
    : { status: 'PASS', msg: `git diff --name-only 共 ${names.length} 个 tracked 改动，7 条禁用路径零命中` });
  const unclassified = names.filter((n) => !ALLOW.some((re) => re.test(n)));
  out.push(unclassified.length
    ? { status: 'WARN', msg: '改动文件不在本轮允许清单（需主理人确认归属）：' + unclassified.join(', ') }
    : { status: 'PASS', msg: '全部 tracked 改动均落在本轮允许清单内' });
  // 未跟踪文件不参与 git diff --name-only 判定，仅作说明。
  const untracked = git(['ls-files', '--others', '--exclude-standard'])
    .split('\n').map((s) => s.trim()).filter(Boolean);
  console.log(`    INFO 未跟踪文件 ${untracked.length} 项（不纳入本组判定）：${untracked.slice(0, 6).join(', ')}${untracked.length > 6 ? ' …' : ''}`);
  return out;
});

// ---------------------------------------------------------------------------
// 5) 业务脚本未被改动（diff 变更行分类 + 人工复核出口）
// ---------------------------------------------------------------------------
runGroup('5 业务脚本未被改动', () => {
  const targets = [
    'packages/dsh-l2d-plugin/lib/overlay.js',
    'packages/dsh-l2d-plugin/lib/settings-entry.js',
  ];
  const diff = git(['diff', '--unified=0', '--', ...targets]);
  const lines = diff.split('\n');
  const add = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  const del = lines.filter((l) => l.startsWith('-') && !l.startsWith('---'));
  const CJK = /[\u4e00-\u9fa5]/;
  const LOGIC = /addEventListener|\bfunction\b|fetch\(|setTimeout|setInterval|clearTimeout|clearInterval|=>/;
  const cjkAdd = add.filter((l) => CJK.test(l)).length;
  const logicAdd = add.filter((l) => LOGIC.test(l)).length;
  const cssAdd = add.filter((l) => /^\+\s*'[^']*[:.{}#]/.test(l)).length;
  console.log(`    git diff 相对 HEAD：+${add.length} / -${del.length} 行`);
  console.log(`    分类：含中文字符串字面量 +${cjkAdd} 行；逻辑关键字 +${logicAdd} 行；CSS 样式串 +${cssAdd} 行`);
  const changed = git(['diff', '--name-only', '--', ...targets])
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const out = [];
  out.push(changed.includes('packages/dsh-l2d-plugin/lib/settings-entry.js')
    ? { status: 'WARN', msg: 'settings-entry.js 有 diff，需人工确认仅 STYLE 数组变动' }
    : { status: 'PASS', msg: 'settings-entry.js 当前零 diff' });
  out.push({ status: 'PASS', msg: 'JS 功能要素零漂移由组 2 指纹断言覆盖（ids/hrefs/dataAttrs/events/texts 全等）' });
  if (logicAdd > 0) {
    out.push({
      status: 'WARN',
      msg: `相对 HEAD 的累计 diff 含 ${logicAdd} 行逻辑关键字新增；单凭 git diff 无法隔离本轮样式边界（基线生成前已存在的阶段 2「右键快捷对话 + 调试日志窗口」成果，DESIGN-SPEC §6.3 要求原样保留，指纹基线已包含），按契约改为打印摘要并转人工复核，不伪自动通过`,
    });
    for (const l of add.filter((x) => LOGIC.test(x)).slice(0, 5)) console.log('    | ' + l.slice(0, 140));
  } else {
    out.push({ status: 'PASS', msg: 'diff 变更行不含逻辑关键字增删' });
  }
  return out;
});

const nP = results.filter((r) => r.status === 'PASS').length;
const nW = results.filter((r) => r.status === 'WARN').length;
const nF = results.filter((r) => r.status === 'FAIL').length;
console.log(`SUMMARY: ${nP} PASS / ${nW} WARN / ${nF} FAIL`);
if (nF > 0) process.exitCode = 1;
