# DSH Remote 实时通知 / 灵动岛式交互规范

> 状态：设计规格（待实现）
>
> 本文将 Dolphin-Schedule 的实时通知交互经验迁移为 DSH Remote 的 Android 任务状态入口。它不是 iOS Live Activities API 的直接移植，也不假定所有 Android 厂商都提供统一的“灵动岛”SDK。

## 1. 目标体验

用户在 DSH Remote 中启动远程任务后，即使离开应用，也能从系统通知区域、锁屏（受系统策略限制）以及支持的厂商实时活动区域查看任务状态并执行快捷操作。

设计遵循：
- **DeepSeek App 风格优先**：深色背景、克制的蓝色强调、圆角卡片、清晰的中文信息层级。
- **入口轻量化**：主界面顶部只保留 Workspace、Live2D、Secure Connection 等专属入口；任务过程交给实时通知承载。
- **通知是控制面，不是执行面**：通知操作发送命令给 DSH Host；实际任务仍由 Host 执行。
- **安全状态可见**：显示“端到端加密 / 已连接到主机”等状态，不展示密钥、令牌或敏感路径。
- **降级可用**：厂商扩展不可用时，仍有 Android ongoing notification、应用内任务卡片和工作区入口。

## 2. 示意图

![DSH Remote 实时通知示意图](../assets/live-activity-notification.svg)

### 2.1 展开通知卡片

建议内容：
- 标题：DSH Remote · 远程工作区
- 任务：正在执行「重构 Live2D 动作链」
- 主机：DESKTOP-DEV · LAN / ECS Relay
- 状态：已建立端到端加密连接
- 进度：阶段状态或可验证的百分比；未知时不伪造百分比
- 操作：**打开工作区**、**暂停**（仅当 Host 声明支持暂停时展示）

### 2.2 紧凑胶囊

建议仅显示：
- DSH 图标
- 任务状态点
- 简短阶段名，例如“构建中”
- 发生错误时切换为警告态；完成后显示“已完成”

胶囊是 OEM/系统能力增强，不应作为 Android 全机型的硬依赖。Android 没有一个跨厂商、跨版本统一的 iOS Dynamic Island API。

## 3. 与 Dolphin-Schedule 的复用边界

参考仓库：[tequed232/Dolphin-Schedule](https://github.com/tequed232/Dolphin-Schedule)

可复用的是**状态建模、事件驱动更新、通知生命周期和交互设计思想**，而不是直接复制其业务逻辑：
1. 抽取通用的 LiveStatus / Action / Progress 状态模型。
2. 将原项目的实时通知更新机制封装为独立 Android library（建议模块名 `live-status-core`）。
3. DSH Remote 实现自己的 `RemoteTaskNotificationAdapter`，把 Host 事件映射为通知状态。
4. 保留 Dolphin-Schedule 原有课程提醒业务，不让 DSH Remote 依赖课表领域模型。
5. 对通知权限、前台服务类型、厂商扩展分别做适配和测试。

在正式复用前，团队必须审计 Dolphin-Schedule 当前默认分支的真实源码、许可证、依赖和 Android targetSdk；完成代码来源记录后再抽取。本文不声称已完成代码迁移。

## 4. 状态模型

推荐状态机：

```text
CREATED
  -> CONNECTING
  -> AUTHENTICATING
  -> RUNNING
  -> PAUSE_REQUESTED -> PAUSED -> RUNNING
  -> COMPLETED
  -> FAILED
  -> CANCELLED
  -> DISCONNECTED (可恢复，等待重连)
```

约束：
- 通知状态必须来自 Host 的权威事件或可验证的本地连接状态。
- 断线不等于任务失败；显示“连接中断，尝试重连”。
- 暂停/取消是异步命令，点击后先显示“正在请求…”，收到 Host ACK 后再更新为“已暂停/已取消”。
- 每个任务使用稳定的 `taskId` 和单调递增的 `revision`，拒绝旧事件覆盖新状态。
- 进度范围为 0..100；只有 Host 提供确定进度时才显示百分比。

## 5. Android 平台策略

| 层级 | 实现 | 适用范围 |
|---|---|---|
| L0 | 应用内任务卡片 | 所有设备 |
| L1 | NotificationCompat ongoing notification + action | Android 标准能力 |
| L2 | 前台服务通知（仅在任务确实需要持续运行时） | Android 标准能力，遵守后台启动限制 |
| L3 | OEM 实时活动 / 胶囊 / 锁屏卡片适配器 | 仅在厂商提供公开、可用 API 且设备支持时 |
| L4 | 桌面小组件 / 快捷设置入口 | 后续可选 |

不得通过伪造系统 UI、无障碍服务模拟点击、隐藏通知或绕过系统后台限制来实现“灵动岛”效果。

Android 13+ 需要处理通知运行时权限。Android 14+ 需要声明准确的前台服务类型及相应权限；远程任务如果不符合合法的前台服务类型或后台执行条件，应改用用户主动打开应用时恢复状态，而不是强行常驻。

## 6. 通知交互

| Action | 客户端行为 | Host 确认 |
|---|---|---|
| 打开工作区 | 深链进入指定 workspace/task | 不需要改变任务状态 |
| 暂停 | 发送 `task.pause` 命令 | `task.paused` |
| 恢复 | 发送 `task.resume` 命令 | `task.running` |
| 取消 | 二次确认后发送 `task.cancel` | `task.cancelled` |
| 重连 | 重新建立安全会话 | 新会话认证成功 |

所有远程控制 action 都必须经过当前用户会话授权；通知 PendingIntent 使用显式 Intent、不可变标志和唯一 requestCode。

## 7. 视觉规范

- 背景：深石墨色（接近 #171717），卡片层级用半透明灰阶表达。
- 主强调色：DSH 蓝（建议 #4778F5，最终以设计系统 token 为准）。
- 状态色：运行蓝、成功绿、警告橙、失败红；不可只靠颜色区分状态。
- 卡片圆角：24dp；胶囊高度：56–64dp；触控目标至少 48dp。
- 标题最多两行；主任务名优先于设备名；网络路径作为次级信息。
- 深色模式为默认基线，同时保留动态字体缩放与无障碍对比度。

## 8. 验收标准

- [ ] Android 13+ 首次请求通知权限；拒绝后应用内状态仍可用。
- [ ] 通知显示任务、主机、连接状态；不显示密钥和敏感数据。
- [ ] 任务事件乱序时通过 revision 丢弃旧状态。
- [ ] 断线、重连、Host 离线均有准确文案。
- [ ] 暂停/恢复/取消只在 Host ACK 后更新最终状态。
- [ ] OEM 实时活动不可用时自动降级，不崩溃、不阻断任务。
- [ ] Android 14+ 前台服务类型、权限、启动时机通过审核。
- [ ] TalkBack、字体放大、深色模式和横竖屏通过测试。

## 9. 实施拆分

1. **P0**：定义 `RemoteTaskStatus`、`RemoteTaskAction`、revision 规则。
2. **P1**：实现标准 ongoing notification 与深链。
3. **P2**：实现前台服务生命周期与 WorkManager 恢复/清理策略（不能用 WorkManager 替代实时双向会话）。
4. **P3**：审计 Dolphin-Schedule 并抽取通用通知状态核心。
5. **P4**：按设备厂商建立可选 OEM adapter；每个 adapter 必须有设备检测、API 版本检查和降级路径。
6. **P5**：端到端安全测试、耗电测试、后台限制测试。

## 10. 参考资料

- [Dolphin-Schedule](https://github.com/tequed232/Dolphin-Schedule)
- [Android notifications](https://developer.android.com/develop/ui/views/notifications)
- [Foreground services](https://developer.android.com/develop/background-work/services/foreground-services)
- [Notification runtime permission](https://developer.android.com/develop/ui/views/notifications/notification-permission)
