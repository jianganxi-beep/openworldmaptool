// Game Map Planner - 协作后端服务
// 技术栈: Express + better-sqlite3 (单文件 SQLite, 零配置, 适合 5-6 人小团队)
//
// 数据模型:
//   projects (规划工程)  1 --- N  layers (图层, 每个图层存一份 GeoJSON)
//   每个图层带 version 版本号, 用于乐观锁, 防止多人并发覆盖
//
// 启动: npm install && npm start  (默认端口 3001)

import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import http from 'http';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3001;
const DB_PATH = join(__dirname, 'planner.db');

// ---------- 数据库初始化 ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS layers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL,
    name        TEXT NOT NULL,
    color       TEXT DEFAULT '#3388ff',
    geojson     TEXT NOT NULL DEFAULT '{"type":"FeatureCollection","features":[]}',
    version     INTEGER NOT NULL DEFAULT 1,
    updated_by  TEXT DEFAULT '',
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 图层历史快照: 每次保存前把"旧版本"存一份, 用于操作历史查看与撤销/回滚
CREATE TABLE IF NOT EXISTS layer_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    layer_id    INTEGER NOT NULL,
    version     INTEGER NOT NULL,
    geojson     TEXT NOT NULL,
    name        TEXT,
    color       TEXT,
    updated_by  TEXT DEFAULT '',
    saved_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (layer_id) REFERENCES layers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_history_layer ON layer_history(layer_id);
`);

// 每个图层最多保留的历史快照数 (超出则清理最旧的, 防止数据库膨胀)
const MAX_HISTORY_PER_LAYER = 30;

// 若没有任何工程, 自动建立一个默认工程, 方便开箱即用
const projectCount = db.prepare('SELECT COUNT(*) AS c FROM projects').get().c;
if (projectCount === 0) {
    db.prepare('INSERT INTO projects (name) VALUES (?)').run('默认规划工程');
}

// ---------- Express 应用 ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 把前端静态资源也一并托管 (前端在上级目录)
const FRONTEND_DIR = join(__dirname, '..');
app.use(express.static(FRONTEND_DIR, {
    etag: false,
    lastModified: false,
    cacheControl: false,
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
}));

// ===== 工程相关 =====

// 列出所有工程
app.get('/api/projects', (req, res) => {
    const rows = db.prepare('SELECT * FROM projects ORDER BY id').all();
    res.json(rows);
});

// 新建工程
app.post('/api/projects', (req, res) => {
    const name = (req.body.name || '未命名工程').trim();
    const info = db.prepare('INSERT INTO projects (name) VALUES (?)').run(name);
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(row);
});

// 删除工程 (连带图层)
app.delete('/api/projects/:id', (req, res) => {
    const pid = Number(req.params.id);
    db.prepare('DELETE FROM layers WHERE project_id = ?').run(pid);
    db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
    // 实时通知该工程的在线协作者: 工程已被删除, 需刷新工程列表并切走
    if (global.__notifyProjectDeleted) {
        global.__notifyProjectDeleted(pid, req.get('X-Client-Id'));
    }
    res.json({ ok: true });
});

// ===== 图层相关 =====

// 拉取某工程下所有图层 (含 GeoJSON 与版本号) —— 前端轮询用此接口实现近实时同步
app.get('/api/projects/:id/layers', (req, res) => {
    const rows = db.prepare('SELECT * FROM layers WHERE project_id = ? ORDER BY id').all(req.params.id);
    const layers = rows.map(r => ({
        id: r.id,
        project_id: r.project_id,
        name: r.name,
        color: r.color,
        version: r.version,
        updated_by: r.updated_by,
        updated_at: r.updated_at,
        geojson: JSON.parse(r.geojson)
    }));
    res.json(layers);
});

// 新建图层
app.post('/api/projects/:id/layers', (req, res) => {
    const { name, color } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ error: '图层名称不能为空' });
    }
    const info = db.prepare(
        'INSERT INTO layers (project_id, name, color) VALUES (?, ?, ?)'
    ).run(req.params.id, name.trim(), color || '#3388ff');
    const row = db.prepare('SELECT * FROM layers WHERE id = ?').get(info.lastInsertRowid);
    if (global.__notifyLayersChanged) {
        global.__notifyLayersChanged(req.params.id, 'create', row.id, req.get('X-Client-Id'));
    }
    res.status(201).json({ ...row, geojson: JSON.parse(row.geojson) });
});

// 保存图层 GeoJSON (乐观锁: 客户端需带上自己持有的 version)
app.put('/api/layers/:id', (req, res) => {
    const { geojson, version, updated_by, name, color } = req.body;
    const current = db.prepare('SELECT * FROM layers WHERE id = ?').get(req.params.id);

    if (!current) {
        return res.status(404).json({ error: '图层不存在' });
    }

    // 乐观锁冲突检测: 别人已经改过且版本更高
    if (typeof version === 'number' && version < current.version) {
        return res.status(409).json({
            error: 'conflict',
            message: '该图层已被他人更新, 请先拉取最新版本',
            server_version: current.version,
            server_layer: { ...current, geojson: JSON.parse(current.geojson) }
        });
    }

    const newVersion = current.version + 1;
    db.prepare(`
        UPDATE layers
        SET geojson = ?, version = ?, updated_by = ?, name = ?, color = ?, updated_at = datetime('now')
        WHERE id = ?
    `).run(
        JSON.stringify(geojson ?? JSON.parse(current.geojson)),
        newVersion,
        updated_by || '',
        name ?? current.name,
        color ?? current.color,
        req.params.id
    );

    // 保存成功后, 把"刚刚被覆盖的旧版本"存入历史快照, 供撤销/回滚
    saveHistorySnapshot(current);

    const row = db.prepare('SELECT * FROM layers WHERE id = ?').get(req.params.id);
    if (global.__notifyLayersChanged) {
        global.__notifyLayersChanged(current.project_id, 'update', row.id, req.get('X-Client-Id'));
    }
    res.json({ ...row, geojson: JSON.parse(row.geojson) });
});

// 删除图层
app.delete('/api/layers/:id', (req, res) => {
    const current = db.prepare('SELECT * FROM layers WHERE id = ?').get(req.params.id);
    db.prepare('DELETE FROM layers WHERE id = ?').run(req.params.id);
    if (current && global.__notifyLayersChanged) {
        global.__notifyLayersChanged(current.project_id, 'delete', current.id, req.get('X-Client-Id'));
    }
    res.json({ ok: true });
});

// ===== 图层历史 / 撤销回滚 =====

// 把某图层的某个版本存入历史快照, 并清理超量的旧记录
function saveHistorySnapshot(layerRow) {
    db.prepare(`
        INSERT INTO layer_history (layer_id, version, geojson, name, color, updated_by)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(layerRow.id, layerRow.version, layerRow.geojson, layerRow.name, layerRow.color, layerRow.updated_by || '');

    // 仅保留最近 MAX_HISTORY_PER_LAYER 条
    const ids = db.prepare(
        'SELECT id FROM layer_history WHERE layer_id = ? ORDER BY id DESC LIMIT ? OFFSET ?'
    ).all(layerRow.id, 1000, MAX_HISTORY_PER_LAYER);
    if (ids.length) {
        const delStmt = db.prepare('DELETE FROM layer_history WHERE id = ?');
        for (const r of ids) delStmt.run(r.id);
    }
}

// 查看某图层的历史快照列表 (按时间倒序, 含要素数量统计, 不返回完整 geojson 以减小体积)
app.get('/api/layers/:id/history', (req, res) => {
    const rows = db.prepare(
        'SELECT id, version, name, color, updated_by, saved_at, geojson FROM layer_history WHERE layer_id = ? ORDER BY id DESC'
    ).all(req.params.id);
    const list = rows.map(r => {
        let featureCount = 0;
        try { featureCount = (JSON.parse(r.geojson).features || []).length; } catch { /* ignore */ }
        return {
            id: r.id,
            version: r.version,
            name: r.name,
            color: r.color,
            updated_by: r.updated_by,
            saved_at: r.saved_at,
            feature_count: featureCount
        };
    });
    res.json(list);
});

// 回滚: 把图层恢复到某个历史快照的内容 (作为一次新的保存, 因此回滚本身也可被再次撤销)
app.post('/api/layers/:id/revert', (req, res) => {
    const layerId = Number(req.params.id);
    const { history_id, updated_by } = req.body;
    const snapshot = db.prepare('SELECT * FROM layer_history WHERE id = ? AND layer_id = ?').get(history_id, layerId);
    if (!snapshot) {
        return res.status(404).json({ error: '历史快照不存在' });
    }
    const current = db.prepare('SELECT * FROM layers WHERE id = ?').get(layerId);
    if (!current) {
        return res.status(404).json({ error: '图层不存在' });
    }

    // 先把"当前版本"也存进历史 (这样回滚后还能再撤销回来)
    saveHistorySnapshot(current);

    const newVersion = current.version + 1;
    db.prepare(`
        UPDATE layers
        SET geojson = ?, version = ?, updated_by = ?, updated_at = datetime('now')
        WHERE id = ?
    `).run(snapshot.geojson, newVersion, updated_by || '', layerId);

    const row = db.prepare('SELECT * FROM layers WHERE id = ?').get(layerId);
    if (global.__notifyLayersChanged) {
        global.__notifyLayersChanged(current.project_id, 'update', layerId, req.get('X-Client-Id'));
    }
    res.json({ ...row, geojson: JSON.parse(row.geojson), reverted_to_version: snapshot.version });
});

// 健康检查
app.get('/api/health', (req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
});

// ==================== WebSocket 实时协作层 ====================
//
// 职责:
//   1. presence: 维护在线成员列表 (谁在线 / 昵称 / 当前所在工程 / 正在编辑哪个图层)
//   2. 实时广播图层变更 (create / update / delete), 替代前端 5 秒轮询
//   3. 软编辑锁: 广播"某人开始/停止编辑某图层", 让队友看到"编辑中"提示, 避免撞车
//
// 协议 (JSON 文本帧):
//   客户端 -> 服务端:
//     { type:'hello',   username, projectId }      建立身份
//     { type:'editing', projectId, layerId|null }  声明正在编辑的图层 (null=停止编辑)
//     { type:'ping' }                              心跳
//   服务端 -> 客户端:
//     { type:'welcome', clientId }
//     { type:'presence', members:[{clientId,username,projectId,editingLayerId}] }
//     { type:'layers_changed', projectId, action, layerId }   图层有变更, 让该工程的客户端拉取
//     { type:'pong' }

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// clientId -> { ws, username, projectId, editingLayerId, alive }
const clients = new Map();
let clientSeq = 0;

function presenceList(projectId) {
    const list = [];
    for (const [id, c] of clients) {
        if (projectId != null && c.projectId !== projectId) continue;
        list.push({
            clientId: id,
            username: c.username || '匿名',
            projectId: c.projectId,
            editingLayerId: c.editingLayerId ?? null
        });
    }
    return list;
}

// 向同一工程下的所有客户端广播 (可选排除某个 client)
function broadcastToProject(projectId, payload, exceptId = null) {
    const msg = JSON.stringify(payload);
    for (const [id, c] of clients) {
        if (id === exceptId) continue;
        if (projectId != null && c.projectId !== projectId) continue;
        if (c.ws.readyState === c.ws.OPEN) c.ws.send(msg);
    }
}

// 广播某工程的在线成员变化
function broadcastPresence(projectId) {
    broadcastToProject(projectId, { type: 'presence', members: presenceList(projectId) });
}

// 暴露给 REST API: 图层发生变更时通知该工程所有人实时刷新
function notifyLayersChanged(projectId, action, layerId, exceptId = null) {
    broadcastToProject(Number(projectId), { type: 'layers_changed', projectId: Number(projectId), action, layerId }, exceptId);
}
// 让上面的 REST 路由能调用 (它们定义在前面, 通过全局引用)
global.__notifyLayersChanged = notifyLayersChanged;

// 通知某工程已被删除: 让该工程的在线成员刷新工程列表并切走
function notifyProjectDeleted(projectId, exceptId = null) {
    broadcastToProject(Number(projectId), { type: 'project_deleted', projectId: Number(projectId) }, exceptId);
}
global.__notifyProjectDeleted = notifyProjectDeleted;

wss.on('connection', (ws) => {
    const clientId = 'c' + (++clientSeq) + '_' + Date.now().toString(36);
    clients.set(clientId, { ws, username: '', projectId: null, editingLayerId: null, alive: true });
    ws.send(JSON.stringify({ type: 'welcome', clientId }));

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        const c = clients.get(clientId);
        if (!c) return;

        switch (msg.type) {
            case 'hello': {
                const oldProject = c.projectId;
                c.username = (msg.username || '').toString().slice(0, 40);
                c.projectId = msg.projectId != null ? Number(msg.projectId) : null;
                c.editingLayerId = null;
                if (oldProject != null && oldProject !== c.projectId) broadcastPresence(oldProject);
                broadcastPresence(c.projectId);
                break;
            }
            case 'editing': {
                c.projectId = msg.projectId != null ? Number(msg.projectId) : c.projectId;
                c.editingLayerId = msg.layerId != null ? Number(msg.layerId) : null;
                broadcastPresence(c.projectId);
                break;
            }
            case 'ping':
                c.alive = true;
                ws.send(JSON.stringify({ type: 'pong' }));
                break;
        }
    });

    ws.on('pong', () => { const c = clients.get(clientId); if (c) c.alive = true; });

    ws.on('close', () => {
        const c = clients.get(clientId);
        const pid = c ? c.projectId : null;
        clients.delete(clientId);
        if (pid != null) broadcastPresence(pid);
    });
});

// 心跳检测: 每 30 秒清理掉断线僵尸连接
const heartbeat = setInterval(() => {
    for (const [id, c] of clients) {
        if (c.alive === false) {
            try { c.ws.terminate(); } catch {}
            const pid = c.projectId;
            clients.delete(id);
            if (pid != null) broadcastPresence(pid);
            continue;
        }
        c.alive = false;
        try { c.ws.ping(); } catch {}
    }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
    console.log(`\n✅ Game Map Planner 协作后端已启动`);
    console.log(`   本地访问:  http://localhost:${PORT}/`);
    console.log(`   API 健康检查: http://localhost:${PORT}/api/health`);
    console.log(`   WebSocket:   ws://localhost:${PORT}/ws`);
    console.log(`   数据库文件: ${DB_PATH}\n`);
});
