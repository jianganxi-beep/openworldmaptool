// collab_ui.js —— 协作工具条 UI 与绘图编辑接入
//
// 提供顶部工具条:
//   - 用户名设置 (谁在协作)
//   - 工程选择 / 新建
//   - 图层列表 (新建/选中编辑/删除/显隐/改色)
//   - 绘图工具 (点 / 线 / 多边形 / 矩形 / 圆) -> 画到当前选中图层
//   - 导入 GeoJSON 到当前图层
//
// 依赖: 全局 L (Leaflet + geoman), CollabSync 实例

class CollabUI {
    #map;
    #sync;
    #activeLayerId = null;
    #toolbar;
    #realtime = null;     // WebSocket 实时层
    #members = [];        // 当前在线成员

    constructor(leafletMap, sync) {
        this.#map = leafletMap;
        this.#sync = sync;
        this.#buildToolbar();
        this.#setupDrawHandlers();

        this.#sync.onLayersChanged(() => this.#renderLayerList());
    }

    async init() {
        // 首次给一个默认昵称 (不阻塞), 用户可点击工具条上的昵称随时修改
        if (!this.#sync.getUsername()) {
            this.#sync.setUsername('队员' + Math.floor(Math.random() * 1000));
        }
        document.getElementById('collab-user').textContent = '👤 ' + this.#sync.getUsername();

        await this.#loadProjects();
        await this.#sync.refresh();

        // ===== 启动 WebSocket 实时协作 =====
        this.#initRealtime();

        // 轮询降级为兜底 (WebSocket 断线时仍能同步), 间隔拉长到 15 秒
        this.#sync.startPolling(15000);
    }

    // 初始化实时层: 在线成员 + 秒级变更推送 + 编辑锁
    #initRealtime() {
        if (typeof window.CollabRealtime !== 'function') {
            console.warn('CollabRealtime 未加载, 仅使用轮询同步');
            return;
        }
        const rt = new window.CollabRealtime();
        this.#realtime = rt;

        // 在线成员变化 -> 更新工具条显示
        rt.onPresence((members) => {
            this.#members = members || [];
            this.#renderOnline();
            this.#renderLayerList(); // 刷新图层下拉里的"编辑中"标记
        });

        // 收到图层变更事件 -> 立即拉取 (秒级同步)
        rt.onLayersChanged((evt) => {
            // 别人改了当前工程的图层, 立即刷新
            if (Number(evt.projectId) === Number(this.#sync.getProjectId())) {
                this.#sync.refresh().catch(err => console.warn('实时刷新失败', err));
            }
        });

        // 别人删除了某个工程 -> 若正是我当前所在工程, 自动切走并提示
        rt.onProjectDeleted(async (evt) => {
            const deletedId = Number(evt.projectId);
            try {
                const projects = await this.#sync.listProjects();
                if (Number(this.#sync.getProjectId()) === deletedId) {
                    // 我正在看的工程被删了 -> 清空并切到剩余第一个
                    this.#sync.getLayers().forEach(l => this.#map.removeLayer(l.group));
                    this.#sync.getLayers().clear();
                    this.#activeLayerId = null;
                    const next = projects[0];
                    if (next) {
                        this.#sync.setProjectId(next.id);
                        await this.#loadProjects();
                        document.getElementById('collab-project').value = next.id;
                        await this.#sync.refresh();
                        this.#refreshLayerSelect();
                        rt.setProject(next.id);
                        this.#setStatus(`当前工程已被协作者删除，已切换到「${next.name}」`);
                    } else {
                        this.#setStatus('当前工程已被协作者删除');
                    }
                } else {
                    // 不是我所在工程, 只需刷新工程下拉
                    await this.#loadProjects();
                    document.getElementById('collab-project').value = this.#sync.getProjectId();
                }
            } catch (err) {
                console.warn('处理工程删除事件失败', err);
            }
        });

        // 连接状态 -> 把后端分配的 clientId 注入 sync (写请求带上, 避免自我重复刷新)
        rt.onStatus((connected) => {
            if (connected) this.#sync.setClientId(rt.getClientId());
            this.#renderOnline();
        });

        rt.connect(this.#sync.getUsername(), this.#sync.getProjectId());
        // 连接建立稍后再注入一次 clientId (welcome 到达后)
        setTimeout(() => this.#sync.setClientId(rt.getClientId()), 800);
    }

    // 渲染在线成员
    #renderOnline() {
        const el = document.getElementById('collab-online');
        if (!el) return;
        if (!this.#realtime || !this.#realtime.isConnected()) {
            el.textContent = '⚪ 离线';
            el.title = 'WebSocket 未连接, 当前用轮询同步';
            el.classList.add('ct-online-off');
            return;
        }
        el.classList.remove('ct-online-off');
        const names = this.#members.map(m => {
            const editing = m.editingLayerId != null ? '✎' : '';
            return editing + (m.username || '匿名');
        });
        el.textContent = `🟢 ${this.#members.length}人在线`;
        el.title = '在线成员：\n' + (names.join('\n') || '（仅你自己）');
    }

    // ---------- 工具条 DOM ----------
    #buildToolbar() {
        const bar = document.createElement('div');
        bar.id = 'collab-toolbar';
        bar.innerHTML = `
            <div class="ct-row">
                <span id="collab-user" class="ct-user" title="点击修改昵称">👤 未登录</span>
                <span id="collab-online" class="ct-online" title="在线成员">🟢 …</span>
                <select id="collab-project" class="ct-select" title="选择规划工程"></select>
                <button id="collab-new-project" class="ct-btn">＋工程</button>
                <button id="collab-del-project" class="ct-btn ct-danger" title="删除当前工程（连带其下所有图层）">🗑工程</button>
                <span class="ct-divider"></span>
                <button id="collab-new-layer" class="ct-btn">＋图层</button>
                <select id="collab-layer-select" class="ct-select" title="当前编辑图层"></select>
                <input type="color" id="collab-layer-color" class="ct-color" title="图层颜色" value="#3388ff">
                <button id="collab-del-layer" class="ct-btn ct-danger">删除图层</button>
                <span class="ct-divider"></span>
                <button class="ct-btn ct-draw" data-draw="Marker">📍点</button>
                <button class="ct-btn ct-draw" data-draw="Line">／线</button>
                <button class="ct-btn ct-draw" data-draw="Polygon">▱区域</button>
                <button class="ct-btn ct-draw" data-draw="Rectangle">▭矩形</button>
                <button class="ct-btn ct-draw" data-draw="Circle">◯圆</button>
                <button id="collab-edit-mode" class="ct-btn">✎编辑</button>
                <button id="collab-drag-mode" class="ct-btn">✋拖动</button>
                <button id="collab-remove-mode" class="ct-btn ct-danger">✕删要素</button>
                <span class="ct-divider"></span>
                <button id="collab-basemap" class="ct-btn" title="替换/管理底图">🗺️底图</button>
                <button id="collab-icons" class="ct-btn" title="导入/管理玩法点图标">🎨图标</button>
                <span class="ct-divider"></span>
                <button id="collab-import" class="ct-btn">⬆导入</button>
                <button id="collab-export" class="ct-btn">⬇导出</button>
                <input type="file" id="collab-import-file" accept=".json,.geojson" style="display:none">
                <span id="collab-status" class="ct-status"></span>
            </div>
        `;
        document.body.appendChild(bar);
        this.#toolbar = bar;

        // 事件绑定
        document.getElementById('collab-user').onclick = () => this.#openRenamePanel();

        document.getElementById('collab-project').onchange = async (e) => {
            this.#sync.setProjectId(Number(e.target.value));
            this.#activeLayerId = null;
            // 清空地图上现有协作图层
            this.#sync.getLayers().forEach(l => this.#map.removeLayer(l.group));
            this.#sync.getLayers().clear();
            await this.#sync.refresh();
            if (this.#realtime) this.#realtime.setProject(Number(e.target.value));
        };

        document.getElementById('collab-new-project').onclick = () => this.#openNewProjectPanel();

        document.getElementById('collab-del-project').onclick = () => this.#openDeleteProjectPanel();

        document.getElementById('collab-new-layer').onclick = () => this.#openNewLayerPanel();

        document.getElementById('collab-layer-select').onchange = (e) => {
            this.#activeLayerId = Number(e.target.value);
            const local = this.#sync.getLayers().get(this.#activeLayerId);
            if (local) document.getElementById('collab-layer-color').value = local.color;
            this.#sync.setEditingLayer(this.#activeLayerId);
            if (this.#realtime) this.#realtime.setEditing(this.#activeLayerId || null);
        };

        document.getElementById('collab-layer-color').onchange = (e) => {
            const local = this.#sync.getLayers().get(this.#activeLayerId);
            if (local) {
                local.color = e.target.value;
                local.group.setStyle && local.group.setStyle({ color: e.target.value, fillColor: e.target.value });
                this.#sync.saveLayer(this.#activeLayerId);
            }
        };

        document.getElementById('collab-del-layer').onclick = async () => {
            if (!this.#activeLayerId) { alert('请先选择图层'); return; }
            const local = this.#sync.getLayers().get(this.#activeLayerId);
            if (!confirm(`确定删除图层「${local?.meta.name}」？此操作对所有协作者生效。`)) return;
            await this.#sync.deleteLayer(this.#activeLayerId);
            this.#activeLayerId = null;
            this.#refreshLayerSelect();
        };

        // 绘图按钮
        bar.querySelectorAll('.ct-draw').forEach(btn => {
            btn.onclick = () => {
                if (!this.#ensureLayer()) return;
                this.#map.pm.enableDraw(btn.dataset.draw, { snappable: true });
            };
        });

        document.getElementById('collab-edit-mode').onclick = () => {
            if (!this.#ensureLayer()) return;
            this.#map.pm.toggleGlobalEditMode();
        };
        document.getElementById('collab-drag-mode').onclick = () => {
            if (!this.#ensureLayer()) return;
            this.#map.pm.toggleGlobalDragMode();
        };
        document.getElementById('collab-remove-mode').onclick = () => {
            if (!this.#ensureLayer()) return;
            this.#map.pm.toggleGlobalRemovalMode();
        };

        document.getElementById('collab-import').onclick = () => {
            if (!this.#ensureLayer()) { this.#warnNoLayer('导入'); return; }
            document.getElementById('collab-import-file').click();
        };
        document.getElementById('collab-import-file').onchange = (e) => this.#handleImport(e);
        document.getElementById('collab-export').onclick = () => this.#handleExport();

        document.getElementById('collab-basemap').onclick = () => this.#openBasemapPanel();
        document.getElementById('collab-icons').onclick = () => this.#openIconPanel();
    }

    #ensureLayer() {
        if (!this.#activeLayerId || !this.#sync.getLayers().has(this.#activeLayerId)) {
            this.#setStatus('请先在工具条选择或新建一个图层');
            return false;
        }
        this.#sync.setEditingLayer(this.#activeLayerId);
        // 把 geoman 全局绘制目标指向当前图层
        const group = this.#sync.bindEditingGroup(this.#activeLayerId);
        if (group) {
            this.#map.pm.setGlobalOptions({ layerGroup: group });
        }
        return true;
    }

    // ---------- 绘图完成 -> 保存 ----------
    #setupDrawHandlers() {
        this.#map.on('pm:create', (e) => {
            if (!this.#activeLayerId) return;
            const local = this.#sync.getLayers().get(this.#activeLayerId);
            if (!local) return;

            // geoman 已经把图形加到 setGlobalOptions 指定的 group
            // 给新图形绑定编辑弹窗
            const layer = e.layer;
            if (!layer.feature) layer.feature = { type: 'Feature', properties: {} };
            layer.bindPopup(() => this.#sync._buildPopupFor ? null : this.#simplePopup(layer));
            layer.on('popupclose', () => this.#sync.scheduleSave(this.#activeLayerId));

            this.#sync.scheduleSave(this.#activeLayerId);
            this.#setStatus('已添加要素并同步');
        });

        // 编辑/移动/删除后也触发保存
        ['pm:edit', 'pm:update', 'pm:dragend', 'pm:remove'].forEach(ev => {
            this.#map.on(ev, () => {
                if (this.#activeLayerId) this.#sync.scheduleSave(this.#activeLayerId);
            });
        });
    }

    #simplePopup(layer) {
        if (!layer.feature) layer.feature = { type: 'Feature', properties: {} };
        if (!layer.feature.properties) layer.feature.properties = {};
        const props = layer.feature.properties;
        const wrap = document.createElement('div');
        wrap.className = 'planner-popup';
        const fields = [
            ['name', '名称', 'text'],
            ['status', '状态', 'select'],
            ['priority', '优先级', 'select'],
            ['owner', '负责人', 'text'],
            ['note', '备注', 'textarea']
        ];
        const opts = { status: ['待规划', '进行中', '已完成', '已废弃'], priority: ['高', '中', '低'] };
        fields.forEach(([key, label, type]) => {
            const p = document.createElement('p');
            const lb = document.createElement('label');
            lb.textContent = label + '：'; lb.style.fontWeight = 'bold'; lb.style.display = 'block';
            let input;
            if (type === 'select') {
                input = document.createElement('select');
                opts[key].forEach(o => { const op = document.createElement('option'); op.value = o; op.textContent = o; input.appendChild(op); });
            } else if (type === 'textarea') { input = document.createElement('textarea'); input.rows = 2; }
            else { input = document.createElement('input'); input.type = 'text'; }
            input.style.width = '180px';
            if (props[key] != null) input.value = props[key];
            input.onchange = (ev) => { props[key] = ev.target.value; this.#sync.scheduleSave(this.#activeLayerId); };
            p.appendChild(lb); p.appendChild(input); wrap.appendChild(p);
        });
        // 点位支持选择图标 (复用 sync 的图标选择器)
        if (layer instanceof L.Marker && this.#sync.buildIconSelector) {
            wrap.appendChild(this.#sync.buildIconSelector(layer, props, this.#activeLayerId));
        }
        return wrap;
    }

    // ---------- 导入 / 导出 ----------
    #handleImport(event) {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const geojson = JSON.parse(e.target.result);
                const local = this.#sync.getLayers().get(this.#activeLayerId);
                const added = L.geoJSON(geojson, {
                    onEachFeature: (feature, lyr) => {
                        lyr.bindPopup(() => this.#simplePopup(lyr));
                    }
                });
                added.eachLayer(l => local.group.addLayer(l));
                this.#sync.saveLayer(this.#activeLayerId);
                this.#setStatus('GeoJSON 导入成功并已同步');
            } catch (err) {
                alert('导入失败：不是有效的 GeoJSON 文件\n' + err);
            }
        };
        reader.readAsText(file);
        event.target.value = '';
    }

    #handleExport() {
        if (!this.#activeLayerId) { this.#warnNoLayer('导出'); return; }
        const local = this.#sync.getLayers().get(this.#activeLayerId);
        const fc = local.group.toGeoJSON();
        const count = (fc.features || []).length;
        if (count === 0) {
            this.#setStatus('当前图层还没有任何要素，无需导出');
            return;
        }
        const data = JSON.stringify(fc, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${local.meta.name}.geojson`;
        a.click();
        this.#setStatus(`已导出 ${count} 个要素到 ${local.meta.name}.geojson`);
    }

    // 未选图层时的醒目提示 (替代不起眼的小灰字)
    #warnNoLayer(action) {
        this.#removePanel();
        const panel = this.#makePanel('⚠ 请先选择图层');
        panel.body.innerHTML = `
            <p class="pl-tip">「${action}」操作需要先指定一个图层作为目标。</p>
            <p class="pl-tip">请在顶部工具条的「选择图层」下拉里选一个，或点「＋图层」新建一个，然后再试。</p>
            <div class="pl-actions">
                <button id="warn-new-layer" class="ct-btn ct-draw">＋ 立即新建图层</button>
                <button id="warn-close" class="ct-btn">我知道了</button>
            </div>
        `;
        panel.body.querySelector('#warn-new-layer').onclick = () => this.#openNewLayerPanel();
        panel.body.querySelector('#warn-close').onclick = () => this.#removePanel();
    }

    // 非阻塞昵称修改面板 (替代原生 prompt, 避免阻塞文件选择框)
    #openRenamePanel() {
        this.#removePanel();
        const panel = this.#makePanel('👤 修改昵称');
        panel.body.innerHTML = `
            <div class="pl-field">
                <label>你的昵称（协作时显示给队友）</label>
                <input type="text" id="rn-name" value="${(this.#sync.getUsername() || '').replace(/"/g, '&quot;')}">
            </div>
            <div class="pl-actions">
                <button id="rn-ok" class="ct-btn ct-draw">保存</button>
            </div>
        `;
        const input = panel.body.querySelector('#rn-name');
        input.focus(); input.select();
        const submit = () => {
            const name = input.value.trim();
            if (!name) { input.focus(); return; }
            this.#sync.setUsername(name);
            document.getElementById('collab-user').textContent = '👤 ' + name;
            if (this.#realtime) this.#realtime.setUsername(name);
            this.#setStatus('昵称已更新为「' + name + '」');
            this.#removePanel();
        };
        panel.body.querySelector('#rn-ok').onclick = submit;
        input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    }

    // ========== 功能①: 替换/管理底图 ==========
    #openBasemapPanel() {
        this.#removePanel();
        const cfg = (window.BasemapManager && window.BasemapManager.getConfig()) || {};
        const panel = this.#makePanel('🗺️ 底图管理');
        panel.body.innerHTML = `
            <p class="pl-tip">替换游戏底图：可上传本地图片，或填入图片 URL。设置会保存在本机，下次打开仍生效。</p>
            <div class="pl-field">
                <label>上传本地底图图片</label>
                <input type="file" id="bm-file" accept="image/*">
                <span id="bm-file-name" class="pl-filename"></span>
            </div>
            <div class="pl-field">
                <label>或 图片 URL</label>
                <input type="text" id="bm-url" placeholder="https://... 或留空" value="${cfg.url && !cfg.url.startsWith('data:') ? cfg.url : ''}">
            </div>
            <div class="pl-field pl-inline">
                <span>底图宽度(px)</span><input type="number" id="bm-w" value="${cfg.width || 2048}" style="width:90px">
                <span>高度(px)</span><input type="number" id="bm-h" value="${cfg.height || 2048}" style="width:90px">
            </div>
            <div class="pl-actions">
                <button id="bm-apply" class="ct-btn ct-draw">应用底图</button>
                <button id="bm-reset" class="ct-btn">恢复默认</button>
            </div>
        `;
        let uploadedDataUrl = null;
        panel.body.querySelector('#bm-file').onchange = (e) => {
            const f = e.target.files[0];
            if (!f) return;
            const nameEl = panel.body.querySelector('#bm-file-name');
            if (nameEl) nameEl.textContent = '已选择：' + f.name;
            const reader = new FileReader();
            reader.onerror = () => this.#setStatus('图片读取失败，请换一张试试');
            reader.onload = (ev) => {
                uploadedDataUrl = ev.target.result;
                this.#setStatus('图片已读取，点"应用底图"生效');
                // 自动探测尺寸
                const img = new Image();
                img.onload = () => {
                    panel.body.querySelector('#bm-w').value = img.width;
                    panel.body.querySelector('#bm-h').value = img.height;
                };
                img.src = uploadedDataUrl;
            };
            reader.readAsDataURL(f);
        };
        panel.body.querySelector('#bm-apply').onclick = () => {
            const w = Number(panel.body.querySelector('#bm-w').value) || 2048;
            const h = Number(panel.body.querySelector('#bm-h').value) || 2048;
            const url = uploadedDataUrl || panel.body.querySelector('#bm-url').value.trim();
            if (!url) { this.#setStatus('请先上传图片或填写图片 URL'); return; }
            window.BasemapManager.apply({ url, width: w, height: h });
            this.#setStatus('底图已替换');
            this.#removePanel();
        };
        panel.body.querySelector('#bm-reset').onclick = () => {
            window.BasemapManager.reset();
            this.#setStatus('已恢复默认底图');
            this.#removePanel();
        };
    }

    // ========== 功能②: 导入/管理玩法点图标 ==========
    #openIconPanel() {
        this.#removePanel();
        const panel = this.#makePanel('🎨 玩法点图标库');
        const render = () => {
            const icons = IconLibrary.list();
            panel.body.innerHTML = `
                <p class="pl-tip">上传玩法点图标（如 BOSS、宝箱、传送点）。导入后，在点位弹窗的"图标"下拉里即可选用。</p>
                <div class="pl-field">
                    <label>导入新图标（图片）</label>
                    <input type="file" id="ic-file" accept="image/*">
                    <span id="ic-file-name" class="pl-filename"></span>
                </div>
                <div class="pl-field pl-inline">
                    <span>名称</span><input type="text" id="ic-name" placeholder="如：BOSS" style="width:120px">
                    <span>尺寸(px)</span><input type="number" id="ic-size" value="32" style="width:70px">
                    <button id="ic-add" class="ct-btn ct-draw">添加到图标库</button>
                </div>
                <div class="pl-icon-grid">
                    ${icons.length ? icons.map(ic => `
                        <div class="pl-icon-item" title="${ic.name}">
                            <img src="${ic.dataUrl}" width="32" height="32">
                            <span>${ic.name}</span>
                            <button class="pl-icon-del" data-id="${ic.id}">✕</button>
                        </div>`).join('') : '<p class="pl-tip">图标库为空</p>'}
                </div>
            `;
            let pendingDataUrl = null;
            panel.body.querySelector('#ic-file').onchange = (e) => {
                const f = e.target.files[0];
                if (!f) return;
                const nameEl = panel.body.querySelector('#ic-file-name');
                if (nameEl) nameEl.textContent = '已选择：' + f.name;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    pendingDataUrl = ev.target.result;
                    if (!panel.body.querySelector('#ic-name').value) {
                        panel.body.querySelector('#ic-name').value = f.name.replace(/\.[^.]+$/, '');
                    }
                };
                reader.readAsDataURL(f);
            };
            panel.body.querySelector('#ic-add').onclick = () => {
                const name = panel.body.querySelector('#ic-name').value.trim() || '未命名图标';
                const size = Number(panel.body.querySelector('#ic-size').value) || 32;
                if (!pendingDataUrl) { this.#setStatus('请先选择图标图片'); return; }
                IconLibrary.add(name, pendingDataUrl, size);
                this.#setStatus(`已添加图标「${name}」`);
                render();
            };
            panel.body.querySelectorAll('.pl-icon-del').forEach(btn => {
                btn.onclick = () => {
                    IconLibrary.remove(btn.dataset.id);
                    render();
                };
            });
        };
        render();
    }

    // ========== 新建工程 / 新建图层 (非阻塞面板) ==========
    #openNewProjectPanel() {
        this.#removePanel();
        const panel = this.#makePanel('＋ 新建规划工程');
        panel.body.innerHTML = `
            <div class="pl-field">
                <label>工程名称</label>
                <input type="text" id="np-name" placeholder="如：主线规划 / 资源点规划" value="新规划方案">
            </div>
            <div class="pl-actions">
                <button id="np-ok" class="ct-btn ct-draw">创建</button>
            </div>
        `;
        const input = panel.body.querySelector('#np-name');
        input.focus(); input.select();
        const submit = async () => {
            const name = input.value.trim();
            if (!name) { input.focus(); return; }
            const p = await this.#sync.createProject(name);
            await this.#loadProjects();
            const sel = document.getElementById('collab-project');
            sel.value = p.id;
            sel.dispatchEvent(new Event('change'));
            this.#setStatus(`已创建工程「${name}」`);
            this.#removePanel();
        };
        panel.body.querySelector('#np-ok').onclick = submit;
        input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    }

    // ========== 删除工程 (二次确认 + 安全兜底) ==========
    async #openDeleteProjectPanel() {
        this.#removePanel();
        const sel = document.getElementById('collab-project');
        const curId = Number(sel.value);
        const curName = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : '当前工程';
        const projects = await this.#sync.listProjects();

        // 安全兜底: 至少保留一个工程, 不允许删光
        if (projects.length <= 1) {
            const panel = this.#makePanel('⚠ 无法删除');
            panel.body.innerHTML = `
                <p class="pl-tip">当前只剩这一个工程了，不能删除。</p>
                <p class="pl-tip">如需清空内容，请删除工程下的图层，或先新建另一个工程再删除此工程。</p>
                <div class="pl-actions"><button id="dp-close" class="ct-btn">我知道了</button></div>
            `;
            panel.body.querySelector('#dp-close').onclick = () => this.#removePanel();
            return;
        }

        const layerCount = this.#sync.getLayers().size;
        const panel = this.#makePanel('🗑 删除工程');
        panel.body.innerHTML = `
            <p class="pl-tip" style="color:#c62828">确定删除工程「<b>${curName}</b>」吗？</p>
            <p class="pl-tip">⚠ 该工程下的 <b>${layerCount}</b> 个图层及其所有点位/区域将被<b>一并永久删除</b>，且<b>对所有协作者生效</b>，此操作<b>不可恢复</b>。</p>
            <p class="pl-tip">如需保留数据，请先用「⬇导出」备份各图层。</p>
            <div class="pl-field">
                <label>请输入工程名称以确认删除</label>
                <input type="text" id="dp-confirm" placeholder="${curName}">
            </div>
            <div class="pl-actions">
                <button id="dp-ok" class="ct-btn ct-danger" disabled>确认删除</button>
                <button id="dp-cancel" class="ct-btn">取消</button>
            </div>
        `;
        const confirmInput = panel.body.querySelector('#dp-confirm');
        const okBtn = panel.body.querySelector('#dp-ok');
        confirmInput.focus();
        confirmInput.oninput = () => { okBtn.disabled = confirmInput.value.trim() !== curName; };
        panel.body.querySelector('#dp-cancel').onclick = () => this.#removePanel();

        okBtn.onclick = async () => {
            okBtn.disabled = true;
            okBtn.textContent = '删除中…';
            try {
                await this.#sync.deleteProject(curId);
                // 切换到剩余工程中的第一个
                const remain = projects.filter(p => p.id !== curId);
                const next = remain[0];
                this.#sync.setProjectId(next.id);
                this.#activeLayerId = null;
                // 清空地图上当前工程的图层
                this.#sync.getLayers().forEach(l => this.#map.removeLayer(l.group));
                this.#sync.getLayers().clear();
                await this.#loadProjects();
                const selEl = document.getElementById('collab-project');
                selEl.value = next.id;
                await this.#sync.refresh();
                this.#refreshLayerSelect();
                if (this.#realtime) this.#realtime.setProject(next.id);
                this.#setStatus(`已删除工程「${curName}」，已切换到「${next.name}」`);
                this.#removePanel();
            } catch (err) {
                console.error('删除工程失败:', err);
                okBtn.disabled = false;
                okBtn.textContent = '确认删除';
                this.#setStatus('删除工程失败：' + (err.message || err));
            }
        };
    }

    #openNewLayerPanel() {
        this.#removePanel();
        const panel = this.#makePanel('＋ 新建图层');
        const color = document.getElementById('collab-layer-color').value || '#3388ff';
        panel.body.innerHTML = `
            <div class="pl-field">
                <label>图层名称</label>
                <input type="text" id="nl-name" placeholder="如：BOSS点位 / 资源区 / 路线">
            </div>
            <div class="pl-field pl-inline">
                <span>图层颜色</span><input type="color" id="nl-color" value="${color}">
            </div>
            <div class="pl-actions">
                <button id="nl-ok" class="ct-btn ct-draw">创建</button>
            </div>
        `;
        const input = panel.body.querySelector('#nl-name');
        const okBtn = panel.body.querySelector('#nl-ok');
        input.focus();
        const submit = async () => {
            const name = input.value.trim();
            if (!name) { input.focus(); this.#setStatus('请先填写图层名称'); return; }
            const c = panel.body.querySelector('#nl-color').value;
            okBtn.disabled = true;
            okBtn.textContent = '创建中…';
            try {
                const layer = await this.#sync.createLayer(name, c);
                if (!layer || layer.id == null) {
                    throw new Error((layer && layer.error) || '后端未返回有效图层');
                }
                this.#activeLayerId = layer.id;
                document.getElementById('collab-layer-color').value = c;
                this.#refreshLayerSelect();
                this.#sync.setEditingLayer(this.#activeLayerId);
                this.#setStatus(`已创建图层「${name}」，可开始绘制`);
                this.#removePanel();
            } catch (err) {
                console.error('新建图层失败:', err);
                okBtn.disabled = false;
                okBtn.textContent = '创建';
                this.#setStatus('新建图层失败：' + (err.message || err));
            }
        };
        okBtn.onclick = submit;
        input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    }

    // 通用浮动面板
    #makePanel(title) {
        const panel = document.createElement('div');
        panel.id = 'planner-panel';
        panel.innerHTML = `
            <div class="pl-head">
                <span>${title}</span>
                <button class="pl-close">✕</button>
            </div>
            <div class="pl-body"></div>
        `;
        document.body.appendChild(panel);
        panel.querySelector('.pl-close').onclick = () => this.#removePanel();
        return { el: panel, body: panel.querySelector('.pl-body') };
    }

    #removePanel() {
        const old = document.getElementById('planner-panel');
        if (old) old.remove();
    }

    // ---------- 列表渲染 ----------
    async #loadProjects() {
        const projects = await this.#sync.listProjects();
        const sel = document.getElementById('collab-project');
        sel.innerHTML = '';
        projects.forEach(p => {
            const o = document.createElement('option');
            o.value = p.id; o.textContent = p.name;
            sel.appendChild(o);
        });
        sel.value = this.#sync.getProjectId();
    }

    #refreshLayerSelect() {
        const sel = document.getElementById('collab-layer-select');
        sel.innerHTML = '<option value="">— 选择图层 —</option>';
        const myClientId = this.#realtime ? this.#realtime.getClientId() : null;
        this.#sync.getLayers().forEach((local, id) => {
            const o = document.createElement('option');
            o.value = id;
            // 找出正在编辑该图层的其他成员
            const editors = (this.#members || [])
                .filter(m => m.editingLayerId != null && Number(m.editingLayerId) === Number(id) && m.clientId !== myClientId)
                .map(m => m.username || '匿名');
            const editTag = editors.length ? ` ✎${editors.join('、')}编辑中` : '';
            o.textContent = `${local.meta.name} (v${local.version})${editTag}`;
            sel.appendChild(o);
        });
        if (this.#activeLayerId) sel.value = this.#activeLayerId;
    }

    #renderLayerList() {
        this.#refreshLayerSelect();
    }

    #setStatus(msg) {
        const el = document.getElementById('collab-status');
        if (!el) return;
        el.textContent = '✓ ' + msg;
        setTimeout(() => { el.textContent = ''; }, 3000);
    }
}
