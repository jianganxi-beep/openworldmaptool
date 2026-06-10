// app.js —— 游戏地图规划工具启动脚本
//
// 初始化 Leaflet 地图 (像素坐标系) + 底图 + 协作系统

// 1. 创建地图 (CRS.Simple: 适合游戏图片底图, 用像素坐标)
const map = L.map('map', {
    crs: L.CRS.Simple,
    minZoom: -2,
    maxZoom: 4,
    zoomControl: true
});

// 2. 底图管理器 (功能①: 运行时替换底图 + 持久化)
//    配置存 localStorage(planner:basemap): { url, width, height }
const BasemapManager = {
    _key: 'planner:basemap',
    _layer: null,
    _default: {
        url: 'https://picsum.photos/2048/2048?grayscale',
        width: 2048,
        height: 2048
    },
    getConfig() {
        try {
            const saved = JSON.parse(localStorage.getItem(this._key));
            if (saved && saved.url) return saved;
        } catch (e) { /* ignore */ }
        return { ...this._default };
    },
    _bounds(cfg) { return [[0, 0], [cfg.height, cfg.width]]; },
    // 应用底图: 替换图片并调整边界
    apply(cfg) {
        if (cfg) localStorage.setItem(this._key, JSON.stringify(cfg));
        const c = this.getConfig();
        const bounds = this._bounds(c);
        if (this._layer) map.removeLayer(this._layer);
        this._layer = L.imageOverlay(c.url, bounds);
        this._layer.addTo(map);
        this._layer.setZIndex(0);
        map.fitBounds(bounds);
    },
    reset() {
        localStorage.removeItem(this._key);
        this.apply();
    },
    getLayer() { return this._layer; }
};
window.BasemapManager = BasemapManager;

// 初次加载底图 (会从 localStorage 恢复上次设置)
BasemapManager.apply();
const initCfg = BasemapManager.getConfig();
const bounds = BasemapManager._bounds(initCfg);

// 可选的参考网格叠加层 (帮助对齐, 可在右上角开关)
const gridBase = L.imageOverlay(
    'data:image/svg+xml;base64,' + btoa(`
        <svg xmlns="http://www.w3.org/2000/svg" width="2048" height="2048">
            <g stroke="#2f3d4d" stroke-width="2" opacity="0.5">
                ${Array.from({ length: 17 }, (_, i) => `<line x1="${i * 128}" y1="0" x2="${i * 128}" y2="2048"/>`).join('')}
                ${Array.from({ length: 17 }, (_, i) => `<line x1="0" y1="${i * 128}" x2="2048" y2="${i * 128}"/>`).join('')}
            </g>
        </svg>
    `),
    bounds
);

// 图层控件: 网格作为可选叠加层 (底图替换由工具条"🗺️底图"入口完成)
L.control.layers(null, { '参考网格': gridBase }, { collapsed: false, position: 'topright' }).addTo(map);

map.fitBounds(bounds);

// 3. 鼠标坐标实时显示 (精确放点用)
const coordControl = L.control({ position: 'bottomleft' });
coordControl.onAdd = function () {
    this._div = L.DomUtil.create('div', 'coord-display');
    this._div.style.cssText = 'background:rgba(30,34,42,0.85);color:#9fe;padding:3px 8px;border-radius:4px;font-family:monospace;font-size:12px;';
    this._div.textContent = 'X: -, Y: -';
    return this._div;
};
coordControl.addTo(map);
map.on('mousemove', (e) => {
    coordControl._div.textContent = `X: ${Math.round(e.latlng.lng)}, Y: ${Math.round(e.latlng.lat)}`;
});

// 4. 启用 geoman opt-in 模式 (只对协作图层生效)
L.PM.setOptIn(false);

// 5. 初始化协作系统
const sync = new CollabSync(map, { apiBase: '/api' });
const ui = new CollabUI(map, sync);

window.addEventListener('load', () => {
    ui.init().catch(err => {
        console.error('协作系统初始化失败', err);
        const tip = document.createElement('div');
        tip.style.cssText = 'position:fixed;top:50px;left:50%;transform:translateX(-50%);z-index:2000;background:#8a3a3a;color:#fff;padding:10px 16px;border-radius:6px;font-family:sans-serif;';
        tip.textContent = '无法连接协作后端，请确认后端服务已在 3001 端口启动。';
        document.body.appendChild(tip);
    });
});
