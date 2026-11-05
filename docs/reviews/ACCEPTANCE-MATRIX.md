# PR #26 验收矩阵（ACCEPTANCE-MATRIX）

> 依据 PR #26 第三方验证要求建立。状态五态：VERIFIED / NEEDS_FIX / PARTIAL / UNVERIFIED / BLOCKED。
> 原则：只有可复现测试输出与运行记录算证据；完成声明不算。初版矩阵 = 现有证据如实映射（2026-11-05 21:08），后续随修复 commit 与复测更新。
> 纪律重申：`accepted`（受理）≠ `validated`（校验通过）≠ `runtime_verified`（运行时实证）——下表严格区分。

## 域 1 · Runtime Timeline（P0）
| 项 | 状态 | 证据 / 缺口 |
|---|---|---|
| 真实 Runtime 事件确认 started/completed/cancelled/failed | **BLOCKED** | 现链路完成信号为 lifeMs 时长预估（PR-A 侦察实证：kfTick 边界 / motionStopTimer / armActEnd 均无 Timeline 事件源）。Runtime 层补事件 = PR-D 待办，未实施 |
| 重复/乱序/伪造完成事件、超时无完成处理 | **UNVERIFIED** | 依赖 Timeline 事件层，尚未存在 |
| SIGKILL 后 interrupted、不自动重放 | **VERIFIED（队列层）** | breakpoint-lab interrupted-execution / process-restart / sqlite-reopen（真实子进程 SIGKILL，13/13，tests/breakpoint-lab/reports/acceptance-report.json）；注意：这是动作队列层证据，不能外推为 Timeline 层 |

## 域 2 · Workspace Observer + Supervisor（P0）
| 项 | 状态 | 证据 / 缺口 |
|---|---|---|
| Observer 事件识别/查重/派发 | **UNVERIFIED** | SUPERVISOR-P12 实施中（observer.mjs / action-matcher.mjs 在工作树，未 commit 未跑全量用例） |
| revision 去重、派发日志、失败留痕 | **UNVERIFIED** | observer_dispatch_log v9 表设计中，未落库 |
| 事件驱动 + 30-120s 对账兜底 | **UNVERIFIED** | 轮询兜底已在设计（StatusReporter 已验证 30-120s 强校验，status-reporter.test 7/7）；事件推送层未建 |
| Observer 不改其他工作区上下文 | **UNVERIFIED** | obs.negative.no-cross-write 用例在 TEST-PLAN，未实现 |

## 域 3 · SQLite / Action Cache
| 项 | 状态 | 证据 / 缺口 |
|---|---|---|
| 幂等 / 唯一键 / 事务边界 | **VERIFIED** | actions-repo.test 14 项 + action-cache.test 11 项 + bridge action-queue.test 11 项（requestId 幂等 B15）全绿（隔离 worktree 复跑 2026-11-05） |
| 进程中断后恢复、无脏状态 | **VERIFIED** | breakpoint-lab sqlite-reopen / corrupted-cache / process-restart（真实 SIGKILL） |
| 缓存失效条件 | **PARTIAL** | version-invalidation + range-update-invalidation 有用例；参数范围更新的调用方 invalidate 触发点未在全部路径接线 |
| 并发 | **PARTIAL** | 同键 in-flight 合并有断言；多进程并发未测（单进程互斥现状） |

## 域 4 · Safety Guard / Runtime Adapter
| 项 | 状态 | 证据 / 缺口 |
|---|---|---|
| Agent 无法绕过安全链路直写参数 | **VERIFIED** | param-host-policy 白名单 + injector set()/own() 双钩点（agent 通道），param-host-policy.test 6 项 + host-guard/param-guards 回归；端到端取证 whitelist-evidence（A1 PositionX 走 agent 通道被 not_hostable 拒、A3 runtime 通道放行） |
| 配饰节点不入 Agent 可控集 | **VERIFIED** | breakpoint-lab accessory-exclusion（Clothes1/2/4/5、Hair、Rotation84-87、Ear 类全拒）；物理输出保护 physics-preservation |
| 动作节点范围 | **VERIFIED** | 仅 8 个核心托管 ID（AngleX/Y/Z、BodyAngleX/Y/Z、EyeBallX/Y），扩展须 registerManagedIds 显式 |

## 域 5 · Dependency Manager（P1）
| 项 | 状态 | 证据 / 缺口 |
|---|---|---|
| npm 扫描/差异预览/分级 | **UNVERIFIED** | DEP-MGR-1 实施中（8 模块成形，测试收尾），未 commit |
| 失败回滚、不污染工作区 | **UNVERIFIED** | update-transaction/rollback-manager 代码在树，事务级测试未跑全 |
| 未经确认不自动升级 | **UNVERIFIED** | config 默认 autoInstall:false 已定，CLI 拒绝路径待验证 |

## 域 6 · UI-FLOAT（P1）
| 项 | 状态 | 证据 / 缺口 |
|---|---|---|
| 调试 HUD 移除 + 浮动窗口基础（拖拽/缩放/记忆/clamp/折叠） | **PARTIAL** | eea0161 / 070f146；playwright 17/23（6 项为用例坐标伪失败待重写，1 折叠态 CSS bug 已修待复跑）；截图 data/acceptance-overlay/ |
| 八向缩放/最大化还原/边缘吸附/四断点 | **UNVERIFIED** | 里程碑③实施中 |
| 全局设置入口（侧边栏/DSH-Bot 模式/窄屏） | **UNVERIFIED** | 里程碑④未开工 |
| 设置入口不遮挡现有内容 | **UNVERIFIED** | 待③④落地后按 Flex 布局实测 |

## 必测故障清单覆盖度（第三方 §3 对照）
1. SIGKILL/中断/不自动重放 → ✅ 队列层已覆盖（breakpoint-lab）；Timeline 层 ❌
2. 重复/乱序/伪造完成/超时 → ❌ 待 Timeline（PR-D）
3. Observer 重复 revision/派发失败/重试 → ❌ 待 P12 落地
4. SQLite 中断/重启/幂等/失效 → ✅ 已覆盖（breakpoint-lab + cache/queue 测试）
5. Safety Guard 拒非法参数、配饰不入可控集 → ✅ 已覆盖（单测+端到端取证）
6. npm 回滚回退 + UI 模式回归 → ❌ 待 DEP-MGR-1 / UI-FLOAT ③④

## 修复队列联动
CODE-REVIEW-1（17 条：4 中 13 低）：中级 4 条已修 `0ca6d21`（actions-repo chainHash 键序/快照补偿/provenance 配对、workspace-agent previousState）——与域 3 幂等证据直接相关；低级 13 条修复中。

## 结论
- 当前**无任何一项虚假 VERIFIED**：Timeline 层诚实标 BLOCKED（预估时长非真实事件），其余按证据状态映射。
- 端到端链路（Agent intent → … → Observer → status feedback）为 **UNVERIFIED**：需 PR-D（Timeline 事件）+ P12 落地后才具备验证条件。
- 闭环要求（第三方初审 → 修复 commit → 复测 → 终裁）采纳为本矩阵的更新流程。
