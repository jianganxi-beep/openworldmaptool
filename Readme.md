# 游戏地图规划工具（多人协作版）

> 给开放世界游戏做地图规划的**在线多人协作工具**。
> 5~6 人可同时在同一张游戏底图上划区域、标点位、规划路线，改动实时同步。

GitHub: https://github.com/jianganxi-beep/openworldmaptool

---

## ✨ 功能

- 🗺️ **自定义游戏底图**：上传本地图片或填 URL 即可替换底图，设置持久化
- 📍 **标记点位**：在地图上放置标记，支持自定义图标（BOSS / 宝箱 / 传送点等）
- ✏️ **划定区域 / 路线**：点、线、多边形、矩形、圆，自由绘制
- 🎨 **图标库**：导入自定义图标，给点位换图标
- 👥 **多人实时协作**：5~6 人同时编辑，WebSocket 秒级同步，显示在线人数与"谁在编辑"
- 🗂️ **工程 / 图层管理**：按工程组织，分图层规划，支持新建/删除
- 🔒 **乐观锁防冲突**：多人同改不丢数据，冲突自动提示并加载最新版
- 💾 **导入 / 导出 GeoJSON**：用于备份、交付给游戏引擎、批量录入

---

## 🚀 快速开始

```bash
cd server
npm install      # 首次安装依赖
npm start        # 启动，默认端口 3001
```

浏览器打开 **http://localhost:3001/** 即可使用。

> 局域网内其他同事用你的 IP 访问同一地址（如 `http://192.168.x.x:3001/`）即可一起协作。

---

## 🧱 技术栈

- **前端**：Leaflet（CRS.Simple 像素坐标）+ leaflet-geoman（绘图）+ 原生 ES Class，**零构建**
- **后端**：Node.js + Express + WebSocket(ws)
- **存储**：better-sqlite3（单文件 SQLite，零配置）

---

## 📚 文档

| 文档 | 内容 |
|------|------|
| [`AGENTS.md`](./AGENTS.md) | AI 协作约定、架构速览、**历史踩坑教训**（开发前必读） |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | 架构详解：数据模型 / API 接口 / WebSocket 协议 / 模块职责 |
| [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) | 开发指南：启动 / 调试 / 自检清单 / Git 工作流 |

---

## 💡 使用提示

1. 先在工具条选择或新建一个**工程**，再新建**图层**，然后才能绘制。
2. 改完前端代码 **Ctrl+F5** 强刷生效。
3. 协作数据存在后端数据库；"导出 GeoJSON"用于备份或交付给游戏引擎。

---

## 📝 致谢

基础地图框架 fork 自 [interactive-game-maps/template](https://github.com/interactive-game-maps/template)，在其上扩展了后端与实时协作能力。
