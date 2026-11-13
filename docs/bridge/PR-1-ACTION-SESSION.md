# PR-1 交付说明 `refactor(bridge): introduce dedicated action session`

- 分支：`feat/pr1-action-session`（基于本地 `main` @ `9628f2d`）
- 日期：2026-11-13
- 状态：**实现完成，测试全绿；未合并、未推送**（按提示词 §六「不得未经授权自动 Merge」）
- 关联裁决：R1 = 接受逻辑会话降级；R7 = 基于本地 main 拉工作分支

---

## 1. 变更文件清单

| 文件 | 变更 |
|---|---|
| `packages/dsh-l2d-db/src/schema.mjs` | `SCHEMA_VERSION` 10 → 11；新增 v11 迁移（加 `action_session_id` 列 + 索引） |
| `packages/dsh-l2d-db/src/bridge-repo.mjs` | `COLS`/`toDomain` 支持 action 列；新增 `claimBridgeWorkspaceSession`（SQL 级 CAS）；`BRIDGE_ACTIVE_SESSION_KEYS` |
| `packages/mcp-bridge/workspace-manager.mjs` | 活动会话改为 chat + action；`ensureSession` 增加进程内 pending 去重 + CAS 回填 + 孤儿上报；`ensureWorkspace` 返回 `actionSessionId` 与 `sessionKind` |
| `packages/mcp-bridge/index.mjs` | `enqueueAction` 归属切到 action session；无可用 session 时明确拒绝（不伪报归属） |
| `packages/mcp-bridge/mcp-tools.mjs` | `l2d_action_enqueue` 的 controlSessionId 取值改为 `actionSessionId \|\| controlSessionId` |
| `packages/mcp-bridge/contracts.mjs` | `Live2DWorkspace` typedef 增 `actionSessionId` / `controlSessionId?` / `sessionKind` |
| `packages/dsh-l2d-plugin/lib/index.js` | `localAgentClient` 增 `kind:'logical-placeholder'`；启动日志打印 chat/action/kind |
| `packages/dsh-l2d-db/test/db.test.mjs` | 迁移计数断言 10 → 11 |
| `packages/mcp-bridge/tests/workspace.test.mjs` | 迁移/列断言对齐 v11；新增 4 组用例（升级、去重、CAS、真实性标记） |

---

## 2. 设计说明

### 2.1 为什么"加列不回填"
提示词 §四：**不得未经检查直接复用旧 Control Session**。因此 v11 只加列，不写
`UPDATE ... = control_session_id`。旧 Control 值原样保留（可追溯/可回滚），下次
`ensureWorkspace` 会**新建** action 会话。已用线上库副本实测（§4.3）。

### 2.2 并发幂等两道闸
1. **进程内**：`WorkBuddySessionController.pending` 按 `workspaceId\0key` 共享同一个
   Promise —— 同一进程内 N 个并发 `ensureWorkspace` 只建一次会话。
2. **DB 级 CAS**：`claimBridgeWorkspaceSession` 用
   `UPDATE ... SET col=? WHERE plugin_id=? AND (col IS NULL OR col='')`，
   跨进程并发时只有一条 changes=1 生效；败者回读赢家 id，并把本次多建的
   `orphanSessionId` 上报调用方（不静默丢弃、不静默覆盖）。

> 为什么不用 `INSERT OR REPLACE`：整行替换会清空已建会话，属于数据丢失路径。

### 2.3 会话真实性（R1 裁决的落地方式）
`ensureWorkspace()` 返回 `sessionKind`：注入客户端声明
`kind:'logical-placeholder'` 时为 `'logical'`。当前宿主即此状态（无真实 A2A 客户端），
因此：

- 验收口径 = **2 个逻辑会话 + 1 个真实宿主会话**（后者由 workspace-agent 持有）；
- 代码与日志明确标注，**不得**据此宣称"恰好两个宿主会话"。

这是把 R1 的事实写进类型与返回值，而不是写在注释里容易被忽略。

---

## 3. 迁移说明

```sql
-- v11（幂等由 schema_migrations 门禁保证；重放不会二次加列）
ALTER TABLE bridge_workspaces ADD COLUMN action_session_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_bridge_workspaces_action
  ON bridge_workspaces (workspace_id, action_session_id);
```

- 作用库：`$DSH_HOME/l2d-bridge.sqlite` 与 `<repo>/data/bootstrap-state.sqlite`（两者同 schema，`bridge_workspaces` 自 v7 已建）
- 只加列、不动既有列，无数据搬迁；`control_session_id` 降级为只读兼容列
- 回滚：删列需 SQLite ≥3.35 `ALTER TABLE DROP COLUMN`，或直接回退代码（旧代码忽略新列，兼容）

---

## 4. 测试命令与真实结果

```bash
node --experimental-sqlite packages/mcp-bridge/tests/workspace.test.mjs   # 12 项
npm run test:bridge     # 全绿
npm run test:db         # 29 项断言组全绿
npm run test:core       # EXIT=0
npm run typecheck       # EXIT=0
```

### 4.1 workspace.test.mjs（新增/改写后 12 项全过）
```
✓ migration v11：bridge_workspaces 含 action_session_id
✓ 迁移幂等：同一库重复 openDb 不重复执行、不报错
✓ B01 首次 import：恰好两个活动会话（chat/action），control 为空
✓ B02 重复 import：复用，不调 createSession
✓ B03 并发导入防重
✓ PR-1 旧库升级：control 原样保留，action 新建（不复用旧 Control）
✓ PR-1 并发同 key：三次并发只建一个会话
✓ PR-1 跨进程竞态：CAS 败者回读赢家 id 并上报孤儿
✓ PR-1 会话真实性：占位客户端 → sessionKind=logical
```

### 4.2 全量回归
- `test:bridge`：9 + 7 用例全绿（含订阅三态、timeout 预算）
- `test:db`：29 项断言组全绿
- `test:core`：EXIT=0（nodegraph-model 10/10 等）
- `typecheck`：EXIT=0

### 4.3 真实库升级验证（不是构造数据）
用线上库副本 `~/.dsh/l2d-bridge.sqlite` → 仓库内临时副本 → `openDb()`：

```
迁移版本: 11
行: [{"plugin_id":"dsh-l2d","workspace_id":"local-dsh-l2d",
      "chat_session_id":"local-dsh-l2d:chat",
      "control_session_id":"local-dsh-l2d:model-control",
      "action_session_id":""}]
bridge_actions: 0
```

结论：旧行 chat/control **零改动**，action 新列为空串（待下次启动补建），`bridge_actions` 行数不变 → **升级不丢数据**。

---

## 5. 遗留与交接（PR-3 接手）

| 项 | 说明 |
|---|---|
| `bridge_actions.control_session_id` 列名 | 值已改为 action 会话 id，但列名未改（本 PR 不动表结构）；PR-3 视需要做列名归一 |
| action 会话的实际使用方 | PR-1 只建会话，尚无人向其派发；派发逻辑属 PR-3 |
| 真实宿主会话接入 | 若后续拿到宿主 A2A 客户端，只需替换 `localAgentClient` 并去掉 `kind`，`sessionKind` 自动变 `host`，manager 零改动 |
| 孤儿会话清理 | `orphanSessionId` 已上报但无清理策略；真实宿主下需补"建会话后未被 claim → 归档"的收尾（逻辑会话下无副作用） |
