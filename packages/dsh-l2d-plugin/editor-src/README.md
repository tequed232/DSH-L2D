# editor-src — Motion Graph Lab 模块化拆分源（NE-04）

## 约束

`assets/motion-graph.html` 必须保持**单文件零依赖、file:// 双击可开**。
因此拆分方案是**源码模块 + 构建期内联回单文件**，不是运行时多文件加载。

```
editor-src/
  template.html      HTML 骨架（BUILD 标记保留、已抽取区段的内容清空）
  modules/<name>.js  各区段源码（保持全局变量风格，无 ESM import/export）
```

构建产物：`assets/motion-graph.html`（template + modules 按标记位逐字节内联）。

## 标记协议

标记必须**独占一行**，写在单文件 `<script>` 内部时，`<!--` 是 Annex B 合法行注释
（Script 解析目标），不影响运行，浏览器与 `node --check`（Script 目标）均通过：

```
<!-- BUILD:SPLIT combos -->
var Combos = { ... };
<!-- BUILD:END combos -->
```

区段内容 = SPLIT 行末换行之后 到 END 行首之间的原文，切出/拼回**逐字节保真**，
不做任何格式化或换行规整。

## 命令

```bash
# 从现文件切出模块 + 生成模板（不动 assets 文件）
node tools/motion-graph-build.mjs extract

# 模板 + 模块 → 写回 assets/motion-graph.html（模板不存在时以现文件为模板，内容保全）
node tools/motion-graph-build.mjs build

# 构建结果与现文件逐字节比对，IDENTICAL 即无损；差异时报首个差异偏移与行号，退出码 1
node tools/motion-graph-build.mjs verify
```

## 幂等/无损验收方法

1. **打标记幂等**：只为现文件加 `BUILD:SPLIT/END` 标记（内容仍内联、无模块文件），
   `build` 一次后与 build 前逐字节一致（`cmp` / `verify`）——标记本身零影响。
2. **迁移无损**：`extract` 后立即 `build`，产物必须与迁移前文件逐字节一致
   （`cmp 旧快照 assets/motion-graph.html`）。
3. **语法**：`node --check editor-src/modules/<name>.js`；整页内联脚本需以
   Script 目标检查（复制为 `.cjs` 后 `node --check`，因为 Node 22 会把无
   import/export 的歧义文件按 ESM 解析，而 ESM 禁止 HTML 注释；浏览器 `<script>`
   走的是 Script 目标，以 `.cjs` 检查与之一致）。
4. **回归**：`node tools/dev-server/index.mjs --port 5332` 后访问
   `/dsh-l2d/motion-graph.html?selftest=1`，tab_title 应为十组全绿
   （validate-ok roundtrip-ok sim resizers-ok ctx-ok combo-ok panels-ok console-ok chips-ok jsonpv-ok）。

## 如何抽取下一个模块（规程）

1. 在 `assets/motion-graph.html` 中目标区块（含其头注释）前后各加一行
   `<!-- BUILD:SPLIT <name> -->` / `<!-- BUILD:END <name> -->`（name 用小写连字符）。
2. `cp assets/motion-graph.html /tmp/mg-before.html` 留快照（已有 template.html 时 `verify` 以旧模板构建，
   新标记尚未入模板，此步 verify 会报 DIFF，属预期，不要据此回退）。
3. `node tools/motion-graph-build.mjs extract` —— 模块落盘、模板区段清空。
4. `node tools/motion-graph-build.mjs build && ... verify` —— 必须回到 IDENTICAL，
   且 `cmp /tmp/mg-before.html assets/motion-graph.html` 无输出（纯搬移零语义变化）。
5. `node --check modules/<name>.js` + dev-server selftest 全绿。
6. 之后修改该模块请编辑 `editor-src/modules/<name>.js`，改完 `build` 回写；
   **不要直接改产物中被标记包裹的区段**（会被下次 build 覆盖）。

## 已抽取模块

| 模块 | 原文位置角色 | 说明 |
| --- | --- | --- |
| `combos.js` | `var Combos = {...}`（含头注释） | 自定义组合事件，localStorage `dsh-mg-combos.v1` |
| `panel-layers.js` | `var PanelLayers = {...}`（含头注释） | 监看浮窗图层管理，localStorage `dsh-mg-panels.v1` |
| `hint-bar.js` | `var HintBar = {...}`（含头注释） | 画布操作指南条收起/展开，localStorage 持久化 |
| `rail-chips.js` | `var RailChips = {...}`（含头注释） | 左右栏收起为悬浮 chip，localStorage `dsh-mg-rail-chips.v1` |

两个模块都依赖同 `<script>` 作用域内的前置声明（`esc`、`$$`、`localStorage` 等）
与后置引用（`UI`、`Demo` 等），运行期才解析，因此按模板中的原声明顺序内联即可，
无需（也不得）引入 import/export——否则会改变作用域语义。
