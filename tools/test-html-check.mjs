#!/usr/bin/env node
// test.html HUD 三态结构断言检查（无 jsdom，做文本 + 结构断言）
// 用法：node tools/test-html-check.mjs   — exit 0 全部通过，exit 1 有失败
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const file = join(root, 'packages/dsh-l2d-plugin/assets/test.html');
const html = readFileSync(file, 'utf8');
const settingsFile = join(root, 'packages/dsh-l2d-plugin/assets/settings.html');
const settingsHtml = readFileSync(settingsFile, 'utf8');

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

// 3. 双实例防御：ensureHud 开头查重 id，已存在则复用不重建
check(
  'ensureHud 查重 #l2d-test-hud（已存在则不重复创建）',
  /getElementById\('l2d-test-hud'\)/.test(script) && /已存在则不重复创建/.test(script)
);

// 4. 三态模型：setHudState 支持 hidden/collapsed/expanded，hidden 摘除 DOM
check(
  '三态 setHudState：hidden 摘除 HUD DOM（连标题条都不显示）',
  /function setHudState\(state\)/.test(script) &&
    /state === 'hidden'/.test(script) &&
    /removeChild\(hudRoot\)/.test(script)
);
check(
  'collapsed/expanded 由同一开关控制（▾/▸ 标题条文本）',
  /'参数监视台 ▾'/.test(script) && /'参数监视台 ▸'/.test(script)
);

// 5. 默认 fail-closed：启动按 hidden 渲染，settings 读取成功后才校正
check(
  '启动 fail-closed：setHudState(forceOpen ? \'expanded\' : \'hidden\')',
  /setHudState\(forceOpen \? 'expanded' : 'hidden'\)/.test(script)
);
check(
  '启动读取 /dsh-l2d/settings.json 的 debugPreview 决定 collapsed',
  /fetch\('\/dsh-l2d\/settings\.json'/.test(script) &&
    /debugPreview === true/.test(script) &&
    /setHudState\(want \? 'collapsed' : 'hidden'\)/.test(script)
);

// 6. ?hud=open 调试后门：强制 expanded 且不跟随设置联动（轮询里 forceOpen return）
check(
  '?hud=open 强制 expanded 且轮询不覆盖（调试后门语义）',
  /get\('hud'\)\s*===\s*'open'/.test(script) &&
    /if \(forceOpen\) return;/.test(script)
);

// 7. 设置联动轮询：每 ~2s 查一次 settings，失败静默沿用上次值
check(
  '设置联动轮询 setInterval 2000ms + 失败静默沿用',
  /setInterval\(function \(\) \{[\s\S]*?readDebugPreview[\s\S]*?\}, 2000\)/.test(script) &&
    /静默沿用上次值/.test(script)
);

// 8. hidden 时 render() 直接 return（不刷 DOM，数据链不受影响）
check(
  'render() 在 hidden 下直接 return',
  /var render = function \(\) \{\s*if \(hudState === 'hidden' \|\| !hudBody\) return;/.test(script)
);

// 9. 点击标题条切换 collapsed ↔ expanded
check(
  '点击 .hud-bar 切换 collapsed/expanded',
  /hudBar\.addEventListener\('click'[\s\S]*?setHudState\(hudBody\.style\.display\s*===\s*'none' \? 'expanded' : 'collapsed'\)/.test(script)
);

// 10. 旧版常开静态 <div id="hud"> 已移除，不再有裸 #hud 选择器
check('旧版静态 <div id="hud"> 已移除', !/<div id="hud">/.test(html) && !/(^|[^-\w])#hud\s*\{/.test(html));

// 11. 内嵌脚本基础语法可解析（node --check 等价：提取后用 Function 构造校验）
const inline = script.replace(/^\s*<script>/, '').trim();
try {
  new Function(inline);
  check('内嵌脚本语法可解析（new Function 编译通过）', true);
} catch (e) {
  check('内嵌脚本语法可解析（new Function 编译通过）: ' + e.message, false);
}

// 12. settings.html 开发者区开关接线：toggleRow(debugPreview) + 说明文案
check(
  'settings.html 开发者区接入「显示调试预览」开关',
  /toggleRow\(dev, 'debugPreview', '显示调试预览', '开启后参数监视台标题条显示在其页面上'\)/.test(settingsHtml) &&
    /<div class="rows" id="rows-dev"><\/div>/.test(settingsHtml)
);

if (failed > 0) {
  console.error('\n' + failed + ' 项断言失败');
  process.exit(1);
}
console.log('\n全部断言通过');
