#!/usr/bin/env node
// test.html HUD 结构断言检查（无 jsdom，做文本 + 结构断言）
// 用法：node tools/test-html-check.mjs   — exit 0 全部通过，exit 1 有失败
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const file = join(root, 'packages/dsh-l2d-plugin/assets/test.html');
const html = readFileSync(file, 'utf8');

let failed = 0;
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failed++;
}

// 提取 CSS 规则体
function cssRule(selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const m = html.match(re);
  return m ? m[1] : null;
}

const scriptStart = html.lastIndexOf('<script>');
const scriptEnd = html.indexOf('</script>', scriptStart);
const script = html.slice(scriptStart, scriptEnd);

// 1. HUD 容器 pointer-events: none（不拦截交互）
const containerCss = cssRule('#l2d-test-hud');
check('#l2d-test-hud 容器存在 pointer-events: none', !!containerCss && /pointer-events\s*:\s*none/.test(containerCss));

// 2. 折叠条控件 pointer-events: auto（容器 none、控件 auto 分层）
const barCss = cssRule('#l2d-test-hud .hud-bar');
check('.hud-bar 控件存在 pointer-events: auto', !!barCss && /pointer-events\s*:\s*auto/.test(barCss));

// 3. 双实例防御：开头查重 id，已存在则复用不重建
check(
  '脚本开头查重 #l2d-test-hud（已存在则不重复创建）',
  /getElementById\('l2d-test-hud'\)/.test(script) && /已存在则不重复创建/.test(script)
);

// 4. 默认折叠：初始状态由 ?hud=open 决定，无参数 → 折叠
check(
  '初始状态默认折叠，仅 ?hud=open 直展开',
  /get\('hud'\)\s*===\s*'open'/.test(script) && /setHudOpen\(new URLSearchParams\(location\.search\)\.get\('hud'\)\s*===\s*'open'\)/.test(script)
);

// 5. 点击标题条切换展开/收起
check(
  '点击 .hud-bar 切换展开/收起',
  /hudBar\.addEventListener\('click'[\s\S]*?setHudOpen\(hudBody\.style\.display\s*===\s*'none'\)/.test(script)
);

// 6. 旧版常开静态 <div id="hud"> 已移除，不再有裸 #hud 选择器
check('旧版静态 <div id="hud"> 已移除', !/<div id="hud">/.test(html) && !/(^|[^-\w])#hud\s*\{/.test(html));

// 7. 内嵌脚本基础语法可解析（node --check 等价：提取后用 Function 构造校验）
const inline = script.replace(/^\s*<script>/, '').trim();
try {
  new Function(inline);
  check('内嵌脚本语法可解析（new Function 编译通过）', true);
} catch (e) {
  check('内嵌脚本语法可解析（new Function 编译通过）: ' + e.message, false);
}

if (failed > 0) {
  console.error('\n' + failed + ' 项断言失败');
  process.exit(1);
}
console.log('\n全部断言通过');
