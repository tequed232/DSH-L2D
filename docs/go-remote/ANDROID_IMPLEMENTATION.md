# Android 实时通知实现指南（Kotlin）

本文给出 Kotlin / Jetpack Compose 参考实现。代码是实施模板，集成前需按 minSdk、targetSdk、AndroidX 版本和 DSH Host 协议调整；当前尚未编译验证。

## 1. 推荐模块

~~~text
android/
  app/
  core/model/
  core/transport/
  core/notification/
  core/deep-link/
  feature/chat/
  feature/workspace/
  feature/live2d/
  feature/remote/
  vendor/liveactivity-api/   # optional OEM adapter
~~~

把通用通知能力独立为 core:notification。业务模块发布状态事件，不直接拼接 Notification。

## 2. Kotlin 状态模型

~~~kotlin
@Serializable
enum class RemoteTaskPhase {
    CREATED, CONNECTING, AUTHENTICATING, RUNNING,
    PAUSE_REQUESTED, PAUSED, RESUME_REQUESTED,
    CANCEL_REQUESTED, COMPLETED, FAILED, CANCELLED, DISCONNECTED
}

@Serializable
data class RemoteTaskStatus(
    val taskId: String,
    val revision: Long,
    val title: String,
    val hostName: String,
    val transportLabel: String, // LAN or ECS Relay
    val phase: RemoteTaskPhase,
    val stage: String? = null,
    val progress: Int? = null, // null means indeterminate
    val updatedAtEpochMs: Long
)

fun RemoteTaskStatus.isNewerThan(current: RemoteTaskStatus?): Boolean =
    current == null || (taskId == current.taskId && revision > current.revision)
~~~

只接受同一 taskId 且 revision 更大的状态，避免乱序事件覆盖新状态。没有 Host 进度时显示不确定进度，不得伪造百分比。

## 3. 通知通道

~~~kotlin
object DshNotificationChannels {
    const val REMOTE_TASKS = "remote_tasks"

    fun create(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            REMOTE_TASKS, "远程任务", NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "显示 DSH Remote 远程任务状态"
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        }
        manager.createNotificationChannel(channel)
    }
}
~~~

## 4. 深链与 PendingIntent

~~~kotlin
fun taskPendingIntent(context: Context, taskId: String): PendingIntent {
    val intent = Intent(context, MainActivity::class.java).apply {
        action = "com.dsh.remote.OPEN_TASK"
        data = Uri.parse("dshremote://workspace/task/" + taskId)
        flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    return PendingIntent.getActivity(
        context, taskId.hashCode(), intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
}

fun taskActionPendingIntent(
    context: Context, taskId: String, action: String, requestCode: Int
): PendingIntent {
    val intent = Intent(context, RemoteTaskActionReceiver::class.java).apply {
        this.action = action
        data = Uri.parse("dshremote://task/" + taskId + "/action/" + action)
        putExtra("task_id", taskId)
    }
    return PendingIntent.getBroadcast(
        context, requestCode, intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
}
~~~

Receiver 不直接执行远程操作，只把用户意图交给已认证的会话层。若会话不存在，保存短期、幂等的 action request，并提示用户打开应用重新连接。不要在 BroadcastReceiver 中运行长任务。

## 5. NotificationCompat 适配器

~~~kotlin
class RemoteTaskNotificationAdapter(
    private val context: Context
) {
    private val manager = NotificationManagerCompat.from(context)

    fun render(status: RemoteTaskStatus) {
        val openIntent = taskPendingIntent(context, status.taskId)
        val builder = NotificationCompat.Builder(
            context, DshNotificationChannels.REMOTE_TASKS
        )
            .setSmallIcon(R.drawable.ic_stat_dsh)
            .setContentTitle("DSH Remote · 远程工作区")
            .setContentText(status.title)
            .setSubText(status.hostName + " · " + status.transportLabel)
            .setContentIntent(openIntent)
            .setOnlyAlertOnce(true)
            .setOngoing(status.phase !in setOf(
                RemoteTaskPhase.COMPLETED,
                RemoteTaskPhase.FAILED,
                RemoteTaskPhase.CANCELLED
            ))
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setPriority(NotificationCompat.PRIORITY_LOW)

        val stateLine = when (status.phase) {
            RemoteTaskPhase.CONNECTING -> "正在连接主机"
            RemoteTaskPhase.AUTHENTICATING -> "正在验证安全会话"
            RemoteTaskPhase.RUNNING -> status.stage ?: "远程任务运行中"
            RemoteTaskPhase.PAUSE_REQUESTED -> "正在请求暂停…"
            RemoteTaskPhase.PAUSED -> "任务已暂停"
            RemoteTaskPhase.RESUME_REQUESTED -> "正在恢复…"
            RemoteTaskPhase.CANCEL_REQUESTED -> "正在请求取消…"
            RemoteTaskPhase.DISCONNECTED -> "连接中断，等待安全重连"
            RemoteTaskPhase.COMPLETED -> "任务已完成"
            RemoteTaskPhase.FAILED -> "任务执行失败"
            RemoteTaskPhase.CANCELLED -> "任务已取消"
            RemoteTaskPhase.CREATED -> "任务已创建"
        }

        builder.setStyle(
            NotificationCompat.BigTextStyle().bigText(
                stateLine + "\n主机：" + status.hostName +
                    "\n连接：" + status.transportLabel + " · 端到端加密"
            )
        )

        status.progress?.coerceIn(0, 100)?.let {
            builder.setProgress(100, it, false)
        } ?: builder.setProgress(0, 0, true)

        if (status.phase == RemoteTaskPhase.RUNNING) {
            builder.addAction(
                R.drawable.ic_pause, "暂停",
                taskActionPendingIntent(
                    context, status.taskId, "com.dsh.remote.PAUSE", 101
                )
            )
        } else if (status.phase == RemoteTaskPhase.PAUSED) {
            builder.addAction(
                R.drawable.ic_play, "恢复",
                taskActionPendingIntent(
                    context, status.taskId, "com.dsh.remote.RESUME", 102
                )
            )
        }

        builder.addAction(R.drawable.ic_open, "打开工作区", openIntent)

        if (manager.areNotificationsEnabled()) {
            // Production: use a persisted unique Int notification ID, not hashCode().
            manager.notify(status.taskId.hashCode(), builder.build())
        }
    }

    fun dismiss(taskId: String) {
        manager.cancel(taskId.hashCode())
    }
}
~~~

通知图标应使用单色透明小图标。Android 13+ 未授权通知时，应用内任务页仍需可见。正式实现应分配持久化且唯一的 Int notificationId，避免 taskId.hashCode() 碰撞。

## 6. 前台服务边界

只有用户明确启动持续任务，且任务确实需要后台维持实时连接时，才考虑前台服务。不能把所有远程会话无条件做成常驻服务。

~~~kotlin
class RemoteSessionService : Service() {
    override fun onCreate() {
        super.onCreate()
        DshNotificationChannels.create(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildConnectingNotification()
        ServiceCompat.startForeground(
            this,
            REMOTE_SESSION_NOTIFICATION_ID,
            notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        )
        // Attach to the authenticated session manager.
        // Never put secrets in Intent extras.
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val REMOTE_SESSION_NOTIFICATION_ID = 7001
    }
}
~~~

上面的 dataSync 仅为示意。最终必须依据真实工作类型、目标 Android 版本和 Google Play 政策选择正确类型及权限。若不符合前台服务条件，采用前台连接与断线恢复，而不是滥用 FGS。

## 7. Compose 应用内任务卡片

~~~kotlin
@Composable
fun RemoteTaskCard(
    status: RemoteTaskStatus,
    onOpen: (String) -> Unit,
    onPause: (String) -> Unit,
    onResume: (String) -> Unit
) {
    Card(
        shape = RoundedCornerShape(24.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainer
        ),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(
            Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text("DSH Remote · 远程工作区")
            Text(status.title, style = MaterialTheme.typography.titleLarge)
            Text(status.hostName + " · " + status.transportLabel + " · 端到端加密")
            status.progress?.let {
                LinearProgressIndicator(
                    progress = { it.coerceIn(0, 100) / 100f },
                    modifier = Modifier.fillMaxWidth()
                )
            } ?: LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            Text(status.stage ?: status.phase.name)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledTonalButton(onClick = { onOpen(status.taskId) }) {
                    Text("打开工作区")
                }
                when (status.phase) {
                    RemoteTaskPhase.RUNNING -> OutlinedButton(
                        onClick = { onPause(status.taskId) }
                    ) { Text("暂停") }
                    RemoteTaskPhase.PAUSED -> OutlinedButton(
                        onClick = { onResume(status.taskId) }
                    ) { Text("恢复") }
                    else -> Unit
                }
            }
        }
    }
}
~~~

## 8. 从 Dolphin-Schedule 复用的边界

参考仓库：[tequed232/Dolphin-Schedule](https://github.com/tequed232/Dolphin-Schedule)

建议抽取通用状态与通知机制，不让 DSH Remote 依赖课程领域模型：

~~~text
Dolphin-Schedule
  └── existing live notification
        ├── status/event reducer      -> live-status-core
        ├── notification renderer     -> notification-adapter
        ├── quick action dispatcher   -> action-dispatcher interface
        └── OEM live surface adapter  -> optional vendor module

DSH Remote
  └── RemoteTaskEvent -> LiveStatusCore -> NotificationAdapter
~~~

抽取步骤：
1. 审计 Dolphin-Schedule 当前默认分支的通知入口、状态更新源、PendingIntent、前台服务与许可证。
2. 为创建、更新、点击、完成、取消等现有行为编写测试。
3. 抽取纯 Kotlin 状态 reducer 和接口，不搬迁课表模型。
4. DSH Remote 提供自己的 RemoteTaskEvent 与 action dispatcher。
5. 对照两边测试，确认没有破坏 Dolphin-Schedule 原功能。
6. 保留源项目要求的版权声明与资源授权记录。

本文没有声称已完成源码迁移；必须先对实际仓库代码做审计。

## 9. 安全要求

- 客户端—中继—Host 使用 TLS 1.3；应用层会话再做端到端认证加密，推荐采用经过审计的 Noise XX / IK 模式或等价方案。
- ECS 中继只转发加密字节流，不持有 Host 的应用层会话密钥。
- 通知 action 只携带 taskId 和 action，不携带 token、密钥、文件内容或命令文本。
- Host 对用户身份、taskId、workspace 权限和 action capability 逐项鉴权。
- pause/resume/cancel 使用幂等 requestId、防重放 nonce 和 Host ACK。
- 日志对路径、提示词、命令输出和设备标识脱敏。

## 10. 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| N0 | 通知 UI 示意图与交互规范 | 已写入文档 |
| N1 | Kotlin 状态模型与事件 reducer | 待实现 |
| N2 | 标准 NotificationCompat 通知 | 待实现 |
| N3 | 安全 action dispatcher 与 Host ACK | 待实现 |
| N4 | 前台服务合规性和后台恢复 | 待实现 |
| N5 | Dolphin-Schedule 通用逻辑审计与抽取 | 待审计 |
| N6 | OEM 实时活动适配器 | 待调研 / 按设备实现 |

## 11. 验证清单

- [ ] Kotlin / AndroidX 依赖版本固定并通过编译。
- [ ] revision reducer、状态文案和终态处理有单元测试。
- [ ] 通知 channel、PendingIntent 和深链有仪器测试。
- [ ] Android 13、14、15+ 与不同 OEM 设备通过测试。
- [ ] 通知权限拒绝、撤销和系统关闭通知时应用内状态仍可用。
- [ ] LAN、ECS Relay、切网、断网、Host 重启均可恢复。
- [ ] 过期会话、重放 action、未授权 taskId 和恶意 Intent 被拒绝。
- [ ] 前台/后台/锁屏长时间运行通过耗电测试。
