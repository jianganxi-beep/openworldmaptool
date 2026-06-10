# 开发指南 (DEVELOPMENT)

面向开发者（含 AI 助手）的本地开发、调试与协作流程。

---

## 1. 环境准备

- Node.js（建议 18+，支持 ESM 与 `--watch`）
- Git（已配置 user.name / user.email）
- 现代浏览器（Chrome/Edge）

---

## 2. 本地启动

```powershell
cd C:\Users\aryjiang\GameDev\game-map-planner\server
npm install          # 首次
npm start            # 启动，端口 3001
# npm run dev        # 热重载（改 server.js 自动重启）
```

访问：
- 应用：http://localhost:3001/
- 健康检查：http://localhost:3001/api/health

> 前后端同源：后端托管前端静态资源，无需单独起前端服务。

---

## 3. 修改后如何生效

| 改了什么 | 怎么生效 |
|----------|----------|
| 前端 JS / CSS / HTML | 浏览器 **Ctrl + F5 强刷**（后端已设 no-store，不缓存） |
| `server/server.js` | **重启后端**（或用 `npm run dev` 自动重启） |
| 数据库结构 | 改 `server.js` 里的 `CREATE TABLE`；注意已有 `planner.db` 不会自动迁移，必要时删库重建（会丢数据） |

---

## 4. 调试技巧

- **F12 控制台**：前端报错、WebSocket 连接状态都在这里看。
- **WebSocket**：Network → WS 面板可看 `/ws` 的收发帧（presence / layers_changed）。
- **后端日志**：`npm start` 的终端会打印启动信息；可在路由里加 `console.log` 调试。
- **直接测 API**（PowerShell）：
  ```powershell
  curl http://localhost:3001/api/health
  curl http://localhost:3001/api/projects
  ```
- **看数据库**：`planner.db` 是标准 SQLite，可用 DB Browser for SQLite 打开查看。

---

## 5. ✅ 改完代码的自检清单（重要）

提交前务必逐项确认：

1. **JS 语法校验**（吸取历史踩坑 #1）：
   ```powershell
   node --check common\collab_ui.js
   node --check common\collab_sync.js
   node --check common\collab_realtime.js
   node --check server\server.js
   ```
   全部输出无报错（exit 0）才算过。
2. 浏览器 Ctrl+F5 实测：功能正常、F12 控制台无新增红色报错（favicon 404 可忽略）。
3. 新增的交互**没有用 `alert/prompt/confirm`**（用 `#makePanel` 面板）。
4. 新增的写操作**有 try/catch + 状态提示**。
5. 新增的写 REST 接口**有 WS 广播**（`__notifyLayersChanged` / `__notifyProjectDeleted`）。

---

## 6. 新功能开发流程（建议）

1. 读 `AGENTS.md` + `docs/ARCHITECTURE.md`，确认要改哪个模块。
2. 后端：在 `server.js` 加路由 + SQL（prepared statement）+ 广播。
3. 数据层：在 `collab_sync.js` 加对应 REST 封装方法。
4. UI 层：在 `collab_ui.js` 工具条/面板加入口，接 geoman 或面板交互。
5. 实时层（如需）：在 `collab_realtime.js` / `server.js` 加新的 WS 消息类型。
6. 跑自检清单（第 5 节）。
7. 提交：`git add -A && git commit -m "功能: xxx"`，必要时 `git push`。

---

## 7. Git 工作流

```powershell
git status
git add -A
git commit -m "功能: 新增测距工具"
git push
```

- 远程：`origin` → https://github.com/jianganxi-beep/openworldmaptool
- 主分支：`main`
- ⚠️ `git push` 在 PowerShell 里会显示红色（git 把进度写 stderr），看到 `main -> main` 即成功（踩坑 #4）。
- **不提交**：`planner.db*`、`node_modules/`、`verify_*.png`、`preview*.png`（已在 `.gitignore`）。

---

## 8. 常见问题

| 问题 | 排查 |
|------|------|
| 工具条不显示 | 多半是某个 JS 语法错误导致整个 class 加载失败；先 `node --check` 各文件（踩坑 #1） |
| 新建图层/工程没反应 | 看 F12 控制台与状态栏提示；确认后端在 3001 运行；检查写操作 try/catch（踩坑 #3） |
| 文件选择框弹不出 | 检查是否有未关闭的原生 prompt/alert 阻塞（踩坑 #2） |
| 改动没生效 | 前端要 Ctrl+F5 强刷；后端改动要重启 |
| 协作不同步 | 看 WS 是否连上（工具条"🟢N人在线"）；写接口是否加了广播 |
