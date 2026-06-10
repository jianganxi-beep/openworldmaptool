# 架构详解 (ARCHITECTURE)

本文档详细描述系统架构、数据模型、API 接口与协作同步机制。

---

## 1. 总体架构

```
┌─────────────────────────── 浏览器 (多个客户端) ───────────────────────────┐
│                                                                          │
│  index.html → app.js                                                     │
│      ├─ Leaflet 地图 (CRS.Simple 像素坐标)                                │
│      ├─ BasemapManager   底图管理 (localStorage)                          │
│      ├─ CollabSync        数据层: REST + 轮询 + 乐观锁 + IconLibrary       │
│      ├─ CollabUI          UI 层: 工具条 / 面板 / geoman 绘图              │
│      └─ CollabRealtime    实时层: WebSocket 客户端                         │
│                                                                          │
└──────────────┬───────────────────────────────────┬──────────────────────┘
               │ REST (/api/*)                       │ WebSocket (/ws)
               ▼                                     ▼
┌──────────────────────────── server/server.js (Node) ─────────────────────┐
│  Express                                  WebSocketServer (ws)            │
│   ├─ /api/projects  CRUD                   ├─ presence (在线成员)          │
│   ├─ /api/.../layers CRUD (乐观锁)          ├─ layers_changed 广播          │
│   ├─ /api/health                           ├─ project_deleted 广播         │
│   └─ express.static (托管前端)              └─ 软编辑锁 (editing)            │
│                          │                                                │
│                          ▼                                                │
│                  better-sqlite3 (planner.db, WAL 模式)                    │
│                     projects 1 ── N layers                                │
└───────────────────────────────────────────────────────────────────────────┘
```

前后端**同源**：后端用 `express.static` 把上级目录的前端一起托管，统一从 `http://localhost:3001/` 访问。

---

## 2. 数据模型 (SQLite)

### projects（规划工程）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增 |
| name | TEXT | 工程名 |
| created_at / updated_at | TEXT | 时间戳 |

### layers（图层）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增 |
| project_id | INTEGER FK | 所属工程，`ON DELETE CASCADE` |
| name | TEXT | 图层名 |
| color | TEXT | 颜色，默认 `#3388ff` |
| geojson | TEXT | 一份完整 FeatureCollection（该图层所有点位/区域） |
| **version** | INTEGER | **乐观锁版本号**，每次保存 +1 |
| updated_by | TEXT | 最后修改人昵称 |
| updated_at | TEXT | 时间戳 |

> 设计要点：**一个图层 = 一份 GeoJSON**。点位、区域、路线都作为 Feature 存在所属图层的 geojson 字段里。

---

## 3. REST API 接口表

| 方法 | 路径 | 作用 | 备注 |
|------|------|------|------|
| GET | `/api/projects` | 列出所有工程 | |
| POST | `/api/projects` | 新建工程 | body: `{name}` |
| DELETE | `/api/projects/:id` | 删除工程（连带图层） | 广播 `project_deleted` |
| GET | `/api/projects/:id/layers` | 拉取工程下所有图层（含 geojson+version） | 前端轮询兜底用 |
| POST | `/api/projects/:id/layers` | 新建图层 | body: `{name,color}`，广播 |
| PUT | `/api/layers/:id` | 保存图层 GeoJSON | **乐观锁**，body 带 `version`；冲突返回 409 |
| DELETE | `/api/layers/:id` | 删除图层 | 广播 |
| GET | `/api/health` | 健康检查 | |

所有写请求可带头 `X-Client-Id`，用于广播时排除发起者自己（避免自我重复刷新）。

### 乐观锁冲突 (409) 处理
- 客户端保存时带上自己持有的 `version`。
- 若 `version < 服务端当前 version` → 返回 `409`，附带 `server_version` 和 `server_layer`（最新数据）。
- 前端 `saveLayer` 收到 409 后：提示用户被他人覆盖，并自动加载最新版本。

---

## 4. WebSocket 协议 (/ws)

| 方向 | 消息 | 说明 |
|------|------|------|
| C→S | `{type:'hello', username, projectId}` | 建立身份 |
| C→S | `{type:'editing', projectId, layerId\|null}` | 声明正在编辑（软锁） |
| C→S | `{type:'ping'}` | 心跳 |
| S→C | `{type:'welcome', clientId}` | 分配客户端 ID |
| S→C | `{type:'presence', members:[...]}` | 在线成员列表（含谁在编辑哪层） |
| S→C | `{type:'layers_changed', projectId, action, layerId}` | 图层有变更，提示拉取 |
| S→C | `{type:'project_deleted', projectId}` | 工程被删，提示切走 |
| S→C | `{type:'pong'}` | 心跳响应 |

- **presence**：维护在线成员（昵称 / 所在工程 / 正在编辑的图层）。
- **软编辑锁**：广播"某人在编辑某图层"，队友看到"✎xxx 编辑中"提示，避免撞车（非强制锁）。
- **心跳**：服务端每 30s ping 一次，清理僵尸连接。
- **兜底**：WebSocket 断线时，前端降级为 15s 轮询。

---

## 5. 前端模块职责

### app.js（启动器）
建地图 → `BasemapManager.apply()` 加载底图 → 实例化 `CollabSync` + `CollabUI` → `ui.init()`。
含 `BasemapManager`（底图运行时替换 + localStorage 持久化）与参考网格叠加层。

### common/collab_sync.js — `CollabSync`（数据层）
- REST 封装：`listProjects / createProject / deleteProject / createLayer / deleteLayer / refresh / saveLayer`。
- 轮询：`startPolling / stopPolling`，与 WebSocket 互为补充。
- 乐观锁保存：`scheduleSave`（防抖）→ `saveLayer`（带 version，处理 409）。
- `IconLibrary`：自定义点位图标库（localStorage），`buildIcon` 生成 Leaflet icon。
- 要素弹窗：点位属性编辑、图标选择器。

### common/collab_ui.js — `CollabUI`（UI 层，最大文件）
- 顶部工具条：昵称、工程选择/新建/删除、图层选择/新建、绘图工具、底图入口、图标入口、导入/导出、在线人数。
- 各种浮动面板：统一用 `#makePanel(title)` 创建、`#removePanel()` 关闭（**非阻塞**，替代原生对话框）。
- geoman 绘图接入：把绘制的图形写入当前选中图层。

### common/collab_realtime.js — `CollabRealtime`（实时层）
- WebSocket 客户端：连接、断线重连、心跳、`onPresence / onLayersChanged / onProjectDeleted / onStatus` 回调。

---

## 6. 关键数据流示例

**用户 A 在「BOSS 点位」图层加一个点：**
1. A 在地图上用 geoman 画点 → `CollabUI` 把 Feature 加入该图层的 Leaflet group。
2. `CollabSync.scheduleSave(layerId)` 防抖后 `PUT /api/layers/:id`（带 version、updated_by）。
3. 后端写库、version+1，调用 `notifyLayersChanged` 通过 WS 向同工程其他人广播 `layers_changed`。
4. 用户 B 的 `CollabRealtime` 收到事件 → `CollabSync.refresh()` 拉取最新 → 地图更新。
5. （WS 不可用时）B 的 15s 轮询也会拉到最新，作为兜底。
