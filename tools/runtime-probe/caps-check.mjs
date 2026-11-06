/** 快速核查：宿主加载的模型里到底有没有这些 ID（只查布尔，不输出全表） */
const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto('http://127.0.0.1:5319/', { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForFunction(
  () => Boolean(window.DSH_L2D && window.DSH_L2D.isReady && window.DSH_L2D.isReady()),
  null, { timeout: 45000, polling: 250 },
);
const check = await page.evaluate(() => {
  const caps = window.DSH_L2D.getCapabilities();
  const ids = new Set((caps.params || []).map((p) => p.id));
  const probe = ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'PositionX', 'PositionY',
    'ParamBodyAngleX', 'ParamEyeBallX', 'Param_Angle_Rotation84', 'Param_MonthX'];
  const found = probe.filter((id) => ids.has(id));
  const angleLike = (caps.params || []).map((p) => p.id).filter((id) => /angle/i.test(id)).slice(0, 8);
  return { total: (caps.params || []).length, found, angleLike, modelOk: window.DSH_L2D.isReady() };
});
await browser.close().catch(() => {});
console.log(JSON.stringify(check, null, 2));
