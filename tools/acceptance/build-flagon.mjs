#!/usr/bin/env node
/**
 * [F2/R2] 可复现的 flag-on 验收构建。
 *
 * 背景：F2 真机验收使用的是「工作区把 embodied.timeline/embodied.cue 改成 true 后构建」的
 * 产物，而 HEAD 默认是 false——验收构建与干净检出不一致，无法复现也无法审计（QA R2）。
 *
 * 本脚本：读取 motion-adapter.ts → 临时置 true → 构建 → 计算并打印 bundle sha256 →
 * **恢复源码原状**（不改变仓库状态）。验收方据此可随时重建同一份产物并核对 hash。
 *
 * 用法：
 *   node tools/acceptance/build-flagon.mjs            # 构建并打印 hash（timeline + cue）
 *   node tools/acceptance/build-flagon.mjs --limb     # [M1-g] 只翻 embodied.limb（G1 单肢接管）
 *   node tools/acceptance/build-flagon.mjs --keep     # 构建后保留 flag=true（供真机部署），
 *                                                     # 结束时打印还原命令
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const adapter = path.join(root, 'packages/renderer/src/app/motion-adapter.ts');
const bundle = path.join(root, 'packages/dsh-l2d-plugin/assets/renderer.js');
const KEEP = process.argv.includes('--keep');
const LIMB = process.argv.includes('--limb');

const src = fs.readFileSync(adapter, 'utf8');
/**
 * --limb：只翻 embodied.limb（G1）。**故意不翻 embodied.m1**——m1 打开的是 Hip* pre 让位
 * （共享枢纽 S3），与手臂叶子域的 post 覆盖是两件事，混在一起验收会分不清谁在起作用。
 */
const flipped = LIMB
  ? src.replace("'embodied.limb': false,", "'embodied.limb': true,")
  : src
      .replace("'embodied.timeline': false,", "'embodied.timeline': true,")
      .replace("'embodied.cue': false,", "'embodied.cue': true,");

if (flipped === src) {
  console.error('[build-flagon] 未找到待翻转的 flag 行（motion-adapter.ts 结构已变？）');
  process.exit(2);
}

fs.writeFileSync(adapter, flipped);
let ok = false;
try {
  execSync('pnpm -F @dsh/renderer build', { cwd: root, stdio: 'inherit' });
  const buf = fs.readFileSync(bundle);
  const sha = createHash('sha256').update(buf).digest('hex').slice(0, 16);
  console.log(`[build-flagon] flag-on bundle  sha256:${sha}  size:${buf.length}B`);
  console.log(
    LIMB
      ? `[build-flagon] M1-g 用法：l2d_limb_acquire {side:'right', durationMs:4000} → getInfo().pv 读 RArm 覆盖值 → l2d_limb_release → RArm 回物理`
      : `[build-flagon] 部署：把该产物随插件包发布后，用 --m1-flag on --m1-cue --m1-gesture 跑验收`,
  );
  ok = true;
} finally {
  if (!KEEP) {
    fs.writeFileSync(adapter, src);
    execSync('pnpm -F @dsh/renderer build', { cwd: root, stdio: 'ignore' });
    console.log('[build-flagon] 源码与产物已还原为默认 flag=false（仓库状态不变）');
  } else {
    console.log('[build-flagon] --keep：flag=true 保留在工作区；还原请执行 git checkout -- packages/renderer/src/app/motion-adapter.ts && pnpm -F @dsh/renderer build');
  }
}
process.exit(ok ? 0 : 1);
