/**
 * 极简测试脚手架（与 packages/core/test 的风格一致：零依赖，assert 直接跑）
 */
import assert from 'node:assert/strict';

let passed = 0;
const failures: string[] = [];

export function section(title: string): void {
  console.log(`\n${title}\n`);
}

export function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok   ${name}`);
    })
    .catch((error: unknown) => {
      failures.push(name);
      console.error(`  FAIL ${name}`);
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}

export function count(): number {
  return passed;
}

export function summary(label: string, since = 0): void {
  const local = passed - since;
  if (failures.length > 0) {
    console.error(`\n${label}：${local} 通过，${failures.length} 失败\n`);
    return;
  }
  console.log(`\n${label}：${local} 通过\n`);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等待，用于流式/跨窗口这类异步收敛的断言，避免固定 sleep 造成抖动 */
export async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 3000,
  stepMs = 10,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`等待超时：${label}`);
    await delay(stepMs);
  }
}

export { assert };
