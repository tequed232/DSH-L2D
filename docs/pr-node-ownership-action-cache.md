# PR: Node Ownership 白名单 + Action Cache + 断点实验（stacked on feat/model-registry）

> 本文件为 PR 正文草稿（gh CLI 与网络在本机不可用，未能实际创建 PR）。
> 创建命令见文末。分支：feat/node-ownership-action-cache（= 38326ed）。

## 修改文件清单
- 新增 packages/renderer/src/app/param-host-policy.ts（+ param-host-policy.test.mjs）
- 修改 packages/renderer/src/app/param-injector.ts（agent/runtime 通道闸门）
- 修改 packages/renderer/src/index.ts（setParameterChecked channel、setParametersRuntime、getCapabilities hostable 附注）
- 新增 packages/dsh-l2d-db/src/action-plan.mjs（compileActionPlan 纯函数，自 run-action.mjs 抽出）
- 新增 packages/dsh-l2d-db/src/action-cache.mjs（createCompiledActionCache LRU）
- 修改 packages/dsh-l2d-db/src/actions-repo.mjs（resolveActionModelHash）
- 修改 tools/runtime-probe/run-action.mjs（改调 compileActionPlan）
- 修改 packages/dsh-l2d-plugin/lib/overlay.js（拖拽/换装改 runtime 通道）
- 重建 packages/dsh-l2d-plugin/assets/renderer.js（构建产物）
- 新增 tests/breakpoint-lab/（13 用例 + bench + acceptance/bench report）

## 架构变化
1. 通道语义：injector.set/own 增加 channel（'agent' | 'runtime'，缺省 runtime）。白名单只约束 agent 通道（setParameters/setParameter/ownParameters 三个外部入口）；keyframes/ambient/pose/gaze/拖拽/换装等 runtime 通道零影响。
2. 白名单：HOST_POLICY{defaultOwnership:'none', unknownParameter:'reject', allowDynamicDiscovery:false, preservePhysics:true}；MANAGED_PARAM_IDS 初始 8 个 ID（已对照大肥鱼模型注册表核实）；扩展仅经 registerManagedIds（口型红线拒绝登记）。
3. 缓存键：`${modelHash}:${actionId}:${version}`（modelHash 来自 resolveActionModelHash = motion_model_bindings join models.package_hash；未绑退化 unbound 桶单列计数）；LRU 命中重插、in-flight Promise 并发合并、load 抛错不缓存、snapshot 钩子保证版本与内容同快照。
4. 失效触发点：版本推进由 getVersion 自动感知；parameters 表 Hard 范围变异（upsertParameter 等）后由调用方显式 cache.invalidate(modelHash)（裁决 2，无 schema 变更）。
5. 断点实验四组：cache（hit/miss/LRU/version+range 失效）、recovery（sqlite-reopen / process-restart / interrupted-execution / corrupted-cache，真实子进程 SIGKILL）、ownership（whitelist / accessory-exclusion / physics-preservation）、fault-injection 底座。

## 提交链（feat/node-ownership-action-cache）
- a7470a2 feat(renderer): Node Ownership 参数托管白名单（agent 通道）
- 9cee609 feat(db): Action Cache 编译计划 LRU + run-action 编译逻辑抽纯函数
- 7bfc6e6 feat(renderer): UI 本地交互改走 runtime 通道
- 53a4f9f test(breakpoint-lab): 断点实验工程（真实子进程 SIGKILL 恢复）
- 38326ed bench(breakpoint-lab): Action Cache 性能基准 + 渲染包重建

## 测试命令与真实结果（本机 win32/x64, node v22.22.2）
- pnpm -F @dsh/stage-web typecheck（vue-tsc）→ Exit 0
- test:core 相关项（param-ownership / param-host-policy 6 / keyframe-admission / param-guards / host-guard / yandere-preempt 10 等）→ 全过
- test:db（db / actions-repo 14 / action-cache 11 / model-adapter 11 / ingestion-pipeline 22 / task-contract 11 / capability-registry 11）→ 全过
- pnpm test:breakpoint → **13/13 通过（667ms）**，报告 tests/breakpoint-lab/reports/acceptance-report.json
- run-action 实跑重构前后逐字段一致（verdict/applied/skips/channels/movedParams）
- pnpm bench:action-cache → reports/bench-report.json（真实测量）：
  cold-read P50 0.178ms / P95 0.351ms / P99 1.333ms；cache-hit P50 0.015ms（命中率 99.9%，约 12×）；cache-miss P50 0.156ms（128 容量淘汰压力）；mixed-1000 命中率 90.1%；并发 50 同键 wall 0.97ms（in-flight 合并 1 次 load）。错误率 0。

## 未解决问题
1. 渲染包（assets/renderer.js）已重建并包含 runtime 通道改动，但拖拽/换装端到端恢复需浏览器实测复验（由实测席另行安排）。
2. 缓存无命中校验（信任编译产物），validate 钩子按需后补（已勘察为已知语义）。
3. index.ts writeParam 直写助手（gaze 内部通道用）是否加 channel 断言硬化，待裁决。

## 创建命令（网络/gh 就绪后）
gh pr create --base feat/model-registry --head feat/node-ownership-action-cache \
  --title "feat: Node Ownership 参数托管白名单 + Action Cache（LRU）+ 断点实验" \
  --body-file docs/pr-node-ownership-action-cache.md
