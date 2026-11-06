/**
 * Breakpoint Lab 统一入口：串行跑全部套件，汇总真实耗时与 verdict，
 * 写出 reports/acceptance-report.json（脚本真实写出，不手写）。
 *
 * 直跑：node --experimental-sqlite --experimental-strip-types tests/breakpoint-lab/run.mjs
 * 亦可单独直跑各套件文件（见各文件 standaloneIfMain 尾部）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as runCache } from './cache/cache-cases.mjs';
import { run as runRecovery } from './recovery/recovery-cases.mjs';
import { run as runOwnership } from './ownership/ownership-cases.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const t0 = performance.now();
  const results = [
    ...(await runCache()),
    ...(await runRecovery()),
    ...(await runOwnership()),
  ];
  const report = {
    generatedAt: new Date().toISOString(),
    branch: 'feat/model-registry',
    totalDurationMs: Math.round(performance.now() - t0),
    totals: {
      cases: results.length,
      pass: results.filter((r) => r.verdict === 'pass').length,
      fail: results.filter((r) => r.verdict === 'fail').length,
    },
    cases: results,
  };
  const reportsDir = path.join(HERE, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, 'acceptance-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

  console.log(`\nBreakpoint Lab：${report.totals.pass}/${report.totals.cases} 通过` +
    `（${report.totalDurationMs}ms）→ ${path.relative(process.cwd(), reportPath)}`);
  if (report.totals.fail > 0) {
    for (const r of results.filter((x) => x.verdict === 'fail')) {
      console.error(`  FAIL ${r.suite} / ${r.case}: ${r.error}`);
    }
    process.exitCode = 1;
  }
}

await main();
