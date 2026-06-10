# AGENTS.md — AI 协作开发约定

> 本文件供 AI 编码助手（Claude Code / Codex / Gemini CLI 等）在改动本项目前**必读**。
> 目的：快速理解项目、遵守既定约定、避免重复踩坑。
> 人类开发者也建议先读本文件 + `Readme.md`。

---

## 1. 项目是什么

**游戏地图规划工具（多人协作版）** —— 给开放世界游戏做地图规划的在线协作工具。
5~6 人可同时在同一张游戏地图底图上划定区域、标记点位、规划路线，改动实时同步。

- 灵感参考：mapgenie.io 这类游戏交互地图。
- 基础框架：fork 自 `interactive-game-maps/template`（Leaflet 技术栈），在其上**加了后端 + 实时协作能力**。
- GitHub：https://github.com/jianganxi-beep/openworldmaptool

---

## 2. 技术栈（不要随意更换）

| 层 | 技术 | 说明 |
|----|------|------|
| 地图引擎 | **Leaflet 1.9.4** | 用 `CRS.Simple` 像素坐标系（不是经纬度），适合游戏图片底图 |
| 绘图编辑 | **leaflet-geoman 2.16** | 点/线/多边形/矩形/圆的绘制与编辑 |
| 聚合 | leaflet.markercluster 1.5.3 | |
| 图标 | FontAwesome 6.5.1 | |
| 前端 | **原生 ES Module + Class（无框架、无构建）** | 直接 `<script>` 引入，**不要引入 React/Vue/打包器** |
| 后端 | **Node.js + Express 4** | ESM（`"type":"module"`） |
| 数据库 | **better-sqlite3**（单文件 SQLite） | 同步 API，零配置，适合小团队 |
| 实时 | **ws（WebSocket）** | presence + 图层变更广播 + 软编辑锁 |

> ⚠️ 前端**故意保持零构建**。所有依赖走 CDN 或本地静态文件。新增前端逻辑请继续用原生 class，不要引入打包工具链。

---

## 3. 目录结构地图

```
game-map-planner/
├── index.html              前端入口（CDN 依赖 + 脚本引入顺序在此）
├── app.js                  前端启动脚本：建地图 / BasemapManager(底图管理) / 实例化协作系统
├── common/                 ← 核心前端模块（本项目主要改这里）
│   ├── collab_sync.js      【数据层】CollabSync 类：REST 调用、轮询、乐观锁、IconLibrary 图标库、要素弹窗
│   ├── collab_ui.js        【UI 层】 CollabUI 类：顶部工具条、各种浮动面板、绘图工具接入  ← 最大文件，最常改
│   ├── collab_realtime.js  【实时层】CollabRealtime 类：WebSocket 客户端、断线重连、presence
│   ├── collab_style.css     协作工具条与面板样式
│   ├── interactive_*.js     template 框架原始代码（地图/图层基类，一般不动）
│   └── .gitrepo             git-subrepo 元数据（template 自带，勿手改）
├── server/
│   ├── server.js           后端全部逻辑：Express REST + SQLite + WebSocket（单文件）
│   ├── package.json        后端依赖与启动脚本
│   └── planner.db*         运行时 SQLite 数据库（已 gitignore，勿提交）
├── docs/
│   ├── ARCHITECTURE.md     架构详解（数据模型 / API / 模块职责）
│   └── DEVELOPMENT.md      开发与调试指南
├── Readme.md               面向用户/新人的项目说明
└── AGENTS.md               本文件
```

> 后端通过 `express.static` 把上级目录（前端）一起托管，所以**前后端同源**，访问 `http://localhost:3001/` 即整个应用。

---

## 4. 启动与验证（标准流程）

```powershell
# 1. 安装后端依赖（首次）
cd server
npm install

# 2. 启动（前后端一体，端口 3001）
npm start
# 或开发热重载： npm run dev

# 3. 浏览器访问
#    http://localhost:3001/
#    健康检查： http://localhost:3001/api/health
```

改完前端 JS，**Ctrl+F5 强刷**即可（后端对静态资源设了 no-store，无需重启后端）。
改了 `server.js` 才需要重启后端。

---

## 5. 编码规范

- 前端模块用 **ES Class + 私有字段（`#xxx`）**，沿用现有风格。
- 注释、UI 文案、状态提示统一用**中文**。
- 后端 SQL 用 better-sqlite3 的 prepared statement，**禁止字符串拼接 SQL**。
- 图层写操作必须走**乐观锁**：带 `version`，409 冲突要处理（已有 `saveLayer` 范式，照抄）。
- 任何会改数据的 REST 写接口，成功后要调用 `global.__notifyLayersChanged` / `__notifyProjectDeleted` 广播，否则其他协作者不会实时刷新。
- **不要用阻塞式原生对话框**（`alert` / `prompt` / `confirm`）——会阻塞文件选择框等交互（见踩坑#2）。一律用页面内浮动面板（`#makePanel` 范式）。

---

## 6. ⚠️ 历史踩坑教训（重点，避免重复犯错）

### 踩坑 #1：编辑大文件时吞掉方法签名 → class 结构断裂
- **现象**：`Uncaught SyntaxError: Private field '#xxx' must be declared in an enclosing class`，整个 `CollabUI` 加载失败、工具条消失。
- **根因**：用 replace 编辑 `collab_ui.js`（740 行的大类）时，误删了相邻方法的签名行 `#openNewLayerPanel() {`，导致后续语句裸露、`}` 多出 1 个、class 提前闭合。
- **教训 / 规范**：
  1. 改完任何 JS 文件，**必须用 `node --check <file>` 做语法校验**再交付。
  2. `collab_ui.js` 很大，编辑时务必带足上下文锚点，确认没破坏 class 的 `{}` 配对。
  3. 快速排查括号失衡：`(Get-Content x.js -Raw | Select-String '\{' -AllMatches).Matches.Count` 对比 `\}` 数量。

### 踩坑 #2：原生 prompt/alert 阻塞文件选择框
- **现象**：点"选择文件"无法弹出系统文件对话框，但填 URL 可以。
- **根因**：页面上有未关闭的原生 `prompt`/`alert` 模态，浏览器机制会阻止 `<input type=file>` 弹窗。
- **规范**：所有交互改用非阻塞的页面内面板（`#makePanel`）。

### 踩坑 #3：前端写操作缺错误处理 → 静默失败
- **现象**：点"新建图层"没反应、无提示。
- **根因**：`createLayer` 失败时没有 try/catch，流程静默中断。
- **规范**：所有 `await this.#sync.xxx()` 写操作都要 try/catch + `this.#setStatus(...)` 给用户反馈；`createLayer/deleteProject` 等要校验 HTTP 状态码并抛错。

### 踩坑 #4：PowerShell 把 git 的 stderr 显示成红色"错误"
- **现象**：`git push` 输出一片红，看起来失败了。
- **真相**：git 把进度信息写到 stderr，PowerShell 默认渲染成红色。看到 `* [new branch] main -> main` 就是**成功**。
- **规范**：判断 git 成功与否看关键行 + `git status`，不要被红色输出误导。

---

## 7. 关键约定速查

- 坐标系：`L.CRS.Simple`，鼠标坐标 = `(lng=X, lat=Y)` 像素值。
- 底图：运行时可换，配置存 `localStorage('planner:basemap')`，由 `BasemapManager`（app.js）管理。
- 图标库：自定义点位图标存 `localStorage`，由 `IconLibrary`（collab_sync.js）管理。
- 协作数据：**只在后端 SQLite**，前端不做本地持久化（localStorage 仅存 UI 偏好/底图/图标）。
- 导入/导出 GeoJSON：定位为**备份 / 交付给游戏引擎 / 批量录入**，不是协作的主数据通道。

---

## 8. 提交规范

- 每完成一个**可验证的功能或修复**就提交一次，保持历史清晰。
- commit message 用中文，格式：`类型: 简述`，如 `修复: 补回被吞的方法签名`、`功能: 新增测距工具`。
- 提交前确保：相关 JS `node --check` 通过；不提交 `planner.db*` / `node_modules` / `verify_*.png`。
