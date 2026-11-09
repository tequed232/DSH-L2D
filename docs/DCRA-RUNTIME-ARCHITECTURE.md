# DCRA：Dual Runtime · Single Bridge 架构目标（2026-11-09 正式立项记录）

> 状态：**架构目标记录，未启动实现**。当前仅允许 NE 批次保持 Runtime 无关的兼容性设计。
> 冻结约束（评审裁定）：Node Editor Stabilization 完成前，不开发 VTS Adapter、不做多 Runtime 并行、不动 Cubism 参数控制底层。
> 依据：用户评审（双 Runtime Provider 架构）+ 仓库现状核查（tools/vts-adapter/ 已存在模型资源转换与能力扫描，非完整 WS 控制适配器）。
> 环境可用性（2026-11-09 用户确认）：本机可通过 Steam 安装 VTube Studio（免费；去水印为一次性 DLC，与 API 无关）。Steam 版同样内置插件 API：在 VTS 设置中启用 API 即开启本地 WebSocket 服务器，默认 ws://localhost:8001（端口占用自动递增，可手动改）；首次连接需在 VTS 内弹窗批准授权并返回 token。DCRA-02/03 的真机验证环境因此可用。

---

## 一、架构目标

DSH-L2D 最终采用**双 Runtime Provider 架构**：Cubism 与 VTube Studio 共存安装、**择一激活**（不是两个渲染器同时控制同一角色）。Agent / MCP / Node Editor / Actions Lib 保持不变，用户在设置中选择当前运行时。

核心原则：**Bridge 不关心动作最终由谁执行，只关心动作是否被接受、执行中、完成、失败或取消。**

## 二、分层设计（在既有 Bridge 与底层 Runtime 之间加一层）

```
DSH Agent / LLM / User Interaction          —— 统一行为意图来源（不变）
MCP Bridge + Workspace Manager              —— 工具注册、会话、权限（保留）
Unified Action Gateway                      —— ActionQueue·Executor·Receipts·Cancellation（保留，加路由）
Runtime Provider Manager                    —— 选择/初始化/健康检查/切换/能力协商（新增）
  ├─ CubismAdapter                          —— 现有链路：overlay → renderer → Cubism SDK
  └─ VTubeStudioAdapter                     —— 新链路：node host → WebSocket → VTS
```

现有节点图执行链的插入点：

```
Graph → segments → executeActionSequence → createInboxActExecutor → aiInbox
  → overlay → Cubism Renderer                       （现状）
  → Runtime Provider Manager → CubismAdapter | VTSAdapter   （目标）
```

## 三、Provider 统一接口（设计稿，实现前须评审）

```ts
interface RuntimeProvider {
  id: "cubism" | "vtube-studio";
  initialize(): Promise<void>;
  getStatus(): Promise<RuntimeStatus>;
  getCapabilities(): Promise<RuntimeCapabilities>;
  execute(action: RuntimeAction, ctx: ExecutionContext): Promise<RuntimeReceipt>;
  cancel(executionId: string): Promise<void>;
  dispose(): Promise<void>;
}
```

**能力描述禁止简单布尔**——VTS 可注入参数 ≠ 拥有 Cubism 逐帧控制权：

```ts
interface CapabilityDescriptor {
  supported: boolean;
  controlMode: "direct" | "hotkey" | "parameter-injection" | "unsupported";
  parameters?: string[];
  limitations?: string[];
}
```

## 四、动作映射（Cubism ↔ VTS）

| DSH 动作 | Cubism | VTube Studio | 备注 |
|---------|--------|-------------|------|
| expression | 直接播放 Expression | Expression API / Hotkey | — |
| motion | Cubism Motion | **Hotkey**（非等价：VTS 不提供任意 Motion 播放接口） | 能力协商必须如实标注 |
| pose / look | 参数控制 | 参数注入（限频） | 见下方 VTS 约束 |
| delay | 本地调度 | 本地调度 | Runtime 无关 |
| keyframes | 本地轨迹插值（高精度） | `InjectParameterDataRequest` 注入 | **Cubism 保留高精度轨迹；VTS 用限频注入（先测 10~20Hz），不当作 60FPS 写入接口** |
| physics | Cubism Physics | VTS 原生物理 | **切换到 VTS 后 DSH 不得对相同参数再施加 Cubism Physics** |

VTS 硬约束：受控参数至少每秒发送一次否则控制权丢失；同一参数不可被两个插件以 set 模式独占写入。

## 五、切换状态机（设置页 Runtime Selector）

`Validate Target → Quiesce Current（暂停新任务/取消或完成旧任务）→ Release Current（释放参数控制权）→ Initialize Target → Capability Negotiation → Commit Switch（更新 activeRuntime，恢复队列）→ Rollback（失败保留原 Provider）`

状态模型（preferred ≠ active，防「VTS 未启动却以为切换成功」）：

```ts
interface RuntimeSelection {
  preferredRuntime: "cubism" | "vtube-studio";
  activeRuntime: "cubism" | "vtube-studio" | null;
  status: "ready" | "switching" | "disconnected" | "error";
}
```

## 六、现有模块处置

| 模块 | 处置 |
|------|------|
| Live2DMCPBridge / WorkspaceManager / StatusReporter / ModelActionQueue / HttpActionExecutor / ai-inbox / nodegraph.mjs / host-guard.mjs / tools/vts-adapter | 保留；StatusReporter 扩展 Runtime 状态、Queue 加切换期冻结、Executor 加 Provider 路由、nodegraph 加能力检查、host-guard 加 Runtime-aware 校验、vts-adapter 保留转换功能并补 API 适配器 |
| overlay.js | Cubism 专用逻辑留在原 Provider，不承担 VTS 控制 |

## 七、分期与验收标准

| 阶段 | 任务 | 状态 |
|------|------|------|
| NE-01 | NodeDef / 执行上下文 / 回执保持 Runtime 无关（已有ExecutionContext雏形于 nodegraph-runs） | ✅ NE-01 已按此设计交付 |
| NE-03 | Inspector 展示 Provider、模型与实际执行能力 | 待 NE-03 迭代 |
| NE-04 | Runtime Contract 文档（本文档）+ 版本兼容测试 | 文档 ✅ |
| DCRA-01 | Runtime Provider Manager | 未启动 |
| DCRA-02 | VTubeStudioAdapter（参考 Hawkbat/VTubeStudioJS，MIT；官方 API DenchiSoft/VTubeStudio） | 未启动 |
| DCRA-03 | 双 Runtime 切换、恢复、回归 | 未启动 |

**三条验收标准**（DCRA-03 验收时逐项检查）：
1. 同一份节点图在两个 Runtime 下都能通过能力检查，或明确报告不支持的节点；
2. 切换 Runtime 不需要重连 MCP、重建 Workspace 或修改 Agent 工具定义；
3. VTS 断线不得导致 Cubism Runtime 和整个 DSH-L2D Bridge 一起崩溃。

## 八、VTS 对接要点（本机 Steam 环境）

- 连接串：ws://localhost:8001/（或 ws://127.0.0.1:8001/），首请求 APIStateRequest 探测；currentSessionAuthenticated: false 时弹授权。
- 所有请求须带 apiName: VTubeStudioPublicAPI + apiVersion；可选 requestID 便于日志定位。
- 握手授权一次后 token 持久化在 VTS 侧；插件名建议 DSH-L2D-Bridge。
- Steam 版与官方版 API 完全一致（同一程序分发），无差异适配成本。

## 九、当前合规性确认

NE-01~04 交付物已满足「Runtime 无关」约束：
- ExecutionContext（nodegraph-runs 注册表）不含 Runtime 假设；
- receipts 形状继承 executeActionSequence 既有契约；
- 执行链插入点唯一（run 路由的 executor 包装），未来插 Provider Manager 只需改这一处。
