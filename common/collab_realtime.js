// collab_realtime.js —— 多人协作实时层 (WebSocket)
//
// 职责:
//   1. 与后端 /ws 建立 WebSocket 长连接, 断线自动重连
//   2. 上报自己的身份 (昵称 + 当前工程) 和"正在编辑哪个图层"
//   3. 接收在线成员列表 (presence) -> 回调给 UI 显示
//   4. 接收图层变更事件 (layers_changed) -> 触发即时拉取, 实现秒级同步 (替代 5 秒轮询)
//   5. 心跳保活
//
// 设计为"增强"而非"替换": 即使 WebSocket 连不上, 原有的 5 秒轮询兜底仍然工作。

class CollabRealtime {
    #ws = null;
    #url = '';
    #clientId = null;        // 后端分配的连接 ID (用于写请求时排除自己)
    #username = '';
    #projectId = null;
    #editingLayerId = null;

    #connected = false;
    #reconnectTimer = null;
    #pingTimer = null;
    #reconnectDelay = 1000;  // 退避重连, 最大 15 秒

    // 回调
    #onPresence = null;      // (members[]) => void
    #onLayersChanged = null; // ({projectId, action, layerId}) => void
    #onStatus = null;        // (connected:boolean) => void
    #onProjectDeleted = null;// ({projectId}) => void

    constructor(options = {}) {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        this.#url = options.url || `${proto}://${location.host}/ws`;
    }

    // ---------- 对外配置 ----------
    onPresence(cb) { this.#onPresence = cb; }
    onLayersChanged(cb) { this.#onLayersChanged = cb; }
    onStatus(cb) { this.#onStatus = cb; }
    onProjectDeleted(cb) { this.#onProjectDeleted = cb; }

    getClientId() { return this.#clientId; }
    isConnected() { return this.#connected; }

    // ---------- 连接 ----------
    connect(username, projectId) {
        this.#username = username || '';
        this.#projectId = projectId != null ? Number(projectId) : null;
        this.#open();
    }

    #open() {
        try {
            this.#ws = new WebSocket(this.#url);
        } catch (e) {
            this.#scheduleReconnect();
            return;
        }

        this.#ws.onopen = () => {
            this.#connected = true;
            this.#reconnectDelay = 1000;
            this.#sendHello();
            this.#startPing();
            if (this.#onStatus) this.#onStatus(true);
        };

        this.#ws.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            this.#handle(msg);
        };

        this.#ws.onclose = () => {
            this.#connected = false;
            this.#stopPing();
            if (this.#onStatus) this.#onStatus(false);
            this.#scheduleReconnect();
        };

        this.#ws.onerror = () => {
            // 错误后会触发 onclose, 由 onclose 统一处理重连
            try { this.#ws.close(); } catch {}
        };
    }

    #handle(msg) {
        switch (msg.type) {
            case 'welcome':
                this.#clientId = msg.clientId;
                break;
            case 'presence':
                if (this.#onPresence) this.#onPresence(msg.members || []);
                break;
            case 'layers_changed':
                if (this.#onLayersChanged) this.#onLayersChanged(msg);
                break;
            case 'project_deleted':
                if (this.#onProjectDeleted) this.#onProjectDeleted(msg);
                break;
            case 'pong':
                break;
        }
    }

    // ---------- 上报 ----------
    #sendHello() {
        this.#send({ type: 'hello', username: this.#username, projectId: this.#projectId });
        // 重连后恢复编辑状态
        if (this.#editingLayerId != null) {
            this.#send({ type: 'editing', projectId: this.#projectId, layerId: this.#editingLayerId });
        }
    }

    setUsername(name) {
        this.#username = name || '';
        this.#sendHello();
    }

    setProject(projectId) {
        this.#projectId = projectId != null ? Number(projectId) : null;
        this.#editingLayerId = null;
        this.#sendHello();
    }

    // 声明正在编辑的图层 (null = 停止编辑); 让队友看到"编辑中"
    setEditing(layerId) {
        this.#editingLayerId = layerId != null ? Number(layerId) : null;
        this.#send({ type: 'editing', projectId: this.#projectId, layerId: this.#editingLayerId });
    }

    #send(obj) {
        if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
            this.#ws.send(JSON.stringify(obj));
        }
    }

    // ---------- 心跳 & 重连 ----------
    #startPing() {
        this.#stopPing();
        this.#pingTimer = setInterval(() => this.#send({ type: 'ping' }), 25000);
    }
    #stopPing() {
        if (this.#pingTimer) clearInterval(this.#pingTimer);
        this.#pingTimer = null;
    }

    #scheduleReconnect() {
        if (this.#reconnectTimer) return;
        this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = null;
            this.#reconnectDelay = Math.min(this.#reconnectDelay * 1.6, 15000);
            this.#open();
        }, this.#reconnectDelay);
    }
}

window.CollabRealtime = CollabRealtime;
