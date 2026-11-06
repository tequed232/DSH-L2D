# DSH Go Remote Live2D 规范索引（优先阅读）

> 来源：https://github.com/tequed232/DSH-GO-Remote-Live2D（2026-11-04 08:24 同步快照）
> **用户指令：本目录是 Android 远程客户端（DSH Go Remote Live2D）的规范落点，后续所有 Agent 在涉及"手机端 / Android / 通知 / 远程"相关工作时，必须先读本目录，再动手。**

## 本目录文件

| 文件 | 行数 | 内容 |
|---|---|---|
| [README.md](README.md) | 211 | 项目总纲：Android 远程工作客户端与 Live2D 具身交互终端（Kotlin 原生 + Jetpack Compose + TS/Web 三层），三大目标（远程工作区 LAN/ECS 中继、Live2D 具身交互、DSH 插件兼容+设备能力） |
| [ANDROID_IMPLEMENTATION.md](ANDROID_IMPLEMENTATION.md) | 332 | Android 实时通知实现指南（Kotlin）：状态模型、通知通道、深链/PendingIntent、NotificationCompat 适配器、前台服务边界、Compose 任务卡片、Dolphin-Schedule 复用边界、安全要求、里程碑、验证清单 |
| [LIVE_ACTIVITY_NOTIFICATION.md](LIVE_ACTIVITY_NOTIFICATION.md) | 138 | 实时通知 / 灵动岛式交互规范：展开卡片 + 紧凑胶囊两形态、状态模型、平台策略、视觉规范 |
| assets/ | — | 示意图 SVG 与角色图 |

## 与 DSH-L2D 主仓的衔接点（Agent 必读）

1. **Live2D 运行时复用**：README 明确移动端"集成 DSH-L2D 的模型呈现与动作运行时"——即本仓 `packages/renderer`（Cubism/Web）与动作链（cue/gesture/limb）是它的技术底座，不重写。
2. **协议兼容**：移动端"优先复用原生 DSH 插件协议与工具定义"——本仓 `packages/dsh-l2d-mcp` 与 `lib/ai-inbox`（租约/fencing）是服务端协议参照。
3. **任务状态通知**：ANDROID_IMPLEMENTATION 的状态模型对应本仓的 workspace-agent 快照与 action 回执（W1/`workspace-action` 生态）。
4. **安全**：远程访问必须走"LAN 直连或 ECS 中继安全隧道"；本机回环服务**不得**直接暴露公网（README/主仓安全条款一致）。

## 状态

- 同步时间：2026-11-04 08:24（上游如有更新，重新对齐需重新同步）
- 上游 README 引用的 `docs/assets/icon.png` 已按原文保留外链（主仓 assets 内已有同名资源）
