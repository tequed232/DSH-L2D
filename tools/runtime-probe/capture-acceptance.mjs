/**
 * 验收补拍脚本 v2（ACPT-UIUX-24，按 QA 裁定补证）：
 * 修复 v1 缺陷——无头默认 prefers-color-scheme:light 导致暗色基线拍成浅色，
 * 全程用 emulateMedia 显式钉住色系；加高视口让情境预览入画；
 * 窄屏先回首页再拍；抽屉自动关闭行为改为读取 classList 客观记录。
 */
import path from 'node:path';
import fs from 'node:fs';

const OUT_DIR = 'D:/Desktop/DSH-L2D/data/acceptance-uiux';
const BASE_URL = 'http://127.0.0.1:5273/';

fs.mkdirSync(OUT_DIR, { recursive: true });

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--disable-gpu-vsync', '--disable-frame-rate-limit'],
});
const log = [];

async function newPage(colorScheme) {
  const context = await browser.newContext({ viewport: { width: 1912, height: 1200 } });
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme }); // 钉住 pre-paint 脚本的 matchMedia 回退
  return { context, page };
}

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT_DIR, name), fullPage: false });
  log.push(`OK ${name}`);
};

// ---------- 暗色段 ----------
{
  const { context, page } = await newPage('dark');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2500);
  log.push(`INFO data-theme=${await page.evaluate(() => document.documentElement.dataset.theme)}`);
  await shot(page, '01-home-dark.png');

  // 插件中心（宽屏侧栏为常驻，非抽屉）
  await page.getByText('Plugin Center', { exact: false }).first().click({ timeout: 5000 });
  await page.waitForTimeout(1200);
  await shot(page, '02-plugin-center.png');

  // 设置弹窗：视口已加高到 1200，情境预览 tab 下方区域应入画
  await page.getByRole('button', { name: /settings|设置/i }).first().click({ timeout: 5000 });
  await page.waitForTimeout(800);
  await shot(page, '03-settings-full.png');
  const qaTab = page.getByText('问答', { exact: true }).first();
  await qaTab.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(300);
  await shot(page, '04-context-preview-idle.png'); // 与 03 不同状态（已滚动对齐 tab 行）
  await qaTab.click({ timeout: 4000 });
  await page.waitForTimeout(600);
  await shot(page, '04b-context-preview-qa.png');
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);

  // 亮色：循环点击直到 data-theme=light
  const clickToggle = async () => {
    for (const locator of [
      page.getByRole('button', { name: /切换主题/ }),
      page.locator('header button').last(),
    ]) {
      try { await locator.click({ timeout: 3000 }); return true; } catch { /* 下一个 */ }
    }
    return false;
  };
  for (let i = 0; i < 4; i += 1) {
    if (await clickToggle()) await page.waitForTimeout(600);
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) === 'light') break;
  }
  await shot(page, '05-light-theme.png');
  for (let i = 0; i < 4; i += 1) {
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark') break;
    if (await clickToggle()) await page.waitForTimeout(600);
  }
  await shot(page, '06-back-dark.png');
  await context.close();
}

// ---------- 窄屏段（独立 context，暗色） ----------
{
  const { context, page } = await newPage('dark');
  await page.setViewportSize({ width: 820, height: 1000 });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2500);
  const isHome = await page.evaluate(() => document.body.innerText.includes('Companion'));
  log.push(`INFO narrow starts at home view = ${isHome}`);
  await shot(page, '07-narrow-home.png');

  // 抽屉展开 → 点击 Plugin Center → 客观记录抽屉是否自动关闭
  await page.locator('.menu-btn').first().click({ timeout: 5000 });
  await page.waitForTimeout(600);
  await shot(page, '07b-narrow-drawer-open.png');
  await page.getByText('Plugin Center', { exact: false }).first().click({ timeout: 5000 });
  await page.waitForTimeout(1000);
  const drawerStillOpen = await page.evaluate(() => {
    const el = document.querySelector('.sidebar-open');
    return Boolean(el);
  });
  log.push(`INFO drawer auto-closed after nav = ${!drawerStillOpen}`);
  if (drawerStillOpen) {
    // 点 scrim 区域收起抽屉（模拟用户手动关闭）
    await page.mouse.click(700, 500);
    await page.waitForTimeout(600);
    const stillOpen = await page.evaluate(() => Boolean(document.querySelector('.sidebar-open')));
    log.push(`INFO drawer closed by scrim click = ${!stillOpen}`);
  }
  await shot(page, '08-narrow-plugin-center.png');
  await context.close();
}

await browser.close().catch(() => {});
console.log(log.join('\n'));
