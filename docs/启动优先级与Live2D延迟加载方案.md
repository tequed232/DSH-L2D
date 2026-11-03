# DSH-L2D 启动优先级与延迟加载方案

> 状态：提案，供开发实现前评审。本文不代表代码已完成，也不假定 DSH Host 已提供任何未经审计的调度 API。

## 1. 目标与非目标

### 目标

- 优先完成 DSH-L2D 插件注册，让 DSH 主启动流程尽快继续。
- Live2D SDK、WebGL、模型 JSON、纹理、Physics、Motion Manager 等重型工作不得成为插件注册的同步依赖。
- 模型按需加载：用户未打开角色页面时，原则上不创建 WebGL Context、不加载模型纹理。
- 模型加载失败、超时或被取消，不得回滚插件注册，也不得要求重启 DSH 才能重试。
- 全生命周期只保留一个权威 Avatar Runtime；切换标签页/悬浮窗不得重复加载模型或重播动作。

### 非目标

- 不在本阶段重写渲染器、Motion Engine 或 Avatar Runtime。
- 不创建独立 Render Agent 或第二套模型生命周期管理器。
- 不通过未经验证的 DSH 私有 API 强行设置插件启动优先级。
- 不以牺牲 DSH 启动稳定性换取启动时立即显示 Live2D。

## 2. 启动阶段与优先级

| 阶段 | 工作 | 是否阻塞插件注册 | 进入条件 |
|---|---|---:|---|
| P0 Bootstrap | 读取最小配置、建立状态、注册 Host 事件/API、注册标签页/菜单/设置入口 | 是，仅限必要注册 | DSH 加载插件 |
| P1 Runtime Prepare | 动态导入 Live2D Runtime、检查运行环境、准备资源服务 | 否 | P0 注册成功后后台调度 |
| P2 Avatar Load | 读取模型配置、模型 JSON、纹理及必要资源 | 否 | 用户请求显示角色，或明确启用预热 |
| P3 Activate | 创建/恢复唯一 Avatar Runtime，接入渲染循环与行为系统 | 否 | 容器可见且资源准备完成 |
| P4 Idle/Hidden | 降低绘制频率或暂停绘制，保留事件/行为状态 | 否 | 页面隐藏、容器关闭或窗口失焦 |

关键规则：P0 不得 await P1/P2/P3。注册完成后立即向 Host 返回成功；后台任务单独报告状态和错误。

## 3. 生命周期状态

不要使用一个含义模糊的 `initialized` 布尔值表示全部初始化。建议拆分：

```ts
type PluginRegistrationState =
  | "not-started"
  | "registering"
  | "registered"
  | "failed";

type RuntimePreparationState =
  | "not-started"
  | "scheduled"
  | "loading"
  | "ready"
  | "failed";

type AvatarLoadState =
  | "not-requested"
  | "queued"
  | "loading"
  | "ready"
  | "failed"
  | "cancelled";

interface StartupSnapshot {
  plugin: PluginRegistrationState;
  runtime: RuntimePreparationState;
  avatar: AvatarLoadState;
  lastError?: {
    phase: "plugin" | "runtime" | "avatar";
    message: string;
    retryable: boolean;
  };
}
```

各阶段分别记录开始时间、结束时间和失败原因，便于定位真正拖慢启动的环节。

## 4. 推荐模块边界

建议先按职责拆分，不要求一次性新增所有文件：

```text
packages/dsh-l2d-plugin/lib/
  bootstrap.mjs                 # P0：轻量注册入口
  startup-coordinator.mjs       # 阶段状态与任务编排
  runtime-loader.mjs            # 动态导入/准备 Runtime
  avatar-lifecycle.mjs          # 唯一模型实例的加载、激活、卸载
  idle-task-scheduler.mjs       # 可取消的低优先级任务调度
```

若当前目录或模块命名已有等价实现，应扩展既有模块，不要重复造轮子。

### P0：轻量注册

```js
export async function activatePlugin(host) {
  const state = createStartupState();

  // 这里只做注册必需工作；不要导入模型、创建 WebGL 或加载纹理。
  registerPluginEvents(host, state);
  registerBrowserEntry(host, state);
  registerContextMenu(host, state);
  registerSettingsEntry(host, state);

  state.plugin = "registered";

  // 绝不能 await 重型初始化。
  void startupCoordinator.scheduleRuntimePreparation();

  return { status: "registered" };
}
```

如果 Host 要求 activate 返回 Promise，则 Promise 只应等待必要注册操作，不等待 Runtime 或模型加载。

### P1：Runtime 后台准备

- 尽可能使用动态 import，避免插件入口静态依赖重型渲染包。
- 先检查当前 Host、浏览器能力和资源路径；不创建模型实例。
- 使用任务调度器分片执行可分片的 CPU 工作。
- 避免在主线程执行大规模同步 JSON 解析、纹理解码或模型扫描。
- 只有在确认 Worker/异步解码路径受当前 SDK 支持后才采用；不能为了“并行”引入不可控的跨线程状态。

### P2/P3：按需加载与激活

- 用户首次打开角色视图时请求加载。
- 多个同时到达的请求必须合并为同一个 in-flight Promise，禁止重复加载。
- 模型加载使用 AbortController；切换页面本身不应自动取消仍然有效的加载请求。
- 页面关闭/插件停用时，根据生命周期策略取消尚未完成且不再需要的任务。
- 加载成功后由唯一 Avatar Runtime 接管模型；呈现容器只订阅/承载它，不自行 new 第二个模型。
- 错误状态提供重试，不影响设置页、插件菜单和 DSH 其他功能。

## 5. 任务调度与资源优先级

建议任务类别：

| 类别 | 示例 | 调度策略 |
|---|---|---|
| critical | 插件注册、必要 Host 监听器 | 立即执行；尽量短小 |
| user-blocking | 用户主动打开角色后的必要加载 | 高优先级异步任务 |
| background | Runtime 预热、能力扫描 | 空闲时或分片执行 |
| idle | 非必要缩略图、资源索引、诊断信息 | 最低优先级，可推迟/取消 |

调度器应提供最小接口：

```ts
type TaskPriority = "critical" | "user-blocking" | "background" | "idle";

interface ScheduledTask {
  id: string;
  priority: TaskPriority;
  run(signal: AbortSignal): Promise<void>;
}

interface TaskScheduler {
  schedule(task: ScheduledTask): void;
  cancel(id: string): void;
  dispose(): void;
}
```

注意：浏览器的 requestIdleCallback 不是所有宿主环境都保证可用，必须有 setTimeout/微任务等安全回退；回退也不能把大任务同步塞回启动调用栈。任务优先级只影响 L2D 自己的工作队列，不声称能控制 DSH 内部调度器的全局优先级。

## 6. 超时、取消与错误隔离

- 超时必须向底层资源加载传递 AbortSignal；单独 Promise.race 只能停止等待，不能保证停止网络、解码或 GPU 资源分配。
- 每个阶段有独立错误边界。P1/P2/P3 失败不能将 P0 状态改回 failed。
- 重试前清理失败阶段已经创建的临时资源，避免重复 WebGL Context、纹理或事件监听器。
- 插件停用时 dispose scheduler、移除监听器、取消未完成任务；已激活 Runtime 通过既有生命周期接口释放。
- 记录可诊断错误，但避免将完整本地路径、用户数据或敏感配置写入日志。

## 7. 与标签页/悬浮窗呈现模式的关系

呈现模式与 Avatar Runtime 生命周期必须分离：

- embedded / in-app-overlay / floating-window 是容器选择，不是三个独立模型实例。
- 容器切换采用 prepare → attach → transfer-view-state → activate → detach-old-container。
- 动作时间线、当前参数、表情、视线和物理状态由唯一 Runtime 持有；切换容器不得重新播放当前动作。
- 用户关闭所有角色容器时，可进入 idle/hidden；是否卸载模型应由内存策略决定，不应默认立即销毁后又重新加载。
- 设置页面不依赖 Live2D Runtime，可以在模型加载失败时正常打开。

## 8. 可观测性

至少输出以下结构化事件（名称可按现有日志规范调整）：

- `plugin.register.start`
- `plugin.register.done`
- `runtime.prepare.start`
- `runtime.prepare.done`
- `avatar.load.queued`
- `avatar.load.start`
- `avatar.load.done`
- `avatar.load.failed`
- `avatar.load.cancelled`
- `avatar.activate.done`

每条事件携带阶段、耗时、请求来源和可关联的 loadId；禁止记录模型文件内容或用户私密数据。

重点指标：

- 插件注册耗时（P0）
- DSH 启动关键路径是否等待 P1/P2/P3
- 用户打开角色视图到首帧的耗时
- 模型加载失败率、取消率、重试成功率
- 启动期间 WebGL Context 创建数量
- 同一时刻 in-flight 模型加载数量（必须不超过 1）

## 9. 验收标准

### 启动隔离

1. 人为延迟 Runtime import 10 秒，插件仍应先完成注册，DSH 不等待该任务。
2. 人为让模型 JSON/纹理请求失败，DSH 启动、插件菜单和设置入口仍可用。
3. Runtime 准备失败不能把插件状态标记为注册失败。
4. 日志能区分 P0、P1、P2、P3 的耗时。

### 按需加载

5. 用户从未打开角色视图时，不创建 WebGL Context、不加载模型纹理（除非用户明确开启预热）。
6. 首次打开角色视图时触发一次模型加载。
7. 快速连续打开/关闭或多容器请求时，只存在一个模型加载任务和一个 Avatar Runtime。
8. 加载失败后可以重试；重试前临时资源得到清理。

### 生命周期回归

9. 模型加载过程中切换标签页/悬浮窗，不重复加载模型。
10. 容器切换不重播动作、不重置姿势、不丢失当前 Runtime 状态。
11. 插件停用时取消可取消任务并释放监听器/临时资源。
12. 设置页不依赖模型加载成功。

### 测试建议

- 单元测试：状态转换、重复请求合并、取消、超时、错误隔离。
- 集成测试：延迟 Runtime import、模型资源 404、纹理解码失败、连续切换容器。
- 真机验收：冷启动 DSH，记录插件注册完成时间、DSH 可交互时间、首次打开角色后的首帧时间。
- 对比优化前后数据；不要只用“感觉启动更快”作为验收结论。

## 10. 实施顺序

1. **审计现状**：追踪插件入口的静态 import、activate/注册钩子、模型加载调用链，找出启动关键路径中的 await 和同步重活。
2. **建立状态分层**：将 plugin/runtime/avatar 三种状态拆开，添加阶段耗时日志。
3. **拆离重型初始化**：先保证 P0 注册完成后才调度 P1；消除注册路径对模型加载的 await。
4. **按需加载**：把模型加载绑定到角色视图首次可见/用户明确请求。
5. **生命周期收敛**：保证唯一 Avatar Runtime，容器切换只迁移呈现挂载。
6. **补测试与真机验收**：覆盖本节验收标准后再合并。

## 11. 开发评审时必须确认的问题

- 当前 DSH 插件系统的真实注册钩子是什么？activate 是否允许异步？其 Promise 是否被 Host 等待？
- 当前入口有哪些静态 import 会间接引入 Cubism SDK、Pixi、模型资源或初始化副作用？
- 模型加载是否已经存在可复用的单例/in-flight 去重机制？
- 当前 WebGL Context 在哪个函数/时机创建？能否延迟到容器真正可见？
- DSH Host 对插件后台任务、窗口切换和卸载提供了哪些正式 API？必须以代码/文档审计结果为准。
- 现有 Avatar Runtime 的创建、销毁、恢复接口在哪里？禁止新增第二套生命周期所有者。

**评审结论建议：先批准启动边界与验收标准，再由实现者基于真实 Host API 和现有代码调用链提交实现 PR。**
