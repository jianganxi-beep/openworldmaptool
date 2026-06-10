// collab_sync.js —— 多人协作同步层 (5-6 人共享同一份规划数据)
//
// 职责:
//   1. 维护当前用户名 (用于标记"谁改的", 并支持冲突提示)
//   2. 从后端拉取当前工程的所有图层并渲染到地图
//   3. 编辑(增/改/删要素)后, 防抖保存回后端 (带版本号乐观锁)
//   4. 定时轮询后端, 把别人的改动合并进来, 实现近实时协作
//
// 依赖: 全局已存在 Leaflet (L) 与 InteractiveMap 实例

// ============ 图标库 (玩法点图标) ============
// 所有图标存在 localStorage, key = planner:icons
// 结构: [{ id, name, dataUrl, size }]
// 图标随点位的 properties.iconId 关联; 为保证"别人也能看到", 点位 properties 里冗余存一份 iconUrl。
const IconLibrary = {
    _key: 'planner:icons',
    // 内置开箱即用图标 (彩色 SVG, 转 dataURL)
    _builtins: [
        { id: 'bi_boss', name: 'BOSS', size: 36, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" fill="#b71c1c" stroke="#fff" stroke-width="2"/><path d="M18 7l3 7h7l-6 5 2 8-6-4-6 4 2-8-6-5h7z" fill="#ffd54f"/></svg>` },
        { id: 'bi_chest', name: '宝箱', size: 32, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="5" y="12" width="22" height="14" rx="2" fill="#8d6e63" stroke="#fff" stroke-width="2"/><rect x="5" y="9" width="22" height="6" rx="2" fill="#a1887f" stroke="#fff" stroke-width="2"/><circle cx="16" cy="18" r="2.5" fill="#ffd54f"/></svg>` },
        { id: 'bi_portal', name: '传送点', size: 32, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="#1565c0" stroke="#fff" stroke-width="2"/><circle cx="16" cy="16" r="7" fill="none" stroke="#80d8ff" stroke-width="2"/><circle cx="16" cy="16" r="2.5" fill="#e1f5fe"/></svg>` },
        { id: 'bi_flag', name: '标记', size: 32, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="9" y="5" width="2.5" height="22" fill="#fff"/><path d="M11 6h13l-3 4 3 4H11z" fill="#43a047" stroke="#fff" stroke-width="1"/></svg>` }
    ],
    _svgToDataUrl(svg) { return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg))); },
    _ensureBuiltins() {
        if (localStorage.getItem(this._key) !== null) return; // 已初始化过
        const icons = this._builtins.map(b => ({ id: b.id, name: b.name, size: b.size, dataUrl: this._svgToDataUrl(b.svg) }));
        localStorage.setItem(this._key, JSON.stringify(icons));
    },
    list() {
        this._ensureBuiltins();
        try { return JSON.parse(localStorage.getItem(this._key) || '[]'); }
        catch { return []; }
    },
    save(icons) { localStorage.setItem(this._key, JSON.stringify(icons)); },
    add(name, dataUrl, size = 32) {
        const icons = this.list();
        const id = 'ic_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        icons.push({ id, name, dataUrl, size });
        this.save(icons);
        return id;
    },
    remove(id) { this.save(this.list().filter(i => i.id !== id)); },
    get(id) { return this.list().find(i => i.id === id); },
    // 根据点位 properties 构造 Leaflet 图标 (优先用 iconUrl 冗余字段, 保证协作可见)
    buildIcon(props = {}) {
        let url = props.iconUrl;
        let size = props.iconSize || 32;
        if (!url && props.iconId) {
            const def = this.get(props.iconId);
            if (def) { url = def.dataUrl; size = def.size; }
        }
        if (!url) return null;
        return L.icon({
            iconUrl: url,
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
            popupAnchor: [0, -size / 2]
        });
    }
};
window.IconLibrary = IconLibrary;

class CollabSync {
    #map;                 // L.Map
    #apiBase;             // 后端 API 前缀
    #projectId = 1;       // 当前工程 ID
    #username = '';       // 当前用户
    #layers = new Map();  // layerId -> { meta, group(L.FeatureGroup), version }
    #pollTimer = null;
    #saveTimers = new Map(); // layerId -> 防抖定时器
    #editingLayerId = null;  // 当前正在编辑的图层 (轮询时跳过它, 避免覆盖本地未保存内容)
    #onLayersChanged = null; // 图层列表变化回调 (用于刷新 UI)
    #clientId = null;        // WebSocket 连接 ID, 写请求带上它, 后端广播时可排除自己

    constructor(leafletMap, options = {}) {
        this.#map = leafletMap;
        this.#apiBase = options.apiBase || '/api';
        this.#username = localStorage.getItem('planner:username') || '';
    }

    // ---------- 用户 ----------
    getUsername() { return this.#username; }
    setUsername(name) {
        this.#username = (name || '').trim();
        localStorage.setItem('planner:username', this.#username);
    }

    getProjectId() { return this.#projectId; }
    setProjectId(id) { this.#projectId = id; }

    getLayers() { return this.#layers; }

    setEditingLayer(layerId) { this.#editingLayerId = layerId; }

    setClientId(id) { this.#clientId = id; }

    // 写请求统一头部 (带上自己的 WebSocket clientId, 后端广播时排除自己, 避免自我重复刷新)
    #writeHeaders() {
        const h = { 'Content-Type': 'application/json' };
        if (this.#clientId) h['X-Client-Id'] = this.#clientId;
        return h;
    }

    onLayersChanged(cb) { this.#onLayersChanged = cb; }

    // ---------- 后端交互 ----------
    async listProjects() {
        const res = await fetch(`${this.#apiBase}/projects`);
        return res.json();
    }

    async createProject(name) {
        const res = await fetch(`${this.#apiBase}/projects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        return res.json();
    }

    // 删除工程 (连带其下所有图层, 对所有协作者生效)
    async deleteProject(projectId) {
        const res = await fetch(`${this.#apiBase}/projects/${projectId}`, {
            method: 'DELETE',
            headers: this.#writeHeaders()
        });
        if (!res.ok) {
            const err = await res.json().catch(() => null);
            throw new Error((err && err.error) || `服务器返回 ${res.status}`);
        }
        return res.json().catch(() => ({ ok: true }));
    }

    async createLayer(name, color) {
        const res = await fetch(`${this.#apiBase}/projects/${this.#projectId}/layers`, {
            method: 'POST',
            headers: this.#writeHeaders(),
            body: JSON.stringify({ name, color })
        });
        const layer = await res.json().catch(() => null);
        if (!res.ok) {
            const msg = (layer && layer.error) || `服务器返回 ${res.status}`;
            throw new Error(msg);
        }
        await this.refresh();
        return layer;
    }

    async deleteLayer(layerId) {
        await fetch(`${this.#apiBase}/layers/${layerId}`, { method: 'DELETE', headers: this.#writeHeaders() });
        if (this.#layers.has(layerId)) {
            this.#map.removeLayer(this.#layers.get(layerId).group);
            this.#layers.delete(layerId);
        }
        this.#fireChanged();
    }

    // 拉取并渲染所有图层
    async refresh() {
        const res = await fetch(`${this.#apiBase}/projects/${this.#projectId}/layers`);
        const remoteLayers = await res.json();

        const remoteIds = new Set(remoteLayers.map(l => l.id));

        // 删除本地多余的图层
        for (const [id, local] of this.#layers) {
            if (!remoteIds.has(id)) {
                this.#map.removeLayer(local.group);
                this.#layers.delete(id);
            }
        }

        for (const remote of remoteLayers) {
            const local = this.#layers.get(remote.id);

            // 正在编辑的图层不要被轮询覆盖
            if (this.#editingLayerId === remote.id) continue;

            // 版本一致则跳过 (没有变化)
            if (local && local.version === remote.version) continue;

            this.#renderLayer(remote);
        }

        this.#fireChanged();
        return remoteLayers;
    }

    // 渲染/重建单个图层到地图
    #renderLayer(remote) {
        // 移除旧的
        if (this.#layers.has(remote.id)) {
            this.#map.removeLayer(this.#layers.get(remote.id).group);
        }

        const color = remote.color || '#3388ff';
        const group = L.geoJSON(remote.geojson, {
            pmIgnore: false,
            style: () => ({ color: color, fillColor: color, fillOpacity: 0.3, weight: 2 }),
            pointToLayer: (feature, latlng) => {
                const customIcon = IconLibrary.buildIcon(feature.properties || {});
                const opts = { riseOnHover: true };
                if (customIcon) opts.icon = customIcon;
                return L.marker(latlng, opts);
            },
            onEachFeature: (feature, lyr) => {
                this.#bindEditPopup(lyr, remote.id);
            }
        });

        group.addTo(this.#map);
        this.#layers.set(remote.id, { meta: remote, group, version: remote.version, color });
    }

    // 给要素绑定带"规划字段"的编辑弹窗
    #bindEditPopup(layer, layerId) {
        layer.bindPopup(() => this.#buildPopupForm(layer, layerId));
        layer.on('popupclose', () => {
            // 关闭弹窗即触发一次保存
            this.scheduleSave(layerId);
        });
    }

    // 构建自定义字段表单 (状态/优先级/负责人/备注 + 图标)
    #buildPopupForm(layer, layerId) {
        if (!layer.feature) layer.feature = { type: 'Feature' };
        if (!layer.feature.properties) layer.feature.properties = {};
        const props = layer.feature.properties;

        const wrap = document.createElement('div');
        wrap.className = 'planner-popup';

        const fields = [
            { key: 'name', label: '名称', type: 'text' },
            { key: 'status', label: '状态', type: 'select', options: ['待规划', '进行中', '已完成', '已废弃'] },
            { key: 'priority', label: '优先级', type: 'select', options: ['高', '中', '低'] },
            { key: 'owner', label: '负责人', type: 'text' },
            { key: 'note', label: '备注', type: 'textarea' }
        ];

        fields.forEach(f => {
            const p = document.createElement('p');
            const label = document.createElement('label');
            label.innerHTML = f.label + '：';
            label.style.display = 'block';
            label.style.fontWeight = 'bold';

            let input;
            if (f.type === 'select') {
                input = document.createElement('select');
                f.options.forEach(opt => {
                    const o = document.createElement('option');
                    o.value = opt; o.textContent = opt;
                    input.appendChild(o);
                });
            } else if (f.type === 'textarea') {
                input = document.createElement('textarea');
                input.rows = 2;
            } else {
                input = document.createElement('input');
                input.type = 'text';
            }
            input.style.width = '180px';
            if (props[f.key] != null) input.value = props[f.key];
            input.addEventListener('change', e => {
                props[f.key] = e.target.value;
                this.scheduleSave(layerId);
            });

            p.appendChild(label);
            p.appendChild(input);
            wrap.appendChild(p);
        });

        // 仅点位(Marker)显示"图标"选择
        if (layer instanceof L.Marker) {
            wrap.appendChild(this.buildIconSelector(layer, props, layerId));
        }

        return wrap;
    }

    // 构建图标选择器 (供弹窗复用)
    buildIconSelector(layer, props, layerId) {
        const p = document.createElement('p');
        const label = document.createElement('label');
        label.textContent = '图标：';
        label.style.display = 'block';
        label.style.fontWeight = 'bold';
        const sel = document.createElement('select');
        sel.style.width = '180px';

        const def = document.createElement('option');
        def.value = ''; def.textContent = '默认水滴';
        sel.appendChild(def);

        IconLibrary.list().forEach(ic => {
            const o = document.createElement('option');
            o.value = ic.id; o.textContent = ic.name;
            sel.appendChild(o);
        });
        if (props.iconId) sel.value = props.iconId;

        sel.addEventListener('change', e => {
            const iconId = e.target.value;
            if (iconId) {
                const icDef = IconLibrary.get(iconId);
                props.iconId = iconId;
                props.iconUrl = icDef ? icDef.dataUrl : undefined; // 冗余存, 协作可见
                props.iconSize = icDef ? icDef.size : 32;
                const newIcon = IconLibrary.buildIcon(props);
                if (newIcon && layer.setIcon) layer.setIcon(newIcon);
            } else {
                delete props.iconId;
                delete props.iconUrl;
                delete props.iconSize;
                if (layer.setIcon) layer.setIcon(new L.Icon.Default());
            }
            this.scheduleSave(layerId);
        });

        p.appendChild(label);
        p.appendChild(sel);
        return p;
    }

    // 防抖保存 (1.2 秒内多次改动只提交一次)
    scheduleSave(layerId) {
        if (this.#saveTimers.has(layerId)) {
            clearTimeout(this.#saveTimers.get(layerId));
        }
        this.#saveTimers.set(layerId, setTimeout(() => this.saveLayer(layerId), 1200));
    }

    // 立即保存某图层到后端
    async saveLayer(layerId) {
        const local = this.#layers.get(layerId);
        if (!local) return;

        const geojson = local.group.toGeoJSON();
        const body = {
            geojson,
            version: local.version,
            updated_by: this.#username,
            name: local.meta.name,
            color: local.color
        };

        const res = await fetch(`${this.#apiBase}/layers/${layerId}`, {
            method: 'PUT',
            headers: this.#writeHeaders(),
            body: JSON.stringify(body)
        });

        if (res.status === 409) {
            // 冲突: 别人先改了。提示并用服务器版本覆盖本地
            const conflict = await res.json();
            alert(`⚠️ 图层「${local.meta.name}」已被「${conflict.server_layer.updated_by || '他人'}」修改，\n你的本次改动未保存，已自动加载最新版本。`);
            this.#renderLayer(conflict.server_layer);
            this.#fireChanged();
            return;
        }

        const updated = await res.json();
        local.version = updated.version;
        local.meta = updated;
    }

    // 把当前正在编辑的 geoman 图层关联到指定后端图层
    bindEditingGroup(layerId) {
        const local = this.#layers.get(layerId);
        return local ? local.group : null;
    }

    // 启动轮询 (默认每 5 秒同步一次)
    startPolling(intervalMs = 5000) {
        this.stopPolling();
        this.#pollTimer = setInterval(() => {
            this.refresh().catch(err => console.warn('轮询同步失败', err));
        }, intervalMs);
    }

    stopPolling() {
        if (this.#pollTimer) clearInterval(this.#pollTimer);
        this.#pollTimer = null;
    }

    #fireChanged() {
        if (typeof this.#onLayersChanged === 'function') {
            this.#onLayersChanged(Array.from(this.#layers.values()).map(l => l.meta));
        }
    }
}
