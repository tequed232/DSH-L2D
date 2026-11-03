/**
 * 服务层单测入口（node --experimental-strip-types）
 * 顺序 await import：保证输出按导航 → 草稿 → 连续性 → 跨窗口排列。
 * 任一条失败会把 process.exitCode 置 1。
 */
await import('./navigation.test.ts');
await import('./draft.test.ts');
await import('./continuity.test.ts');
await import('./cross-window.test.ts');

export {};
