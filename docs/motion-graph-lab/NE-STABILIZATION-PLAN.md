# Node Editor Stabilization 构建方案（NE-01~NE-04 裁剪版，2026-11-09 13:50）

> 窗口：13:50–17:00 验收。依据：用户 NE 稳定化规划 + AUDIT-FEATURE-MATRIX.md（0c72bb4）实证。
> 冻结项不变：VTS / 多 Runtime / Limb Allocation / Behavior Engine / AI 自动生成 / Cubism 底层重构。
> 双 Runtime 架构（DCRA）仅作目标记录，本轮不做；NE 批次接口保持 Runtime 无关。

## 批次裁剪（3 小时窗口现实约束）

| 批次 | 范围 | 本轮交付 | 状态裁定 |
|------|------|---------|---------|
| NE-01 契约统一 | 优先级分段语义统一（graph node 增可选 priority 字段，宿主编译对齐编辑器）、对拍测试、E13 三态、组合实例化预校验、validateStep 规则常量导出 | **全量** | 核心 |
| NE-02 运行可靠性 | executionId + 同图重入 409 busy + 取消标志传播 + 执行历史查询路由（注册表在路由层，不改 runNodegraph 签名） | **全量**（取消=批次间标志检查，已入队动作不可撤——如实标注） | 核心 |
| NE-03 Inspector | Execution Console 浮窗（PanelLayers 第四层），消费 /nodegraphs/executions 查询 | UI + 数据接入 | 核心 |
| NE-04 工程化 | 规则常量导出（choreography）、文档更新、版本兼容测试（v1 现状回归即兼容证明） | 部分交付；全量模块拆分**明确推迟**（先测试后迁移，本轮测试即安全网） | 推迟部分如实报告 |

## 文件所有权（互不重叠，违者回滚）

| 所有者 | 独占文件 |
|--------|---------|
| impl-contract | packages/dsh-l2d-plugin/lib/nodegraph.mjs、lib/choreography.mjs（仅新增导出）、lib/nodegraph.test.mjs |
| impl-editor | packages/dsh-l2d-plugin/assets/motion-graph.html |
| impl-settings | packages/dsh-l2d-plugin/assets/settings.html + tools/acceptance/snapshots/settings.html |
| impl-runtime | packages/dsh-l2d-plugin/lib/index.js（仅 nodegraphs 路由段）、新文件 lib/nodegraph-runs.mjs |
| qa | 只读测试 + 报告 |

共享边界裁定：runNodegraph 签名不变（contract 侧改其内部 compile 语义）；三态条数据源 = 既有 /dsh-l2d/motion-mode + /dsh-l2d/nodegraphs，无需新路由；Execution Console 数据源 = runtime 新增 GET /dsh-l2d/nodegraphs/executions?name= 与 ?id=。

## Wave 编排

- Wave 1（并行）：impl-contract / impl-editor / impl-settings
- Wave 2（依赖 W1 契约定案）：impl-runtime
- Wave 3：qa-regression（SendMessage 继续团队既有 qa 成员）全量回归 + selftest 实测
- 终审：主理人合并决策、指纹/快照授权刷新、提交推送、17:00 报告

## 验收门槛（17:00 检查表）

1. 同一 JSON 前后端校验一致（对拍测试绿）
2. 编译结果可重复（priority 分段语义对齐，旧图无 priority 字段行为不变）
3. E13 三态条实机可见（Imported/Validated/Runnable）
4. 组合实例化非法组合被拦截
5. 重复 run 第二次 409 busy + executionId 可回查
6. 取消标志传播到执行链（后续批次不下发）
7. Execution Console 展示真实 receipts（非模拟进度）
8. 全量回归绿 + selftest 六组断言全绿
