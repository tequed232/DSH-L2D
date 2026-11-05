# Phase 1 — ACCEPTANCE-TESTS.md

> 配套：`docs/DSH-L2D-全量架构替换任务书.md`（§10）、`docs/PHASE0-REPOSITORY-AUDIT.md` §7
> 状态：待用户审阅。

---

## 1. 验收维度（任务书 §10）

| 维度 | 验收点 |
| --- | --- |
| 架构 | 三工作区职责明确、可独立配模型、主对话可调度学习与执行、子任务可状态追踪、SQLite 为统一数据源 |
| 学习 | 可导入图库压缩包、可多模态分析、能生成 Motion Description 与 Actions Chain、每条可追溯、未验证不可执行 |
| 执行 | 可语义检索、可模型能力验证、可正确处理缺失动作、可取消/中断、可返回真实状态、无第二套参数写入器 |
| 迁移 | 不再依赖旧 choreography/phase/静态白名单；旧 MCP 接口已替换或迁移；旧训练链路已被取代；无未经审计的旧执行入口 |
| 质量 | 单元/集成/MCP 契约/数据库迁移/端到端测试通过，无未解释安全回归 |

---

## 2. 测试矩阵（按 Agent 分工）

| 层 | 测试类型 | 覆盖范围 | 现有基础 |
| --- | --- | --- | --- |
| 后端 Agent | 单元测试 | Repository CRUD、检索、Schema 迁移、外键/事务 | 全新（建 `*.test.mjs`） |
| 后端 Agent | 集成测试 | 学习→写库→检索→执行 链路 | 全新 |
| MCP Agent | MCP 契约测试 | 9 个工具的 input/output/错误码/超时 | 复用 `validate.test.mjs`/`action-sequence.test.mjs`/`act-result.test.mjs` |
| 多模态 Agent | 模型兼容性测试 | Model Adapter 映射、Capability Validator | 复用 `capability-profile.ts`/`motion-profile.ts` |
| 总架构 Agent | 端到端测试 | 主对话 → W3 → Renderer 全链路 | 全新；复用 `yandere-preempt.test.mjs` 渲染片段 |
| 测试 Agent | 回归测试 | 底层能力未被破坏 | 见 §3 |

---

## 3. 必须补齐的回归测试（Phase 0 缺口）

| 缺口 | 必须补的测试 | 关联防误删边界 |
| --- | --- | --- |
| `param-injector.ts` 无独立测试 | 参数存在性、物理输出拒绝、ownership 计数 | CRITICAL-1 |
| `pose-controller.ts` 无专门测试 | 四肢姿势 adopt/reset | — |
| `motion-director.ts` 仅部分覆盖 | 成对动作决策矩阵 | 动作互斥 |
| `index.ts` 运行期编排无集成测试 | `playKeyframes` 规模护栏、`resetPerformance` 纪元递增 + releaseAll | CRITICAL-3 |
| 宿主 HTTP 路由无直接测试 | cross-site/loopback 栅栏、sanitize | 纵深防御 |
| `reverse-log.mjs` 无测试 | 环形缓冲/原子落盘 | — |
| settings 一次性迁移无测试 | `eyeFollow`/`apiKey` 脏值归一化 | — |

---

## 4. 五份最终报告（任务书 §7，Phase 7 产出）

1. **`LEGACY-REPLACEMENT-REPORT.md`**：旧系统到底替换了哪些（逐模块对照 Phase 0 §3.1）；说明哪些底层被保留。
2. **`WORKSPACE-INTEGRATION-REPORT.md`**：三工作区是否真正打通（WorkspaceTaskContract 流转证据）。
3. **`MOTION-LEARNING-REPORT.md`**：图库能否学习并写入 SQLite（含可追溯记录证据）。
4. **`MCP-E2E-REPORT.md`**：能否从主对话一路调用到 Renderer（端到端链路证据）。
5. **`REGRESSION-REPORT.md`**：旧功能（渲染/参数/物理门/取消）与底层安全机制是否回归（对照 §3 回归测试）。

---

## 5. 验收门槛（Gate）

- 任何测试失败不得报告为通过（任务书纪律第 10 条）。
- `status !== 'validated'` 的动作链不得进入执行（架构验收硬约束）。
- 存在第二套 Cubism 参数写入器 → 执行验收直接 FAIL。
- 未经审计的旧执行入口残留 → 迁移验收 FAIL。
