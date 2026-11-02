## DSH-L2D

在 DeepSeek Harness（DSH）界面上叠加一个真实渲染的 Live2D 角色：官方 Cubism 5 Web SDK、
表情 / 动作 / 四肢姿势、AI 工具调用、余额查询、角色缩放、DSH 工作区会话状态联动。

---

## 功能

- Cubism 5 渲染：呼吸、眨眼、表情叠加、动作组、物理输出表识别
- AI 工具通道：`l2d_set_expression` / `l2d_play_motion` / `l2d_set_pose` / `l2d_look_at` /
  `l2d_set_parameters` / `l2d_play_keyframes` / `l2d_reset_pose`
- Emotion_Router：鼠标/系统/媒体/`<mood>`标签 → 统一路由到表情/动作/姿势/视线，带情绪惯性与优先级仲裁
- 眼神/躯体跟随 + 待机视线漂移（拟人微动作）；拖拽时面部微放大、松手平滑回弹
- 外观调整集中在右键菜单「模型外观」子菜单（面部/胸口/裙摆/鞋子），不与拖拽冲突
- 系统联动与媒体律动为可插拔传感器，默认关闭（设置面板开启）
- 病娇彩蛋：右键「邪神模式」两段确认后生效（暗色特效 + 专属台词），防误触
- 戳一戳动作链：随机动作，或让 DeepSeek 生成表情 / 动作 / 姿势 / 视线 / 关键帧组合；连点中断未完成动作链
- 分区互动：摸头亲和、摸胸害羞、点脚穿/脱鞋、拖拽裙摆，右键菜单调整形态
- 体型校正与缩放：基础画布 320×400，缩放 0.6~2.0，三种体型统一视觉系数
- 右键菜单与独立设置面板：不遮挡角色主体
- 余额查询与峰谷价：价格条显示在角色下方，红绿标识当前峰/谷计费
- 自发聊天与聊天动作：完成状态回流最新回复，并按文本映射表情/动作/姿势
- 余额查询：用户自填 DeepSeek API Key，走官方 `/user/balance`
- 工作区联动：读取 DSH 会话状态，聚合为 `thinking / working / attention / error / idle`
  并触发对应表情、姿势和气泡提示

---

## 轮椅玩法 

创建一个新工作区，让把仓库链接（https://github.com/tequed232/DSH-L2D/）
发给 Harness 会话 (如DeepSeek Harness  Codex)，跟着它的提示补全运行所需模型和运行所需SDK 即可

---

## 快速开始（DSH 插件）

1. 下载或构建插件包：

   ```bash
   pnpm install
   pnpm build:renderer
   npm pack ./packages/dsh-l2d-plugin
   ```

2. 解压 `dsh-l2d-*.tgz`，把 `package` 目录链接到 DSH profile：

   ```text
   %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-l2d
   ```

3. 在 profile 的 `package.json` 加入依赖与 bundle：

   ```json
   "dsh-l2d": "file:./node_modules/dsh-l2d"
   ```

   `dsh.profile.bundles` 加入 `"dsh-l2d"`。

4. 在 profile 的 `cordis.patch.yml` 追加：

   ```yaml
   - insert:
       - id: dsh-l2d
         name: dsh-l2d
         config: {}
   ```

5. **重启 DSH**（注入表只在启动时收集一次）。

模型和 Cubism Core 不入库，见下文约束。

---

## 本地验证

```bash
pnpm install
pnpm build:renderer
pnpm dev:server
```

打开 `http://127.0.0.1:5300/overlay-test.html` 可直接测试叠加层、动作、姿势与注入通道。

---

## 模型 / Core 合规约束

### 1. 模型文件不入库、不打进安装包

`DeepSeek免费公皮` 的授权禁止重新分发模型文件，仓库不包含任何模型。
运行时通过 `DSH_L2D_MODEL_DIR` 或默认本地路径加载。

模型署名（使用公开内容时请保留）：原画 神宫凉子 / 建模 霓虹猫_NeonNeko。

### 2. Cubism Core 需自行从官方 SDK 提取

`live2dcubismcore.min.js` 受 Live2D 许可约束，不可提交仓库或第三方 CDN 分发。
请从 [Live2D 官网](https://www.live2d.com/sdk/download/web/) 下载 Cubism 5 SDK for Web，
把 `Core/live2dcubismcore.min.js` 放到本地 `vendor/cubism/...` 路径。

---

## 目录

```text
apps/stage-web/            早期 Web 调试壳
packages/core/             参数仲裁器 ParamMixer
packages/renderer/         Cubism 5 渲染包（构建为插件 assets/renderer.js）
packages/dsh-l2d-plugin/   DSH 插件：宿主路由、overlay、AI 桥、设置
tools/dev-server/          本地零依赖验证服务器
tools/gen-ai-tools/        生成 AI function-calling 工具定义
docs/                      技术方案、行为设计、提示词
```

---

## MCP

`packages/dsh-l2d-mcp` 是一个 stdio 薄壳，把工具转发到本机 `POST /dsh-l2d/ai/call`。
端口用 `DSH_L2D_URL`，否则在 `~/.dsh` 里找端口，最后试调试服 `127.0.0.1:5300`。只接受回环地址。

给 Agent 的工具只有：`l2d_emote`、`l2d_set_expression`、`l2d_play_motion`、`l2d_set_pose`、`l2d_gaze`、`l2d_say`、`l2d_act`、`l2d_get_state`、`l2d_reset`。
`l2d_set_parameters` 和 `l2d_play_keyframes` 不进 MCP。`skipped` / `conflict` 是成对动作的正常返回。
MCP 不会打开 `systemSensor` / `mediaSensor`，这两个开关默认关。

`l2d_act` 的 `priority` 是 `BACKGROUND`、`NORMAL`、`FORCE`。低的不能打断高的，同级可以。`accepted` 只表示占上了槽，播完或被打断看 `action-done` 事件（`start` / `end` / `interrupted`）。`phase` 可用 `listening`、`thinking`、`speaking`、`settle` 四段短链，口型参数仍然不写。

安装与客户端配置见 `packages/dsh-l2d-mcp/README.md`。

## 灵动

姿势切换走三次缓动，停住大约 6 秒后缓回 rest（动作状态机收养的终态不会被自动收回）。
待机微动作由 **Emotion_Router** 以优先级 20 触发：歪头、重心、耸肩、鼓腮、嘟嘴，间隔 20～40 秒。
拖拽、媒体律动、成对动作、戳一戳进行时不做微动作。
`AngleZ` 由身体跟随、微动作、媒体律动三路相加并限幅；关掉媒体律动时这一路回到 0。

可写参数和只读输出的分法见 `docs/参数读写对照.md`。

## 设计文档

- `docs/DSH-L2D-技术方案-v0.1.md`
- `docs/DSH-L2D-技术栈方案-v0.2.md`
- `docs/DSH-L2D-行为系统设计-v0.1.md`
- `docs/AI-模型控制提示词.md`
- `docs/参数读写对照.md`
