# MODEL-404-ROOTCAUSE 结论报告（陆溯源 / 后端席，2026-11-06）

> 任务来源：team-lead 自主批次任务 1。方法：systematic-debugging（先取证→定位→修复，不跳步）。

## 结论（一句话）

**真机服务链无 404**。苏格致在 playwright 合成页复现的「模型 404 → 静态图 404 → 静默 blob」是**复现环境假象**（合成页没有插件 webserver / dev-server 这类静态服务，overlay 的 MODEL_URL 必然 404），**真机不需要修复**，勿据合成页现象改动真机路由。

## 证据链（三层实证）

### 1. 静态链核对（代码级，文件:行）

| 环节 | 证据 | 结果 |
|---|---|---|
| overlay MODEL_URL | overlay.js:2357 `'/dsh-l2d/model/' + encodeURIComponent('大肥鱼.dsl2d.2048.model3.json')` | ✓ 2048 降显存版 |
| 插件路由前缀 | lib/index.js:1322-1333 prefix `/dsh-l2d/model` + `decodeURIComponent` + 扩展名白名单 + 穿越防护 | ✓ |
| MODEL_DIR 解析 | lib/index.js:41-43 `L2D_ROOT = DSH_L2D_ROOT || 'D:/Desktop/DSH-L2D'` → `DeepSeek免费公皮/DeepSeek` | ✓ 本机部署有效 |
| 文件实存 | model3.json 3362B / 大肥鱼.moc3 16.4MB / dsl2d-2048/texture_00~04.png 五张全在 | ✓ |
| moc3/贴图引用 | 2048 model3.json FileReferences.Moc=大肥鱼.moc3，Textures=dsl2d-2048/*.png ×5，Cubism 相对 model3.json 目录解析 | ✓ 全部命中 |

### 2. 路由逻辑逐字节回放（离线，node）

overlay 实际请求 `/dsh-l2d/model/%E5%A4%A7%E8%82%A5%E9%B1%BC.dsl2d.2048.model3.json` 过插件路由逻辑 7 环节：编码 URL → decodeURIComponent → rel=`大肥鱼.dsl2d.2048.model3.json` → 白名单 `.json` ✓ → resolve(MODEL_DIR) ✓ → 穿越检查 ✓ → 文件存在 ✓。**零 404 可能。**

### 3. HTTP 层端到端（真实 dev-server + fetch）

dev-server（tools/dev-server/index.mjs，:222-225 剥离 `/dsh-l2d` 前缀复用同一路由，resolveInside 内部 decode）实测：

```
/dsh-l2d/model/%E5%A4%A7%E8%82%A5%E9%B1%BC.dsl2d.2048.model3.json → 200 application/json 3362B
/model/%E5%A4%A7%E8%82%A5%E9%B1%BC.dsl2d.2048.model3.json          → 200 application/json 3362B
/dsh-l2d/model/%E5%A4%A7%E8%82%A5%E9%B1%BC.moc3                    → 200 application/octet-stream 16498560B
/dsh-l2d/model/dsl2d-2048/texture_00.png                           → 200 image/png 1078769B
```

**dev-server 与真机路由行为一致，均正常服务**——不存在「/model vs /dsh-l2d/model 别名断层」（曾怀疑并提出别名补齐，核实 dev-server:222-225 前缀剥离后撤销，避免引入双重解码缺陷）。

## 未覆盖范围与后续

- **live CDP 抓包未完成**：ws://127.0.0.1:9231 当前无宿主进程监听（桌宠离线）。宿主在线后可用 inspector（Network.requestWillBeSent/responseReceived + Runtime.consoleAPICalled）在真实桌宠页面补抓 model3.json/moc3/texture 的 HTTP 状态与 Console 作终验。静态 + 回放 + HTTP 三层证据已足以定性，live 抓包为补充确认非阻塞项。
- 苏格致的 2328ea6 止血（占位色块气泡明示「立绘渲染占位」）保留无害——它改善所有环境的失败观感，与本结论不冲突。

## 修复动作

无代码修复需求。tools/dev-server/index.mjs 仅追加实证注释（防后人重蹈「别名断层」误判）。