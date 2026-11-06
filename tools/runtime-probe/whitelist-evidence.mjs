/**
 * 白名单三通道 API 取证脚本（A1-A3 + C 拒证）：
 * 直接在真实渲染宿主上 page.evaluate 取 ApplyReport 原值，落盘 JSON。
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'D:/Desktop/DSH-L2D/data/acceptance-uiux/whitelist-api-evidence.json';
const BASE = 'http://127.0.0.1:5319';
const results = {};

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForFunction(
  () => Boolean(window.DSH_L2D && window.DSH_L2D.isReady && window.DSH_L2D.isReady()),
  null, { timeout: 45000, polling: 250 },
);

// A1: agent 通道写白名单外参数 → 预期拒绝
results.A1_positionX_agent =
  await page.evaluate(() => Promise.resolve(window.DSH_L2D.setParameters({ PositionX: 2 })).catch((e) => ({ thrown: String(e) })));
// A2: agent 通道写托管参数 → 预期 applied
results.A2_paramAngleX_agent =
  await page.evaluate(() => Promise.resolve(window.DSH_L2D.setParameters({ ParamAngleX: 10 })).catch((e) => ({ thrown: String(e) })));
// A2b: 头部真实偏转读回
results.A2b_readback = await page.evaluate(() => window.DSH_L2D.readParameters(['ParamAngleX']));
// A3: runtime 通道写白名单外参数 → 预期放行
results.A3_positionX_runtime =
  await page.evaluate(() => Promise.resolve(window.DSH_L2D.setParametersRuntime({ PositionX: 2 })).catch((e) => ({ thrown: String(e) })));
results.A3b_readback = await page.evaluate(() => window.DSH_L2D.readParameters(['PositionX']));
// 复位
await page.evaluate(() => Promise.resolve(window.DSH_L2D.resetPose()).catch(() => {}));
results.hasRuntimeExport = await page.evaluate(() => typeof window.DSH_L2D.setParametersRuntime);

await browser.close().catch(() => {});

// C: MCP/Agent HTTP 入口写 PositionX → 预期拒绝
try {
  const res = await fetch(BASE + '/dsh-l2d/ai', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'set_parameters', params: { PositionX: 2 } }),
  });
  results.C_aiEntry = { status: res.status, body: (await res.text()).slice(0, 500) };
} catch (e) {
  results.C_aiEntry = { error: String(e) };
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
