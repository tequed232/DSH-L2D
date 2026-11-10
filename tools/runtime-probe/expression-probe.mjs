/**
 * Expression Probe CLI（表情通道视觉归因探针 · issue #36 补证）。
 *
 * 用途：为标签审计（LABEL-AUDIT-CLASSIFIED.md §三/§9.2）提供"表情 → 视觉效果"
 * 真实渲染证据。走渲染端既有表情通道 window.DSH_L2D.setExpression（与
 * l2d_set_expression 同一入口），不做参数注入、不绕口型保护。
 *
 * - --mode 未提供时默认 expression 流程：
 *     node tools/runtime-probe/expression-probe.mjs --expression 兔牙[,＞＜,脸红] [--port 5321]
 *
 * 每个表情产出：
 *  - neutral 截图（resetPose + clearExpression 后）
 *  - 注入后截图（setExpression + 稳定等待后）
 *  - 数值 JSON（表情文件路径 / 参数变化 diff / 截图路径），落 data/runtime-probe/
 *
 * 纪律：所有观测来自 Playwright 驱动的真实 Edge + @dsh/renderer；本模块不伪造任何观测值。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startDevServer, launchProbeHost, stopDevServer, ensureArtDir } from './lib/host.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function argOf(flag, def = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : def;
}

const PORT = Number(argOf('--port', '5321'));
const EXPRESSIONS = String(argOf('--expression', '')).split(',').map((s) => s.trim()).filter(Boolean);
const SETTLE_MS = Number(argOf('--settle-ms', '1600'));

if (!EXPRESSIONS.length) {
  console.error('用法: --expression <名1[,名2...]> [--port 5321] [--settle-ms 1600]');
  process.exit(1);
}

async function main() {
  const dv = await startDevServer(PORT);
  let host = null;
  try {
    // deviceScaleFactor=2：画布 720x540 → 截图 1440x1080，面部尽量大
    host = await launchProbeHost({ baseUrl: dv.baseUrl, deviceScaleFactor: 2 });
    const artDir = ensureArtDir();
    const page = host.page;

    const caps = await host.ops.caps();
    const liveExpressions = caps.expressions || [];
    const allIds = (caps.params || []).map((p) => p.id);

    // 画布放大到 720x540（页面自带输入框，change 触发 re-boot），提升面部像素分辨率
    await page.evaluate(() => {
      const wIn = document.getElementById('w');
      const hIn = document.getElementById('h');
      wIn.value = '720';
      hIn.value = '540';
      wIn.dispatchEvent(new Event('change'));
    });
    await page.waitForFunction(
      () => Boolean(window.DSH_L2D && window.DSH_L2D.isReady && window.DSH_L2D.isReady()),
      null,
      { timeout: 45000, polling: 250 },
    );
    await new Promise((r) => setTimeout(r, 800));

    // 画布矩形（页面坐标）→ 截图裁剪窗与 head-neutral.png 构图一致（模型上半身）
    const canvasRect = await page.evaluate(() => {
      const cv = document.getElementById('cv');
      const r = cv.getBoundingClientRect();
      return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
    });
    const clip = { x: canvasRect.x, y: canvasRect.y, width: canvasRect.width, height: canvasRect.height };

    // 面部特写窗（画布上部居中紧贴头/脸；两两对照窗完全一致保证对齐）
    const faceClip = {
      x: Math.round(canvasRect.x + canvasRect.width * 0.32),
      y: Math.round(canvasRect.y + canvasRect.height * 0.01),
      width: Math.round(canvasRect.width * 0.36),
      height: Math.round(canvasRect.height * 0.34),
    };

    const results = [];
    for (const expression of EXPRESSIONS) {
      const rec = {
        mode: 'expression',
        expression,
        liveExpressionListed: liveExpressions.includes(expression),
        canvasRect,
        settleMs: SETTLE_MS,
      };

      if (!rec.liveExpressionListed) {
        rec.verdict = 'FAIL';
        rec.reason = '模型 capabilities 无此表情';
        results.push(rec);
        continue;
      }

      // 1) 中性基准：复位 + 清表情 + 参数快照 + 截图
      await host.ops.resetPose();
      await page.evaluate(() => { if (window.DSH_L2D.clearExpression) window.DSH_L2D.clearExpression(); });
      await new Promise((r) => setTimeout(r, 1000));
      const neutralShot = path.join(artDir, `expr-neutral-${expression}.png`);
      const neutralFaceShot = path.join(artDir, `expr-neutral-face-${expression}.png`);
      await page.screenshot({ path: neutralShot, clip });
      await page.screenshot({ path: neutralFaceShot, clip: faceClip });
      const before = await host.ops.read(allIds);

      // 2) 表情注入（渲染端唯一表情通道）
      const setOk = await page.evaluate((name) => {
        try { return window.DSH_L2D.setExpression(name) === true; }
        catch (e) { return false; }
      }, expression);
      rec.setOk = setOk;
      await new Promise((r) => setTimeout(r, SETTLE_MS));

      // 3) 注入态截图 + 参数快照
      const injectedShot = path.join(artDir, `expr-injected-${expression}.png`);
      const faceShot = path.join(artDir, `expr-face-${expression}.png`);
      await page.screenshot({ path: injectedShot, clip });
      await page.screenshot({ path: faceShot, clip: faceClip });
      const after = await host.ops.read(allIds);

      // 4) 参数变化 diff（只记录确实移动的参数）
      const changes = [];
      for (const id of allIds) {
        const b = before[id];
        const a = after[id];
        if (b === undefined || a === undefined) continue;
        if (Math.abs(a - b) > 1e-4) changes.push({ id, before: b, after: a });
      }
      rec.neutralShot = path.relative(process.cwd(), neutralShot);
      rec.neutralFaceShot = path.relative(process.cwd(), neutralFaceShot);
      rec.injectedShot = path.relative(process.cwd(), injectedShot);
      rec.faceShot = path.relative(process.cwd(), faceShot);
      rec.paramChanges = changes;
      rec.consoleErrors = host.ops.getConsoleErrors().slice(0, 5);
      rec.verdict = setOk && changes.length > 0 ? 'PASS' : (setOk ? 'PASS_WITH_WARNINGS' : 'FAIL');
      if (!setOk) rec.reason = 'setExpression 返回 false（未知表情或通道拒绝）';
      else if (!changes.length) rec.warning = 'setExpression 成功但未观测到参数变化（可能是纯贴图/绘制切换）';

      // 5) 复位，避免污染下一个表情的中性基准
      await page.evaluate(() => { if (window.DSH_L2D.clearExpression) window.DSH_L2D.clearExpression(); });
      await host.ops.resetPose();
      await new Promise((r) => setTimeout(r, 700));

      results.push(rec);
    }

    const reportPath = path.join(artDir, `expression-probe-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify({ results }, null, 2));
    console.log(JSON.stringify({ results, reportPath }, null, 2));
    if (results.some((r) => r.verdict === 'FAIL')) process.exitCode = 2;
  } finally {
    if (host) await host.ops.close();
    stopDevServer(dv);
  }
}

main().catch((e) => {
  console.error('PROBE_ERROR:', e.message);
  process.exit(1);
});
