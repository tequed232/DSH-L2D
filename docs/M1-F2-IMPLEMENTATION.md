# M1-f 第二批实施报告：Embodied Behavior 闭环集成

> 分支 `feat/m1-f2-behavior-loop` · 基线 = d1+d2+d3+M1-f 第一批（详见 M1-F2-BASELINE.md）
> 实施：impl-f2 / impl-smoke · 审查与真机：Chief · 独立 QA：qa-f2（见 M1-F2-QA-REPORT.md）

## 一、闭环结论（核心问题直答）

**Cue → Intent → Admission → Timeline → Injector 已真正闭环**：

```
EmbodiedCue{channel, operation, value, durationMs, priority, interruptible}
  → compileEmbodiedCue（core 纯函数，fail-closed：未知通道/非法值/interruptible:false 全拒）
  → cueBridge.admit（两道前置：口型参数域拒 · 物理输出须先 own）
  → admitGesture / enqueueGesture（timeline 唯一准入与冲突闸：同通道替换/跨通道并存/低不打断高）
  → 帧 resolve（到期清理 → 释放认领）
  → injector.applyNow(mode:'set')（口型红线/物理守卫/真实下标校验/量程钳制/相位保留）
  → Cubism 参数 → 到期/clear/stop 释放
```

**无第二套写入机制**：`grep applyCueWrites` = 0；`grep setParameterValueById` 在 cue 路径 = 0（仅既有 `writeParam` 助手与注释）。这是本轮 Chief 审查拦截并修复的红线（初版直写 Cubism，已改为 `injector.applyNow`）。

## 二、交付清单

| 层 | 文件 | 规模 | 职责 |
|---|---|---|---|
| core | `packages/core/src/cue-loop.ts` | 393 行 | 组合/生命周期纯状态机（commitCue/tickCue/releaseCue/cueWrites） |
| core | `packages/core/src/embodied-cue.ts` | +导出 mapCueParamValue | 值域单一来源（行为不变） |
| core | `packages/core/test/cue-loop.ts` | 323 行/15 例 | 编译接线/fail-closed/组合/生命周期/幂等 |
| renderer | `packages/renderer/src/app/cue-bridge.ts` | 240 行 | 依赖注入接线（准入双前置/写值端口/释放） |
| renderer | `packages/renderer/src/app/cue-bridge.test.mjs` | 17 例 | 含口型红线/物理未授权/注入拒绝/到期释放 |
| renderer | `packages/renderer/src/index.ts` | +94 行 | admitCue/stopCue/getCueState 具名导出 + 帧 tick + 清账 |
| renderer | `packages/renderer/src/app/param-injector.ts` | +111/-30 | set() 可选 mode 覆盖 · applyStickyEntry 抽取 · applyNow |
| renderer | `packages/renderer/src/app/motion-adapter.ts` | +10 | `embodied.cue` flag（默认 false） |
| plugin | `packages/dsh-l2d-plugin/lib/overlay.js` | +51 | l2d_cue / l2d_cue_stop / get_state diag.cue |
| 验收 | `tools/acceptance/m1-smoke.mjs` | +141 | U10 持有/到期 · U11 拒绝语义 · --m1-cue |
| 验收 | `tools/acceptance/readiness.mjs` | 新增 | 三层就绪门禁（见 M1-SMOKE-READINESS.md） |
| 验收 | `tools/dev-server/index.mjs` | +2 | AI 工具白名单补 cue 两动作 |

## 三、接口

```ts
// renderer 具名导出
admitCue(cue: EmbodiedCue, opts?: { runId?: string; entryId?: string })
  → { accepted: boolean; entryId?: string; cueId?: string;
      admitted: string[]; rejected: {id, reason}[]; flagEnabled: boolean;
      reason?: 'cue-disabled' | 'mouth-param' | 'physics-output-not-owned' | ... }
stopCue(selector?: { channel?: string; target?: string; all?: boolean }) → { stopped: [...] }
getCueState() → { enabled, active: [{channel, params, until}], overlays }

// injector（向后兼容扩展）
set(model, id, value, weight = 1, opts?: { mode?: 'set' | 'add' }): boolean   // 默认行为零变化
applyNow(model, entries, opts?) → { applied: string[], skipped: string[] }     // 复用 set 全部守卫
```

## 四、功能开关

| flag | 默认 | 语义 |
|---|---|---|
| `embodied.cue` | false | 新链路总开关；关闭 = admitCue 恒 disabled、tick 零写、表情零触碰 |
| `embodied.timeline` | false | 手势时间线（d2）；**复合开关 = cue && timeline**，任一关即关闭 |
| `consumerLeaseEnabled` | false | d3 消费者租约（与本批正交） |

## 五、词表与参数绑定（F2-2 复核结论：零改动）

| channel | 参数 | 模型 cdi3 | scale 依据 | 方向 |
|---|---|---|---|---|
| tilt | AngleZ | ✓ | ANGLE_BUS_CAP AngleZ=15（index.ts） | 待真机目视校准（保留符号位） |
| pitch | AngleY | ✓ | gaze 跟随 gy×20 | 同上 |
| yaw | AngleX | ✓ | gx×20 | 同上 |
| lean | LeanInput | ✓ | clamp±30 | 同上 |
| gaze | ParamEyeBallX/Y | ✓ | 画像 ±1 直写 | 同上 |

参数域互不相交（EC-12 断言锁定）；本仓不存在 FaceAngleZ/FaceAngleX（VTS 侧名，首批已更正）。详见 `docs/M1-F2-VOCAB-VERIFICATION.md`。

## 六、验证证据

### 自动化
- `pnpm test:core`：**exit 0，253 断言**（cue-loop 15 + cue-bridge 17 在链）
- `pnpm test:types` PASS · `pnpm -F @dsh/renderer build` PASS · `m1-smoke --selftest` 53 断言 PASS

### 真机（dev-server 通道：真实页面 + 真实模型，readiness 三层 READY 318ms）
| 用例 | 结果 |
|---|---|
| U7 gesture 准入正例 | **PASS**（admitted=["kf:LArm"]） |
| U8 gesture 准入负例 | **PASS**（Agent 独占期间整批拒，独占未释放） |
| U9 gesture 清账复播 | **PASS** |
| U10 cue 持有/到期 | **PASS**（tilt hold 1500ms → 2s 后释放） |
| U11 cue 拒绝语义 | **PASS**（unknown-channel / not-interruptible，零写值） |
| T1/T2/U3/U4 | FAIL 于 dev-server 缺宿主路由/设置页/host-guard（宿主侧 3081 通过）——环境差异非缺陷 |
| 宿主页（3081）写路径 | **BLOCKED**（模型挂载延迟，环境问题，双向二分已定案非代码回归） |

## 七、风险与回滚

| 风险 | 处置 |
|---|---|
| cue 持有期覆盖常规注视/拖拽（last-write-wins，无 weight 平滑） | v1 明确不做；后续批次加过渡曲线 |
| overlay 单槽不叠加 | 与 Cubism 表情语义一致，文档化 |
| transition v1 只占域零写值 | 曲线引用留第二批 |
| 物理输出 cue 的 own TTL=durationMs（长期=24h 兜底） | clear/到期/stop 显式 release，用例 R15/R17 锁定 |
| **回滚** | `embodied.cue=false`（一个常量）→ admitCue 恒 disabled，零代码回退；或 revert 分支 |

## 八、遗留

1. 宿主页模型挂载延迟（环境）——需在 bot DSH 关闭窗口期复测；smoke readiness 已固化
2. cue 方向真机目视校准（tilt/pitch/yaw 符号）——需目视会话
3. 真机 U1/U2/U5（写路径/物理让位）仍依赖宿主页模型就绪
4. QA 独立矩阵见 M1-F2-QA-REPORT.md
