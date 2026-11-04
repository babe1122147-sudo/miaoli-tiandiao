/* 苗栗田調 手機紀錄頁 v2.0
 * 離線可填、恢復連線自動同步到 Google 試算表（Apps Script 接收）
 */
(function () {
  'use strict';
  const APP_VERSION = '2.0.0';
  const LS_RECORDS = 'mlt_records_v2';
  const LS_SETTINGS = 'mlt_settings_v2';
  const ORDER = ['basic', 'identity', 'welfare', 'stage0', 'stage1', '#passes', '#activities', 'welfare_end', 'safety', 'ecology', '#events', 'judgement'];
  const LEVEL_OF = {};
  FORM.ladder.forEach(g => g.items.forEach(it => { LEVEL_OF[it] = g.lv; }));
  const LADDER_ITEMS = FORM.ladder.flatMap(g => g.items);
  // 固定的試算表欄位順序（依題目順序；勾選行為後面接「_最高層級」）
  const colsOf = fields => fields.flatMap(f => f.t === 'ladder' ? [f.k, f.k + '_最高層級'] : [f.k]);
  const COLUMNS = {
    main: ORDER.filter(id => id[0] !== '#').flatMap(id => colsOf(FORM.sections.find(s => s.id === id).fields)),
    passes: colsOf(FORM.passes.fields), activities: colsOf(FORM.activities.fields), events: colsOf(FORM.events.fields),
  };

  const $app = document.getElementById('app');
  const $sync = document.getElementById('syncBadge');
  let state = { view: 'home', dogId: null, recordId: null, mode: 'live' };
  let syncing = false;

  // ---------- 儲存 ----------
  const loadRecords = () => { try { return JSON.parse(localStorage.getItem(LS_RECORDS) || '{}'); } catch (e) { return {}; } };
  const saveRecords = r => localStorage.setItem(LS_RECORDS, JSON.stringify(r));
  const loadSettings = () => { try { return JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}'); } catch (e) { return {}; } };
  const saveSettings = s => localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'r-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  const nowIso = () => new Date().toISOString();
  const pad = n => String(n).padStart(2, '0');
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dogById = id => FORM.dogs.find(d => d.id === id);
  const maxLevel = arr => (arr || []).reduce((m, it) => Math.max(m, LEVEL_OF[it] || 0), 0);

  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function updateSyncBadge() {
    const recs = Object.values(loadRecords());
    const pending = recs.filter(r => r.status === 'pending').length;
    if (syncing) { $sync.textContent = '同步中…'; $sync.className = 'badge busy'; }
    else if (pending) { $sync.textContent = `待上傳 ${pending} 筆`; $sync.className = 'badge warn'; }
    else { $sync.textContent = navigator.onLine ? '已全部上傳' : '離線中'; $sync.className = navigator.onLine ? 'badge ok' : 'badge'; }
  }

  // ---------- 新紀錄 ----------
  function newRecord(dogId) {
    const recs = loadRecords();
    const count = Object.values(recs).filter(r => r.dog_id === dogId).length;
    const visit = ['第1次', '第2次', '第3次', '第4次'][count] || '加訪';
    const s = loadSettings();
    const isFirst = visit === '第1次';
    const r = {
      record_id: uuid(), dog_id: dogId, created_at: nowIso(), updated_at: nowIso(), status: 'draft',
      main: { '訪視次序': visit, '日期': today(), '開始時間': nowTime(), '紀錄者': s.recorder || '', '階段0_觀察秒數': 300, '階段5_觀察秒數': 300 },
      passes: (isFirst ? ['前測1', '前測2（僅第1次）', '後測'] : ['前測1', '後測']).map(x => ({ '測試序': x, '是否執行': '執行' })),
      activities: [{ '活動類型': '' }],
      events: [],
    };
    recs[r.record_id] = r; saveRecords(recs);
    return r;
  }

  // ---------- 畫面：首頁 ----------
  function renderHome() {
    const recs = Object.values(loadRecords());
    const cards = FORM.dogs.map(d => {
      const mine = recs.filter(r => r.dog_id === d.id).sort((a, b) => (b.main['日期'] || '').localeCompare(a.main['日期'] || ''));
      const last = mine[0];
      return `<button class="dog" data-dog="${esc(d.id)}">
        <span class="dog-id">${esc(d.id)}</span>
        <span class="dog-name">${esc(d.name)}</span>
        <span class="dog-meta">${esc(d.type)}｜${esc(d.point)}</span>
        <span class="dog-meta">${last ? `最近：${esc(last.main['日期'])} ${esc(last.main['訪視次序'])}` : '尚無紀錄'}</span>
      </button>`;
    }).join('');
    $app.innerHTML = `<p class="lead">選擇犬隻（一律以編號辨識）</p><div class="grid">${cards}</div>
      <div class="row gap"><button class="btn ghost" id="goSettings">設定</button><button class="btn ghost" id="syncNow">立即同步</button></div>
      <p class="small">版本 ${APP_VERSION}｜${esc(FORM.version)}</p>`;
    $app.querySelectorAll('[data-dog]').forEach(b => b.onclick = () => go({ view: 'dog', dogId: b.dataset.dog }));
    document.getElementById('goSettings').onclick = () => go({ view: 'settings' });
    document.getElementById('syncNow').onclick = () => syncAll(true);
  }

  // ---------- 畫面：單隻犬 ----------
  function renderDog() {
    const d = dogById(state.dogId);
    const recs = Object.values(loadRecords()).filter(r => r.dog_id === d.id)
      .sort((a, b) => (b.main['日期'] || '').localeCompare(a.main['日期'] || '') || b.updated_at.localeCompare(a.updated_at));
    const st = { draft: '草稿', pending: '待上傳', synced: '已上傳' };
    const list = recs.length ? recs.map(r => `<button class="item" data-rec="${esc(r.record_id)}">
        <span><b>${esc(r.main['日期'] || '')}</b>　${esc(r.main['訪視次序'] || '')}</span>
        <span class="pill ${r.status}">${st[r.status] || r.status}</span></button>`).join('') : '<p class="small">這支手機上還沒有紀錄。</p>';
    $app.innerHTML = `<button class="back" id="back">‹ 返回</button>
      <h2>${esc(d.id)}｜${esc(d.name)}</h2><p class="small">${esc(d.type)}｜${esc(d.point)}</p>
      <button class="btn primary block" id="newRec">＋ 新增本次紀錄</button>
      <h3>紀錄</h3><div class="list">${list}</div>
      <button class="btn ghost block" id="pull">從雲端載入這隻狗的紀錄</button>`;
    document.getElementById('back').onclick = () => go({ view: 'home' });
    document.getElementById('newRec').onclick = () => { const r = newRecord(d.id); go({ view: 'form', recordId: r.record_id }); };
    document.getElementById('pull').onclick = () => pullDog(d.id);
    $app.querySelectorAll('[data-rec]').forEach(b => b.onclick = () => go({ view: 'form', recordId: b.dataset.rec }));
  }

  // ---------- 表單欄位 ----------
  function fieldHtml(f, val, path, dog) {
    if (f.chained && dog.type !== '鏈養') return '';
    if (state.mode === 'live' && f.src === 'video') return '';
    const badge = f.src === 'video' ? '<span class="tag">影片補</span>' : '';
    const label = `<label class="flabel">${esc(f.k)}${f.req ? ' <span class="req">*</span>' : ''}${badge}</label>`;
    const hint = f.hint ? `<div class="hint">${esc(f.hint)}</div>` : '';
    const name = `data-path="${esc(path)}" data-k="${esc(f.k)}" data-t="${f.t}"`;
    let input = '';
    if (f.t === 'select' || f.t === 'multi') {
      const sel = f.t === 'multi' ? (Array.isArray(val) ? val : []) : [val];
      input = `<div class="chips" ${name}>${f.o.map(o => `<button type="button" class="chip${sel.includes(o) ? ' on' : ''}" data-v="${esc(o)}">${esc(o)}</button>`).join('')}</div>`;
    } else if (f.t === 'ladder') {
      const sel = Array.isArray(val) ? val : [];
      const lv = maxLevel(sel);
      input = `<div class="chips ladder" ${name}>${LADDER_ITEMS.map(o => `<button type="button" class="chip${sel.includes(o) ? ' on' : ''}" data-v="${esc(o)}">${esc(o)}</button>`).join('')}</div>
        <div class="lvl" data-lvl="${esc(path + '|' + f.k)}">${lv ? `最高層級：第 ${lv} 層${lv >= 4 ? '（已超過反應門檻）' : ''}` : '尚未勾選'}</div>`;
    } else if (f.t === 'textarea') {
      input = `<textarea ${name} rows="3">${esc(val)}</textarea>`;
    } else {
      const type = f.t === 'number' ? 'number' : f.t;
      const extra = f.t === 'number' ? ' inputmode="decimal" step="any"' : '';
      input = `<input ${name} type="${type}"${extra} value="${esc(val)}">`;
    }
    return `<div class="field">${label}${hint}${input}</div>`;
  }

  function sectionHtml(sec, rec, dog) {
    const body = sec.fields.map(f => fieldHtml(f, rec.main[f.k], 'main', dog)).join('');
    if (!body.trim()) return '';
    return `<details class="sec" open><summary>${esc(sec.title)}</summary>${body}</details>`;
  }

  function repeatHtml(key, def, rec, dog, addLabel) {
    const rows = rec[key] || [];
    const blocks = rows.map((row, i) => `<div class="rep"><div class="rep-h"><b>第 ${i + 1} 筆</b><button type="button" class="link danger" data-del="${key}|${i}">刪除</button></div>
      ${def.fields.map(f => fieldHtml(f, row[f.k], `${key}|${i}`, dog)).join('')}</div>`).join('');
    return `<details class="sec" open><summary>${esc(def.title)}</summary>${def.note ? `<div class="hint">${esc(def.note)}</div>` : ''}
      ${blocks}<button type="button" class="btn ghost block" data-add="${key}">＋ ${addLabel}</button></details>`;
  }

  function renderForm() {
    const recs = loadRecords();
    const rec = recs[state.recordId];
    if (!rec) return go({ view: 'home' });
    const dog = dogById(rec.dog_id);
    const parts = ORDER.map(id => {
      if (id === '#passes') return repeatHtml('passes', FORM.passes, rec, dog, '新增一次經過');
      if (id === '#activities') return repeatHtml('activities', FORM.activities, rec, dog, '新增活動');
      if (id === '#events') return repeatHtml('events', FORM.events, rec, dog, '新增事件');
      return sectionHtml(FORM.sections.find(s => s.id === id), rec, dog);
    }).join('');
    $app.innerHTML = `<button class="back" id="back">‹ ${esc(dog.id)}｜${esc(dog.name)}</button>
      <div class="mode"><button class="seg${state.mode === 'live' ? ' on' : ''}" data-mode="live">現場快填</button><button class="seg${state.mode === 'all' ? ' on' : ''}" data-mode="all">完整（含影片補）</button></div>
      <form id="f" autocomplete="off">${parts}</form>
      <div class="bar"><button class="btn ghost" id="saveDraft">存草稿</button><button class="btn primary" id="submit">送出</button></div>`;
    document.getElementById('back').onclick = () => { persistForm(); go({ view: 'dog', dogId: dog.id }); };
    $app.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { persistForm(); state.mode = b.dataset.mode; renderForm(); });
    bindForm(rec);
    document.getElementById('saveDraft').onclick = () => { persistForm(); toast('已存在這支手機'); };
    document.getElementById('submit').onclick = () => submitRecord();
  }

  function setVal(rec, path, k, v) {
    if (path === 'main') rec.main[k] = v;
    else { const [key, i] = path.split('|'); rec[key][Number(i)][k] = v; }
  }

  function bindForm(rec) {
    $app.querySelectorAll('.chips').forEach(box => {
      box.addEventListener('click', e => {
        const b = e.target.closest('.chip'); if (!b) return;
        const multi = box.dataset.t === 'multi' || box.dataset.t === 'ladder';
        if (multi) b.classList.toggle('on');
        else { const was = b.classList.contains('on'); box.querySelectorAll('.chip').forEach(c => c.classList.remove('on')); if (!was) b.classList.add('on'); }
        if (box.dataset.t === 'ladder') {
          const sel = [...box.querySelectorAll('.chip.on')].map(c => c.dataset.v);
          const lv = maxLevel(sel);
          const el = $app.querySelector(`[data-lvl="${CSS.escape(box.dataset.path + '|' + box.dataset.k)}"]`);
          if (el) el.textContent = lv ? `最高層級：第 ${lv} 層${lv >= 4 ? '（已超過反應門檻）' : ''}` : '尚未勾選';
        }
        persistForm();
      });
    });
    $app.querySelectorAll('input,textarea').forEach(el => el.addEventListener('change', persistForm));
    $app.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
      persistForm(); const r = loadRecords(); const x = r[state.recordId];
      x[b.dataset.add] = x[b.dataset.add] || []; x[b.dataset.add].push({}); x.updated_at = nowIso(); if (x.status !== 'draft') x.status = 'draft'; r[state.recordId] = x; saveRecords(r); renderForm();
    });
    $app.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
      if (!confirm('確定刪除這一筆？')) return;
      persistForm(); const [key, i] = b.dataset.del.split('|'); const r = loadRecords(); r[state.recordId][key].splice(Number(i), 1); r[state.recordId].updated_at = nowIso(); r[state.recordId].status = 'draft'; saveRecords(r); renderForm();
    });
  }

  function persistForm() {
    const recs = loadRecords();
    const rec = recs[state.recordId]; if (!rec) return;
    const before = JSON.stringify([rec.main, rec.passes, rec.activities, rec.events]);
    $app.querySelectorAll('.chips').forEach(box => {
      const sel = [...box.querySelectorAll('.chip.on')].map(c => c.dataset.v);
      const v = box.dataset.t === 'select' ? (sel[0] || '') : sel;
      setVal(rec, box.dataset.path, box.dataset.k, v);
    });
    $app.querySelectorAll('input[data-path],textarea[data-path]').forEach(el => {
      let v = el.value;
      if (el.dataset.t === 'number') v = v === '' ? '' : Number(v);
      setVal(rec, el.dataset.path, el.dataset.k, v);
    });
    const after = JSON.stringify([rec.main, rec.passes, rec.activities, rec.events]);
    if (before === after) return;
    rec.updated_at = nowIso();
    if (rec.status === 'synced' || rec.status === 'pending') rec.status = 'draft';
    recs[rec.record_id] = rec; saveRecords(recs); updateSyncBadge();
  }

  function validate(rec) {
    const miss = [];
    FORM.sections.forEach(s => s.fields.forEach(f => { if (f.req && !rec.main[f.k]) miss.push(f.k); }));
    (rec.passes || []).forEach((p, i) => { if (!p['測試序']) miss.push(`刺激測試第 ${i + 1} 筆的測試序`); });
    (rec.activities || []).forEach((a, i) => { if (!a['活動類型']) miss.push(`陪伴活動第 ${i + 1} 筆的活動類型`); });
    return miss;
  }

  function submitRecord() {
    persistForm();
    const recs = loadRecords(); const rec = recs[state.recordId];
    const miss = validate(rec);
    if (miss.length) { toast('尚未填：' + miss.slice(0, 3).join('、')); return; }
    rec.status = 'pending'; recs[rec.record_id] = rec; saveRecords(recs);
    toast('已存好，正在上傳');
    syncAll(false).then(() => go({ view: 'dog', dogId: rec.dog_id }));
  }

  // ---------- 同步 ----------
  function payloadOf(rec, key) {
    const dog = dogById(rec.dog_id) || { name: '' };
    const withLevels = rows => (rows || []).map(row => {
      const out = Object.assign({}, row);
      Object.keys(row).forEach(k => { if (Array.isArray(row[k]) && row[k].some(v => LEVEL_OF[v])) out[k + '_最高層級'] = maxLevel(row[k]) || ''; });
      return out;
    });
    return {
      key, app_version: APP_VERSION, form_version: FORM.version, columns: COLUMNS,
      record: {
        record_id: rec.record_id, dog_id: rec.dog_id, dog_name: dog.name, created_at: rec.created_at, updated_at: rec.updated_at,
        main: rec.main, passes: withLevels(rec.passes), activities: withLevels(rec.activities), events: withLevels(rec.events),
      },
    };
  }

  async function syncAll(manual) {
    const s = loadSettings();
    if (!s.url || !s.key) { if (manual) toast('請先到「設定」填網址與存取金鑰'); updateSyncBadge(); return; }
    if (!navigator.onLine) { if (manual) toast('目前離線，恢復連線後會自動上傳'); updateSyncBadge(); return; }
    if (syncing) return;
    syncing = true; updateSyncBadge();
    let ok = 0, fail = 0, lastErr = '';
    const ids = Object.values(loadRecords()).filter(r => r.status === 'pending').map(r => r.record_id);
    for (const id of ids) {
      const rec = loadRecords()[id]; if (!rec || rec.status !== 'pending') continue;
      const sentAt = rec.updated_at;
      try {
        const res = await fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payloadOf(rec, s.key)), redirect: 'follow' });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '伺服器拒絕');
        const recs = loadRecords();
        if (recs[id] && recs[id].updated_at === sentAt) { recs[id].status = 'synced'; recs[id].synced_at = nowIso(); saveRecords(recs); }
        ok++;
      } catch (e) { fail++; lastErr = e.message; }
    }
    syncing = false; updateSyncBadge();
    if (manual || ids.length) {
      if (fail) toast(`上傳失敗 ${fail} 筆，會再自動重試（${lastErr}）`);
      else if (ok) toast(`已上傳 ${ok} 筆`);
      else if (manual) toast('沒有需要上傳的紀錄');
    }
    if (state.view === 'dog') renderDog();
  }

  async function pullDog(dogId) {
    const s = loadSettings();
    if (!s.url || !s.key) return toast('請先到「設定」填網址與存取金鑰');
    if (!navigator.onLine) return toast('目前離線');
    try {
      const res = await fetch(`${s.url}?action=list&dog=${encodeURIComponent(dogId)}&key=${encodeURIComponent(s.key)}`, { redirect: 'follow' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || '讀取失敗');
      const recs = loadRecords(); let added = 0;
      (data.records || []).forEach(r => {
        const local = recs[r.record_id];
        if (local && (local.status === 'pending' || local.status === 'draft') && local.updated_at > r.updated_at) return; // 手機上較新的不覆蓋
        recs[r.record_id] = { record_id: r.record_id, dog_id: r.dog_id, created_at: r.created_at, updated_at: r.updated_at, status: 'synced',
          main: r.main || {}, passes: stripLv(r.passes), activities: stripLv(r.activities), events: stripLv(r.events) };
        added++;
      });
      saveRecords(recs); toast(`已載入 ${added} 筆`); renderDog();
    } catch (e) { toast('載入失敗：' + e.message); }
  }
  const stripLv = rows => (rows || []).map(r => { const o = {}; Object.keys(r).forEach(k => { if (!/_最高層級$/.test(k)) o[k] = r[k]; }); return o; });

  // ---------- 設定 ----------
  function renderSettings() {
    const s = loadSettings();
    $app.innerHTML = `<button class="back" id="back">‹ 返回</button><h2>設定</h2>
      <div class="field"><label class="flabel">Apps Script 網址</label><input id="sUrl" type="url" value="${esc(s.url || '')}" placeholder="https://script.google.com/macros/s/…/exec"></div>
      <div class="field"><label class="flabel">存取金鑰</label><input id="sKey" type="password" value="${esc(s.key || '')}"><div class="hint">與 Apps Script「指令碼屬性」ACCESS_KEY 相同</div></div>
      <div class="field"><label class="flabel">紀錄者預設名稱</label><input id="sRec" type="text" value="${esc(s.recorder || '')}"></div>
      <button class="btn primary block" id="sSave">儲存</button>
      <button class="btn ghost block" id="sTest">測試連線</button>
      <h3>資料備份</h3><button class="btn ghost block" id="sExport">下載本機所有紀錄（JSON）</button>`;
    document.getElementById('back').onclick = () => go({ view: 'home' });
    const read = () => ({ url: document.getElementById('sUrl').value.trim(), key: document.getElementById('sKey').value.trim(), recorder: document.getElementById('sRec').value.trim() });
    document.getElementById('sSave').onclick = () => { saveSettings(read()); toast('已儲存'); };
    document.getElementById('sTest').onclick = async () => {
      const x = read(); saveSettings(x);
      try { const r = await fetch(`${x.url}?action=ping&key=${encodeURIComponent(x.key)}`, { redirect: 'follow' }); const d = await r.json(); toast(d.ok ? '連線成功' : '連線失敗：' + d.error); }
      catch (e) { toast('連線失敗：' + e.message); }
    };
    document.getElementById('sExport').onclick = () => {
      const blob = new Blob([JSON.stringify(loadRecords(), null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `苗栗田調_備份_${today()}.json`; a.click();
    };
  }

  // ---------- 路由 ----------
  function go(next) {
    state = Object.assign(state, next);
    window.scrollTo(0, 0);
    if (state.view === 'home') renderHome();
    else if (state.view === 'dog') renderDog();
    else if (state.view === 'form') renderForm();
    else if (state.view === 'settings') renderSettings();
    updateSyncBadge();
  }

  window.addEventListener('online', () => syncAll(false));
  window.addEventListener('offline', updateSyncBadge);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncAll(false); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  go({ view: 'home' });
  syncAll(false);
})();
