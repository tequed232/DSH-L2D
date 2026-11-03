# M1-F2 基线报告（Phase 0）

> 生成：2026-11-04 05:40 · Chief 核验 · 分支 `feat/m1-f2-behavior-loop`

## 一、上游基线核验（fetch 后与远端逐一比对）

| 模块 | 分支 | 远端 HEAD | 核验 |
|---|---|---|---|
| M1-d1 | `feat/m1-batch2` | 2002ba4（分支含至 3eaaa5a README） | ✅ |
| M1-d2 | `feat/m1-d2-gesture-wiring` | 05f5bc2 | ✅ |
| M1-d3 | `feat/m1-d3-consumer-lease` | 484f480 | ✅ |
| M1-f 第一批 | `feat/m1-f-cue-compiler` | ea18423 | ✅ |
| WHALEL2D 设计吸收 | `feat/m1-d-overnight` | 170a893 | ✅ |
| README 双语化 | `feat/m1-batch2` | 3eaaa5a | ✅ |

## 二、本轮任务分支与集成基线

- **分支**：`feat/m1-f2-behavior-loop`（worktree `D:\Desktop\DSH-L2D-f2`）
- **基线**：`feat/m1-d3-consumer-lease` 484f480（= d1+d2+d3 全集成）+ 合入 `feat/m1-f-cue-compiler` ea18423（Cue 编译层）
- **合并解法**：唯一冲突 = package.json test:core 链（两侧各追加测试项）；以 d3 链为基重建并尾追加 embodied-cue（过程两次修正：首次合并脚本残留标记致 JSON 损坏、二次锚点未命中漏加——均已修复并提交）
- **回滚点**：484f480（merge 前）与 3eaaa5a/05f5bc2/484f480 各上游 HEAD

## 三、测试基线

- `pnpm test:core`：**exit 0 全绿**（d1 语义链 + d2 vocab/bridge + d3 ai-inbox 13 例 + M1-f EC-01…12 + 既有全量；embodied-cue 12 tests passed 在链尾确认）
- junction：`DeepSeek免费公皮` → 主仓资产（已挂）

## 四、依赖关系图

```text
feat/m1-batch2 (3eaaa5a, README 双语)
 ├─ feat/m1-d2-gesture-wiring (05f5bc2, 基于 2002ba4 线 + b5efef6)
 │   └─ feat/m1-d3-consumer-lease (484f480) ←─ feat/m1-f2-behavior-loop (本轮, +merge ea18423)
 └─ feat/m1-f-cue-compiler (ea18423) ────────┘（已并入本轮）
feat/m1-d-overnight (170a893, 纯文档)
```

## 五、合并顺序建议（§六）

1. `feat/m1-d2-gesture-wiring` → `feat/m1-batch2`（README 提交与 d2 文件域不相交，预期净合并）
2. `feat/m1-d3-consumer-lease` → d2 后（fast-forward 线）
3. `feat/m1-f2-behavior-loop` → d3 后（本轮成果）
4. `feat/m1-f-cue-compiler` 保持独立可审查（其内容已通过本轮 merge 进入 F2 线，独立 PR 仍可评审）

## 六、工作区与遗留

- 主树在 `feat/m1-d2-gesture-wiring`（干净，仅章程 untracked 非本任务产物）
- worktree 共 16 个（含 bot 团队 `~/.dsh/bot/workspace/` 下 6 个——**不触碰**）
- 已知环境问题：宿主页 overlay 模型挂载延迟（二分定案非代码回归，见 M1-D-OVERNIGHT-REPORT 附言）——本轮 smoke 就绪门禁（impl-smoke）即为此固化
- 实例：3081（d3 lib，bot 宿主）/ 3082（隔离验证用）/ dev-server 5300（模型正常，验收替代通道）
