# M1-F2 集成地图：分支依赖与合并顺序

> 生成：2026-11-04 · Chief · 对应任务书 §六「合并与分支策略」

## 一、分支依赖图

```
feat/m1-batch2 (3eaaa5a, d1 2002ba4 + README 双语 3eaaa5d)
 │
 ├── feat/m1-d2-gesture-wiring (05f5bc2)          d2: Gesture 接线 + P2 收口 + armed 硬化
 │    │                                            （基于 b5efef6 线，README 提交不在本线）
 │    └── feat/m1-d3-consumer-lease (484f480)      d3: 消费者租约 + epoch fencing（基于 d2 头）
 │         │
 │         └── feat/m1-f2-behavior-loop (F2)       F2: Cue 闭环 + smoke 就绪门禁
 │              （= d3 头 + merge M1-f 第一批 + F2 三提交）
 │
 ├── feat/m1-f-cue-compiler (ea18423)              M1-f 第一批：纯函数编译层（独立可审查）
 │
 └── feat/whale-workspace (0153135)                Whale Workspace 双向切换（从 batch2 拉出，
                                                   纯新增 apps/whale-workspace + docs，
                                                   对既有包零侵入）
feat/m1-d-overnight (170a893)                      纯文档（d 阶段报告/设计/QA）
```

## 二、合并顺序（建议执行顺序）

| # | 源 → 目标 | 类型 | 冲突评估 | 前置 |
|---|---|---|---|---|
| 1 | `feat/m1-d2-gesture-wiring` → `feat/m1-batch2` | 三路合并 | **无冲突**：README 提交（3eaaa5d）与 d2 文件域（renderer/overlay/core-vocab）零重叠 | 无 |
| 2 | `feat/m1-d3-consumer-lease` → 步骤 1 结果 | fast-forward 线 | 无冲突：d3 基于 d2 头 + 1 提交，lib 域 | 1 |
| 3 | `feat/m1-f2-behavior-loop` → 步骤 2 结果 | 需先把 F2 头对齐到 d2 线最新（含 d0669a1 dev-server 白名单） | **已知一处**：package.json test:core 链（已按「d3 链为基 + 尾追加」解法处理，见 M1-F2-BASELINE.md） | 2 |
| 4 | `feat/m1-f-cue-compiler` → 主分支 | 独立 PR 评审 | 其内容已通过 #3 的 merge 进入 F2 线；独立 PR 仅作可审查性保留 | 3 或独立 |
| 5 | `feat/whale-workspace` → 主分支 | 独立 PR 评审 | **零冲突**（纯新增目录 + 独立 docs + lock 新增 importer）；注意根 package.json test:core 链需与 #3 顺序合并（同文件不同位置，仍需人工核对） | 任意（建议 #3 后） |
| 6 | `feat/m1-d-overnight` → 主分支 | 纯文档 | 零冲突 | 任意 |

## 三、依赖保留约束（不可违反）

1. **d3 不能单独 cherry-pick** 到未含 d2 的分支：d3 的 overlay.js 轮询区改动建立在 d2 的行号基线上。
2. **F2 不能跳过 d3**：cue 入口（overlay l2d_cue）与 d2 手势区、d3 轮询区在同一文件，逐区段串行追加。
3. **M1-f 第一批**保持独立可评审，但不得单独部署（编译层无渲染接线，flag 无关）。
4. **Whale 与 F2 无依赖**，可并行评审；两者唯一共享文件是根 `package.json`（test:core 链尾），合并时按行核对。

## 四、每步合并的回滚点

| 目标分支当前 HEAD | 回滚命令 |
|---|---|
| batch2 3eaaa5d | `git reset --hard 3eaaa5d` |
| d2 05f5bc2 | `git reset --hard 05f5bc2` |
| d3 484f480 | `git reset --hard 484f480` |
| F2 c1796c5（推送头） | `git reset --hard c1796c5` |
| Whale 0153135 | `git branch -D feat/whale-workspace`（未合并时） |

## 五、合并前检查清单

- [ ] `pnpm test:core` exit 0（合并后逐分支复跑）
- [ ] `pnpm test:types` PASS
- [ ] `pnpm -F @dsh/renderer build` PASS 且产物与源码一致（md5 三向）
- [ ] `m1-smoke --selftest` PASS（53 断言）
- [ ] `apps/whale-workspace` typecheck + build + 37 测试
- [ ] 根 package.json `test:core` 链去重（F2 与 Whale 各追加一项，合并后确认无重复条目）
- [ ] Feature flag 默认值核对：`embodied.cue=false` / `embodied.timeline=false` / `consumerLeaseEnabled=false`
- [ ] README 与 docs 的链接有效性（双语锚点）

## 六、当前状态（2026-11-04 06:30）

- 所有源分支已推送远端；**未执行自动合并**（按任务书要求先准备、待审查）
- F2 真机证据：dev-server 通道 U7-U11 全 PASS；宿主页写路径 BLOCKED（环境，二分定案）
- 待办：QA 独立矩阵（M1-F2-QA-REPORT.md）→ 合并执行 → 主分支回归
