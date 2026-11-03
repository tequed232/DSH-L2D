# 设置页快照说明

- **来源**：`GET http://127.0.0.1:3080/dsh-l2d/settings`（web profile 真机，curl 原样存档）
- **抓取时间**：2026-11-03 14:09（本地时间）
- **抓取命令**：`curl -s http://127.0.0.1:3080/dsh-l2d/settings -o tools/acceptance/snapshots/settings.html`
- **校验**：HTTP 200；五个分区标题（显示与布局 / 角色与模型 / 情绪与行为 / 动画与性能 / 开发者工具）全部在档
- **对应验收项**：run.mjs 的「E 设置页」
- **局限**：curl 存的是服务端返回的 HTML（含内联样式），不含浏览器渲染后的运行时状态；像素级回归需真机截屏另存
