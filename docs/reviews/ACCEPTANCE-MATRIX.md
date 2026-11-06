# PR #26 验收矩阵（ACCEPTANCE-MATRIX）

> 依据 PR #26 第三方验证要求建立。状态五态：VERIFIED / NEEDS_FIX / PARTIAL / UNVERIFIED / BLOCKED。
> 原则：只有可复现测试输出与运行记录算证据；完成声明不算。本版滚动更新至 2026-11-06 09:10（HEAD `0222e83`）。
> 纪律重申：`accepted`（受理）≠ `validated`（校验通过）≠ `runtime_verified`（运行时实证）——下表严格区分。

## 域 1 · Runtime Timeline（P0）
| 项 | 状态 | 证据 / 缺口 |
|---|---|---|
| 真实 Runtime 事件确认 started/completed/cancelled/failed | **BLOCKED** | 完成信号仍为 lifeMs 时长预估；PR-D 待办。PR-CONVERGE 后队列出队沿用回执 `outcome=completed`（executor 为注入点，真实事件接入后替换 executor 零破坏） |
| 重复/乱序/伪造完成事件、超时无完成处理 | **VERIFIED（队列层）** | action-sequence.test 15 项断言组（FIFO 回归 + 超时预算保护 + pending 不重放），随 PR-CONVERGE 收敛合入 |
| SIGKILL 后 interrupted、不自动重放 | **VERIFIED（队列层）** | breakpoint-lab（真实子进程 SIGKILL，13/13）；不能外推为 Timeline 层 |

## 域 2 · Workspace Observer + Supervisor（P0）
| 项 | 状态 | 证据 / 缺口 |
|---|---|---|
| Observer 事件识别/查重/派发 | **VERIFIED** | P1 `62f5683` + P2 `724f0cd`：observer 17 例 + matcher 12 例全绿；CODE-FIX-2 M4 修复 stop() 生命周期泄漏并加在途 poll 回归（supervisor 34 例，`c04a812`） |
| revision 去重、派发日志、失败留痕 | **VERIFIED** | observer_dispatch_log v9 落库（迁移幂等/回滚/失败不写 migrations 已核对） |
| 事件驱动 + 30-120s 对账兜底 | **VERIFIED（本地）** | StatusReporter 60s 合规周期挂载真机；**idle 不发为 B06 裁决语义**（idle 静默 = 一切正常；心跳文件 l2d-bridge-heartbeat.json 已批准实施中） |
| Observer 不改其他工作区上下文 | **VERIFIED** | obs.negative.no-cross-write / llm-zero / no-composer 三条负面测试全绿 |

## 域 3 · SQLite / Action Cache / 动作链库
| 项 | 状态 | 证据 / 缺口 |
|---|---|---|
| 幂等 / 唯一键 / 事务边界 | **VERIFIED** | actions-repo 19 组（含 duration 三态拒绝 + 链级 totalDurationMs 持久化）+ action-cache + bridge action-queue；test:db 74 ✓ |
| 进程中断后恢复、无脏状态 | **VERIFIED** | breakpoint-lab（真实 SIGKILL） |
| 缓存失效条件 | **VERIFIED** | CODE-FIX-2 L1 统一 cache 守卫（get/set 存在即可缓存，stats 缺失仅不计命中率），回归：无 stats cache 不崩且可命中 |
| 动作链 FIFO 排队 | **VERIFIED** | `a612d43` QUEUE-SERIAL（队头阻塞重试 15s 上限 / pending 不重放 / MAX_SEGMENTS 15）；chain15 断言 15/15 零丢弃顺序正确 |
| 动作时长声明 | **VERIFIED** | `86a7efd` steps durationMs 必填（0~30000）+ 链级 totalDurationMs=Σ(duration+delay)，G 门禁强制 >0 |
| 合批（coalesce） | **VERIFIED** | `9c34c19` 相邻合批 15 次 MCP 调用→≤2 次；chain15 实测声明 22320ms vs 实测 22352ms（偏差 32ms） |
| 15 条通跑规则 | **VERIFIED** | `fa540fa` tests/chain-15（5 组断言，含每步四项计时）；validated 链 2→17 条 |

## 域 4 · Safety Guard / Runtime Adapter
| 项 | 状态 | 证据 / 缺口 |
|---|---|---|
| Agent 无法绕过安全链路直写参数 | **VERIFIED** | 白名单 + set()/own() 双钩点；S1-RACE `0222e83` 补齐 AngleX/Y/Z 短名别名登记（短名与规范名并存 509 参实测）+ AngleZ 总线限幅 15→30 对齐模型范围；S1 断言转绿（AngleZ=20 / hair=0.131 / 物理输出拒绝） |
| 配饰节点不入 Agent 可控集 | **VERIFIED** | accessory-exclusion 全拒 + physics-preservation |
| 动作节点范围 | **VERIFIED** | 8 核心托管 ID + 短名别名（`0222e83`），扩展须显式注册 |

## 域 5 · Dependency Manager（P1）
| 项 | 状态 | 证据 / 缺口 |
|---|---|---|
| npm 扫描/差异预览/分级 | **VERIFIED** | DEP-MGR-1 八模块完成，test:deps 全绿（version-resolver/compat-check/audit-log/scan/transaction/manager） |
| 失败回滚、不污染工作区 | **VERIFIED** | transaction/rollback-manager 测试全绿 |
| 未经确认不自动升级 | **VERIFIED** | autoInstall:false 默认 + CLI 拒绝路径测试 |

## 域 6 · UI-FLOAT（P1）
| 项 | 状态 | 证据 / 缺口 |
|---|---|---|
| 调试 HUD 移除 + 浮动窗口基础 | **VERIFIED** | eea0161/070f146；渲染失败占位色块止血 `2328ea6`（气泡明示+tooltip）；**MODEL-404 结案**：真机服务链 7 环节回放全绿无 404（`54e0992`），合成页 404 = 测试环境假象 |
| 八向缩放/最大化还原/边缘吸附/四断点 | **VERIFIED** | `8d87a11` playwright 38/38（含真实 bug 修复：最大化双击还原被拖拽分支抢占）；容器查询/持久化升级+旧数据迁移 |
| 全局设置入口 + 二级菜单 | **VERIFIED** | `a81095c` settings-entry.js（落位实测正确：侧栏底部账户上方；菜单外观/行为与联动/账户与余额；Esc/外点/键盘焦点循环）；15/15 |
| 动作池读库接线 | **VERIFIED** | `0624a9b` /api/actions→adapter 映射→状态机执行（happy path 4/4 + 追加回归 5/5） |
| S1 sticky 写入 | **VERIFIED** | `0222e83`（见域 4） |
| S2 动作准入（startMotion -1） | **VERIFIED** | `8bb1080` playMotionAsync 目标动作有界预载等待（≤3s）——根因为产品准入真缺陷（404 动作致 _motionCount 永不齐平→缓存未命中走异步 fetch 分支同步返回 -1）；S1/S2/S4 三轮连续稳定复跑全绿 |
| S2/S4 断言页其余项 | **VERIFIED** | S2 PASS / S4 PASS（3 轮稳定）；waitForAllMotions 计数饥饿留渲染席 backlog（不阻塞断言） |

## 域 7 · MCP Bridge 挂载（新增，2026-11-06）
| 项 | 状态 | 证据 / 缺口 |
|---|---|---|
| Bridge/WorkspaceManager/StatusReporter 挂载 | **VERIFIED（装配）** | `a51e8cf` 真机 l2d-bridge.sqlite 生成，schema v10 全 39 表迁移成功；fail-open 设计 |
| l2d_* 工具注册 + gallery 装配 | **VERIFIED（装配）** | `798c503` validateAction 与 /api/actions 同口径；2MB/魔数/穿越护栏在 source 层 |
| Workspace import 双会话（B01 语义真机落地） | **VERIFIED** | `db161d0` 根因修复（挂载段 origin 块级作用域 ReferenceError 被 fail-open 静默吞）→ 真机重启 `mcp bridge ready` + bridge_workspaces 1 行双会话回填 |
| 状态上报文件 | **VERIFIED（语义）** | idle 不发为 B06 裁决；心跳 `98c28d2` 真机 60s 首跳命中（initialized:true, uptimeMs:60008） |
| live CDP 抓包 | **UNVERIFIED** | 脚本已备，宿主在线后补抓 |

## 必测故障清单覆盖度（第三方 §3 对照）
1. SIGKILL/中断/不自动重放 → ✅ 队列层；Timeline 层 ❌（PR-D）
2. 重复/乱序/伪造完成/超时 → ✅ 队列层已覆盖（action-sequence 15 项）
3. Observer 重复 revision/派发失败/重试 → ✅ P1/P2 落地 29 例
4. SQLite 中断/重启/幂等/失效 → ✅
5. Safety Guard → ✅（含短名别名补齐）
6. npm 回滚 + UI 回归 → ✅（test:deps + playwright 85+）

## 修复队列联动
- CODE-REVIEW-1（17 条）：全修（`0ca6d21` 中级 4 + `48f9f23` 低级 13）+ CODE-FIX-2（`c04a812` 中 4 低 7）闭环。
- PR-CONVERGE（PR #27 收敛）：5 commit 链合入，PR 内容 100% 收敛无丢失。
- MODEL-404：结案（真机无 404，`54e0992`）。

## 流程规则（用户裁定，2026-11-05 生效）
**每次完成任务（commit 合入）之后，必须跑 `pnpm run test:chain15`**。通跑不绿不得关闭任务。链库/队列/合批/duration 语义变更时同步更新 tests/chain-15。本规则已实际执行 3 次（PR-CONVERGE 后 / BRIDGE-MOUNT 后 / S1-RACE 后），全绿。

## 结论（2026-11-06 09:00，12:00 验收基线 · HEAD `8bb1080`）
- **主线核心链路全绿**：Runtime 队列 / Observer / SQLite / Safety / DepManager / UI 全域 VERIFIED；Bridge 装配+运行+import+心跳全 VERIFIED。
- 仅存 BLOCKED：Timeline 层真实事件（PR-D 待办，executor 注入点已留）；仅存 backlog：waitForAllMotions 计数饥饿、占位色块失败分类、61 条标注审计。
- 无任何一项虚假 VERIFIED。全量回归基线：test:core / test:db 74 / test:bridge 40 / test:supervisor 34 / test:deps / test:chain15 5 组 / playwright 85+ / 渲染包单测 20。
