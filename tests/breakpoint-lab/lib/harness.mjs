/**
 * 断点实验共享测试架（node:assert 形态）。
 * 每个用例记录 {suite, case, verdict, durationMs, error?}，供 run.mjs 汇总
 * 写出 reports/acceptance-report.json（真实测量，不手写）。
 */

export function createSuite(name) {
  const results = [];
  async function runCase(c) {
    const t0 = performance.now();
    try {
      await c.fn();
      results.push({ suite: name, case: c.name, verdict: 'pass', durationMs: Math.round(performance.now() - t0) });
      console.log(`  ✓ ${c.name} (${Math.round(performance.now() - t0)}ms)`);
    } catch (err) {
      results.push({ suite: name, case: c.name, verdict: 'fail', durationMs: Math.round(performance.now() - t0), error: String(err && err.message) });
      console.error(`  ✗ ${c.name}\n    ${err && err.message}`);
    }
    return results[results.length - 1];
  }
  return {
    name,
    results,
    async run(cases) {
      console.log(name);
      for (const c of cases) await runCase(c);
      return results;
    },
  };
}

/** 单文件直跑入口：node --experimental-sqlite --experimental-strip-types <file> */
export async function standaloneIfMain(moduleUrl, runFn) {
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  const argv1 = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
  if (argv1 && argv1 === moduleUrl) {
    const results = await runFn();
    const failed = results.filter((r) => r.verdict === 'fail').length;
    console.log(`\n结果：${failed ? '存在失败' : '全部通过'}（${results.length} 项用例）`);
    process.exitCode = failed ? 1 : 0;
  }
}
