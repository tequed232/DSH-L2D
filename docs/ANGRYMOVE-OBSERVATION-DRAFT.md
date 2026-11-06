# AngryMove1–8 单参注入视觉初筛（DSV4.1f 初筛稿 · 待 GLM 多模态复核）

- 采集：2026-11-05 03:40，真实运行时（probe 注入 1，edge+RTX5060），头部裁剪窗 = 画布上 45%。
- 数值证据：8/8 参数注入生效、超出基线噪声、基线恢复（probe_run 6/14–20/21–28）。
- **初筛局限**：裁剪窗只覆盖头部与上胸；身体下部/发型/缩放类效果不可见；面部微表情在此分辨率不可辨。
- **本表不作为最终职责归因**——最终归因须 GLM 多模态 QA 对照 `head-neutral.png` 全套复核。

| 参数 | 头部窗内可见变化（初筛） | 推断（不确定，勿采信） |
|---|---|---|
| AngryMove | 胸前丝带处出现蓝色小符号 | 疑似生气符号/挂件显隐 |
| AngryMove2 | 无可见差异 | 效果可能在全身窗或需组合 |
| AngryMove3 | 无可见差异 | 同上 |
| AngryMove4 | 无可见差异 | 同上 |
| AngryMove5 | 胸前出现蓝色小符号（与 AngryMove 类似） | 疑似同类显隐，幅度/位置待比对 |
| AngryMove6 | 无可见差异 | 同上 |
| AngryMove7 | 无可见差异 | 同上 |
| AngryMove8 | 无可见差异 | 同上 |

## GLM 复核要求（Phase 3 视觉归因任务）
1. 全身对照：`pre-AngryMove*.png`（注入前）vs `baseline-AngryMove*.png`（注入后）逐对 diff。
2. 头部特写：`head-neutral.png` vs `head-AngryMove*.png`。
3. 产出 AngryMove1–8 职责表（显隐/方向/缩放/相位），回填 motion_model_bindings 前**须人工确认**。
4. 复核通过前，怒链保持单参数（motion.angry_flash_single），不得组合。
