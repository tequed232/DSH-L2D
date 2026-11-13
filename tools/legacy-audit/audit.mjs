#!/usr/bin/env node
/**
 * Phase 0 · Legacy Runtime Dependency Audit
 *
 * 目的：把"删除清单"从**按模块名猜**变成**按 import 图判定**。
 * 对每个候选目标输出：
 *   - inRefs：谁 import 它（文件级）
 *   - outRefs：它 import 谁
 *   - runtimeReachable：从运行期入口出发能否到达（BFS）
 *   - importTimeOnly：是否只被导入期工具（tools/*）引用
 *   - testRefs：被哪些测试引用
 *   - verdict：keep / keep-import-time / detach-first / delete-safe / review
 *
 * 用法：
 *   node tools/legacy-audit/audit.mjs                 # 人读表格
 *   node tools/legacy-audit/audit.mjs --json          # 机器可读
 *   node tools/legacy-audit/audit.mjs --write         # 写 docs/architecture/LEGACY-DEPENDENCY-AUDIT.md + audit.json
 *
 * 判定原则（与 docs/architecture/ONESHOT-COMPILER-ASSESSMENT.md §5 Phase 0 一致）：
 *   · 运行期可达 → 不允许直接删，先"关入口"；
 *   · 仅导入期引用 → 保留（它是编译期资产，不是运行时包袱）；
 *   · 仅测试引用 → delete-safe；
 *   · 运行期可达且被受保护层（renderer/core 公共契约）引用 → detach-first。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

const SCAN_EXTS = new Set(['.mjs', '.js', '.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.qa-tmp', '.workbuddy']);

/** 运行期入口：宿主插件、MCP server、bridge、renderer 应用层。 */
const RUNTIME_ENTRIES = [
  'packages/dsh-l2d-plugin/lib/index.js',
  'packages/dsh-l2d-mcp/src/server.mjs',
  'packages/mcp-bridge/index.mjs',
  'packages/renderer/src/index.ts',
  'packages/renderer/src/app/main.ts',
];

/** 方案 §2 的候选清单（P0/P1/P2），路径相对仓库根。
 *  role 决定判定口径——"运行期可达"不等于"该删"：
 *    behavior  = 运行期行为决策（方案目标：退出运行时）
 *    plumbing  = 执行管道/编译期适配（**必须保留**，只需划边界）
 *    renderer  = 受保护渲染层通道（只能降级，不能直接删）
 */
export const TARGETS = [
  { id: 'core.planner', path: 'packages/core/src/planner', tier: 'P0', role: 'behavior' },
  { id: 'core.cue-loop', path: 'packages/core/src/cue-loop.ts', tier: 'P0', role: 'behavior' },
  { id: 'core.embodied-cue', path: 'packages/core/src/embodied-cue.ts', tier: 'P0', role: 'behavior' },
  { id: 'core.motion-intent', path: 'packages/core/src/motion-intent.ts', tier: 'P0', role: 'behavior' },
  { id: 'core.semantic-binding', path: 'packages/core/src/semantic-binding.ts', tier: 'P0', role: 'behavior' },
  { id: 'plugin.workspace-agent', path: 'packages/dsh-l2d-plugin/lib/workspace-agent.mjs', tier: 'P0', role: 'behavior' },
  { id: 'plugin.context-analyzer', path: 'packages/dsh-l2d-plugin/lib/context-analyzer.mjs', tier: 'P0', role: 'behavior' },
  { id: 'plugin.choreography', path: 'packages/dsh-l2d-plugin/lib/choreography.mjs', tier: 'P1', role: 'behavior' },
  { id: 'core.continuous-action', path: 'packages/core/src/continuous-action.ts', tier: 'P1', role: 'behavior' },
  // 编译期 LLM 适配器 + 执行通道：方案说"移除运行时依赖"，但代码上必须留着，
  // 要做的是"限制调用边界"（编译路由可用、派发路径不可用），不是删文件。
  { id: 'plugin.llm-channel', path: 'packages/dsh-l2d-plugin/lib/llm-channel.mjs', tier: 'P1', role: 'plumbing' },
  { id: 'plugin.nodegraph-ai', path: 'packages/dsh-l2d-plugin/lib/nodegraph-ai.mjs', tier: 'P1', role: 'plumbing' },
  { id: 'plugin.ai-inbox', path: 'packages/dsh-l2d-plugin/lib/ai-inbox.mjs', tier: 'P1', role: 'plumbing' },
  { id: 'renderer.cue-bridge', path: 'packages/renderer/src/app/cue-bridge.ts', tier: 'P1', role: 'renderer' },
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (SCAN_EXTS.has(path.extname(entry.name))) out.push(abs);
  }
  return out;
}

const IMPORT_RE = /(?:import\s+(?:[\s\S]*?)\s+from\s*|import\s*|export\s+(?:[\s\S]*?)\s+from\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

/** 解析一个 import 说明符到仓库内绝对路径（含扩展名候选与 /index）。 */
function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // 只跟仓库内相对引用
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base];
  if (!path.extname(base)) {
    for (const ext of ['.ts', '.mjs', '.js', '.tsx']) candidates.push(base + ext);
    for (const ext of ['.ts', '.mjs', '.js', '.tsx']) candidates.push(path.join(base, 'index' + ext));
  }
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

/** 建立全仓 import 图：file → Set(resolvedAbs)。 */
export function buildImportGraph(root = REPO_ROOT) {
  const files = [
    ...walk(path.join(root, 'packages')),
    ...walk(path.join(root, 'tools')),
    ...walk(path.join(root, 'tests')),
    ...walk(path.join(root, 'apps')),
  ];
  const graph = new Map();
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const deps = new Set();
    for (const match of text.matchAll(IMPORT_RE)) {
      const resolved = resolveSpecifier(file, match[1]);
      if (resolved) deps.add(resolved);
    }
    graph.set(file, deps);
  }
  return graph;
}

function rel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

function expandTarget(root, targetPath) {
  const abs = path.join(root, targetPath);
  try {
    if (fs.statSync(abs).isDirectory()) return walk(abs);
    if (fs.statSync(abs).isFile()) return [abs];
  } catch {
    return [];
  }
  return [];
}

/** 从运行时入口 BFS，得到可达集合。 */
function reachableFrom(root, graph) {
  const seen = new Set();
  const queue = [];
  for (const entry of RUNTIME_ENTRIES) {
    const abs = path.join(root, entry);
    if (graph.has(abs)) queue.push(abs);
  }
  while (queue.length) {
    const cur = queue.shift();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const dep of graph.get(cur) || []) if (!seen.has(dep)) queue.push(dep);
  }
  return seen;
}

function isTestFile(root, abs) {
  const r = rel(root, abs);
  return r.startsWith('tests/') || /\.test\.(mjs|js|ts)$/.test(r) || r.includes('/test/');
}

function isImportTimeTool(root, abs) {
  const r = rel(root, abs);
  return r.startsWith('tools/');
}

export function auditTargets({ root = REPO_ROOT, targets = TARGETS } = {}) {
  const graph = buildImportGraph(root);
  const reachable = reachableFrom(root, graph);

  // 反向索引：被谁引用
  const reverse = new Map();
  for (const [file, deps] of graph) {
    for (const dep of deps) {
      if (!reverse.has(dep)) reverse.set(dep, new Set());
      reverse.get(dep).add(file);
    }
  }

  const results = [];
  for (const target of targets) {
    const files = expandTarget(root, target.path);
    const inRefs = new Set();
    for (const file of files) for (const ref of reverse.get(file) || []) inRefs.add(ref);

    const allInRefs = [...inRefs].map((f) => rel(root, f)).sort();
    const runtimeRefs = [...inRefs].filter((f) => reachable.has(f)).map((f) => rel(root, f)).sort();
    const testRefs = [...inRefs].filter((f) => isTestFile(root, f)).map((f) => rel(root, f)).sort();
    const importTimeRefs = [...inRefs].filter((f) => isImportTimeTool(root, f)).map((f) => rel(root, f)).sort();

    const outRefs = new Set();
    for (const file of files) for (const dep of graph.get(file) || []) outRefs.add(dep);
    const internal = new Set(files);
    const outExternal = [...outRefs].filter((d) => !internal.has(d)).map((d) => rel(root, d)).sort();

    const runtimeReachable = [...files].some((f) => reachable.has(f)) || runtimeRefs.length > 0;
    const referencedByRenderer = runtimeRefs.some((r) => r.startsWith('packages/renderer/'));

    let verdict;
    let reason;
    if (!files.length) {
      verdict = 'missing';
      reason = '目标路径不存在（可能是方案里写错的名字），需人工确认';
    } else if (target.role === 'plumbing') {
      // 执行管道 / 编译期适配：文件必须留，要做的是限制调用边界
      verdict = 'keep-with-boundary';
      reason = runtimeReachable
        ? `运行期入口引用 ${runtimeRefs.length} 处：保留文件，需确认它只出现在编译/执行通道、不参与行为决策`
        : '未被运行期入口引用：保留（编译期资产）';
    } else if (target.role === 'renderer' || referencedByRenderer) {
      verdict = 'detach-first';
      reason = '被 Renderer 层引用：先降级该通道（保留接口、清空决策），再谈删除';
    } else if (runtimeReachable && runtimeRefs.length) {
      verdict = 'detach-first';
      reason = `运行期可达（${runtimeRefs.length} 个运行入口引用）：先关调用入口、观察命中为 0，再删文件`;
    } else if (testRefs.length) {
      // 只有测试撑着 → 属于"删代码同时删测试"的一步操作，不是"先关入口"
      verdict = 'retire-with-test';
      reason = `无运行期路径，仅被 ${testRefs.length} 个测试引用：删实现时同步删/改测试`;
    } else if (importTimeRefs.length) {
      verdict = 'keep-import-time';
      reason = `仅导入期工具引用（${importTimeRefs.length} 个）：属编译期资产，不是运行时包袱`;
    } else if (!allInRefs.length) {
      verdict = 'delete-safe';
      reason = '无任何引用（死代码）';
    } else {
      verdict = 'review';
      reason = `引用面混合：runtime=${runtimeRefs.length} / import-time=${importTimeRefs.length} / test=${testRefs.length}`;
    }

    results.push({
      id: target.id,
      tier: target.tier,
      role: target.role,
      path: target.path,
      fileCount: files.length,
      runtimeReachable,
      referencedByRenderer,
      runtimeRefs,
      importTimeRefs,
      testRefs,
      inRefs: allInRefs,
      outRefs: outExternal,
      verdict,
      reason,
    });
  }
  return { generatedAt: new Date().toISOString(), root, targets: results };
}

function toMarkdown(report) {
  const lines = [];
  lines.push('# Legacy Runtime Dependency Audit（Phase 0 产物）');
  lines.push('');
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push('- 生成器：`tools/legacy-audit/audit.mjs`（解析真实 import 图 + 从运行期入口 BFS）');
  lines.push('- 判定口径：`detach-first` 先关入口、`keep-import-time` 保留（编译期资产）、`delete-safe` 可删');
  lines.push('');
  lines.push('## 1. 总表');
  lines.push('');
  lines.push('| 目标 | 层级 | 运行期可达 | Renderer 引用 | 运行期引用数 | 导入期引用 | 测试引用 | 判定 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of report.targets) {
    lines.push(
      `| \`${r.id}\` | ${r.tier} | ${r.runtimeReachable ? '是' : '否'} | ${r.referencedByRenderer ? '**是**' : '否'} | ${r.runtimeRefs.length} | ${r.importTimeRefs.length} | ${r.testRefs.length} | **${r.verdict}** |`,
    );
  }
  lines.push('');
  lines.push('## 2. 逐项证据');
  for (const r of report.targets) {
    lines.push('');
    lines.push(`### ${r.id}（${r.tier}）· ${r.verdict}`);
    lines.push('');
    lines.push(`- 路径：\`${r.path}\`（${r.fileCount} 个文件）`);
    lines.push(`- 理由：${r.reason}`);
    if (r.runtimeRefs.length) lines.push(`- 运行期引用：${r.runtimeRefs.map((x) => '`' + x + '`').join(', ')}`);
    if (r.importTimeRefs.length) lines.push(`- 导入期引用：${r.importTimeRefs.map((x) => '`' + x + '`').join(', ')}`);
    if (r.testRefs.length) lines.push(`- 测试引用：${r.testRefs.map((x) => '`' + x + '`').join(', ')}`);
    if (r.outRefs.length) lines.push(`- 依赖：${r.outRefs.slice(0, 12).map((x) => '`' + x + '`').join(', ')}${r.outRefs.length > 12 ? ` …(+${r.outRefs.length - 12})` : ''}`);
  }
  lines.push('');
  lines.push('## 3. 按判定分组的行动项');
  lines.push('');
  const groups = new Map();
  for (const r of report.targets) {
    if (!groups.has(r.verdict)) groups.set(r.verdict, []);
    groups.get(r.verdict).push(r.id);
  }
  for (const [verdict, ids] of groups) {
    lines.push(`- **${verdict}**：${ids.join(', ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const doWrite = argv.includes('--write');
  const report = auditTargets();

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    console.log('Legacy Runtime Dependency Audit');
    console.log(`目标 ${report.targets.length} 项 · 生成于 ${report.generatedAt}`);
    console.log('');
    for (const r of report.targets) {
      console.log(`${r.verdict.padEnd(17)} ${r.id.padEnd(26)} runtime=${r.runtimeReachable ? 'Y' : 'N'} renderer=${r.referencedByRenderer ? 'Y' : 'N'} refs=${r.runtimeRefs.length}/${r.importTimeRefs.length}/${r.testRefs.length}`);
    }
    console.log('');
    const detach = report.targets.filter((r) => r.verdict === 'detach-first').map((r) => r.id);
    const keep = report.targets.filter((r) => r.verdict === 'keep-import-time').map((r) => r.id);
    const del = report.targets.filter((r) => r.verdict === 'delete-safe').map((r) => r.id);
    const retire = report.targets.filter((r) => r.verdict === 'retire-with-test').map((r) => r.id);
    const boundary = report.targets.filter((r) => r.verdict === 'keep-with-boundary').map((r) => r.id);
    console.log(`可直删（delete-safe）: ${del.join(', ') || '无'}`);
    console.log(`必须先关入口（detach-first）: ${detach.join(', ') || '无'}`);
    console.log(`连测试一起退休（retire-with-test）: ${retire.join(', ') || '无'}`);
    console.log(`保留但需划边界（keep-with-boundary）: ${boundary.join(', ') || '无'}`);
    console.log(`应保留为编译期资产（keep-import-time）: ${keep.join(', ') || '无'}`);
  }

  if (doWrite) {
    const outDir = path.join(REPO_ROOT, 'docs', 'architecture');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'audit.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(outDir, 'LEGACY-DEPENDENCY-AUDIT.md'), toMarkdown(report) + '\n', 'utf8');
    console.log('');
    console.log('已写入 docs/architecture/LEGACY-DEPENDENCY-AUDIT.md 与 audit.json');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
