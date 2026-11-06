/* 苗栗田調 手機紀錄頁 v2.4
 * 離線可填、恢復連線自動同步到 Google 試算表（Apps Script 接收）
 */
(function () {
  'use strict';
  const APP_VERSION = '2.4.0';
  const LS_RECORDS = 'mlt_records_v2';
  const LS_SETTINGS = 'mlt_settings_v2';
  const VISITS = ['第1次', '第2次', '第3次', '第4次'];
  const IDENTITY_KEYS = FORM.sections.find(s => s.id === 'identity').fields.map(f => f.k);
  const TIMINGS = FORM.passes.timings;
  const secById = id => FORM.sections.find(s => s.id === id);

  // 固定的試算表欄位順序：客觀行為紀錄不自動推定壓力門檻或最高階梯層級。
  const colsOf = fields => fields.map(f => f.k);
  const COLUMNS = {
    main: FORM.layout.flatMap(L => L.sec ? colsOf(secById(L.sec).fields) : L.events ? colsOf(FORM.events.head) : []),
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
  const isEmpty = v => v === '' || v == null || (Array.isArray(v) && !v.length);

  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3000);
  }

  function updateSyncBadge() {
    const recs = Object.values(loadRecords());
    const pending = recs.filter(r => r.status === 'pending').length;
    const drafts = recs.filter(r => r.status === 'draft').length;
    if (syncing) { $sync.textContent = '同步中…'; $sync.className = 'badge busy'; }
    else if (pending) { $sync.textContent = `待上傳 ${pending} 筆`; $sync.className = 'badge warn'; }
    else if (drafts) { $sync.textContent = `草稿 ${drafts} 筆`; $sync.className = 'badge'; }
    else { $sync.textContent = navigator.onLine ? '無待上傳紀錄' : '離線中'; $sync.className = navigator.onLine ? 'badge ok' : 'badge'; }
  }

  // ---------- 行人經過：陪伴前、陪伴後各一趟；舊版第三趟仍完整保留 ----------
  function lastRecordOf(dogId, excludeId) {
    return Object.values(loadRecords()).filter(r => r.dog_id === dogId && r.record_id !== excludeId)
      .sort((a, b) => ((b.main['日期'] || '') + b.created_at).localeCompare((a.main['日期'] || '') + a.created_at))[0];
  }
  function lastDistance(dogId, excludeId) {
    const prev = lastRecordOf(dogId, excludeId);
    const p = prev && (prev.passes || []).find(x => !isEmpty(x['經過距離（公尺）']));
    return p ? p['經過距離（公尺）'] : '';
  }
  function makePasses(dogId, excludeId) {
    const dist = lastDistance(dogId, excludeId);
    return TIMINGS.map(x => ({ '經過時機': x, '是否執行': '', '經過距離（公尺）': dist }));
  }
  // 舊紀錄缺少的時機自動補上（不刪除既有資料）
  function ensurePasses(rec) {
    rec.passes = rec.passes || [];
    let changed = false;
    TIMINGS.forEach(x => {
      if (!rec.passes.some(p => p['經過時機'] === x)) {
        const dist = (rec.passes.find(p => !isEmpty(p['經過距離（公尺）'])) || {})['經過距離（公尺）'] || '';
        rec.passes.push({ '經過時機': x, '是否執行': '', '經過距離（公尺）': dist }); changed = true;
      }
    });
    return changed;
  }

  // ---------- 新紀錄 ----------
  function newRecord(dogId) {
    const recs = loadRecords();
    const count = Object.values(recs).filter(r => r.dog_id === dogId).length;
    const visit = VISITS[count] || '加訪';
    const r = {
      record_id: uuid(), dog_id: dogId, created_at: nowIso(), updated_at: nowIso(), status: 'draft',
      main: { '訪視次序': visit, '日期': today(), '開始時間': nowTime() },
      passes: makePasses(dogId, null),
      activities: [],
      events: [],
    };
    // 第 2 次以後自動沿用前一筆的身分資料
    const prev = lastRecordOf(dogId, r.record_id);
    if (visit !== '第1次' && prev) IDENTITY_KEYS.forEach(k => { if (!isEmpty(prev.main[k])) r.main[k] = prev.main[k]; });
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
      <button class="btn ghost block" id="pullAll">從雲端載入全部紀錄</button>
      <p class="small">版本 ${APP_VERSION}｜${esc(FORM.version)}</p>`;
    $app.querySelectorAll('[data-dog]').forEach(b => b.onclick = () => go({ view: 'dog', dogId: b.dataset.dog }));
    document.getElementById('goSettings').onclick = () => go({ view: 'settings' });
    document.getElementById('syncNow').onclick = () => syncAll(true);
    document.getElementById('pullAll').onclick = () => pull(null, true);
  }

  // ---------- 畫面：單隻犬 ----------
  function renderDog() {
    const d = dogById(state.dogId);
    const recs = Object.values(loadRecords()).filter(r => r.dog_id === d.id)
      .sort((a, b) => (b.main['日期'] || '').localeCompare(a.main['日期'] || '') || b.updated_at.localeCompare(a.updated_at));
    const st = { draft: '草稿', pending: '待上傳', synced: '已上傳' };
    const list = recs.length ? recs.map(r => `<button class="item" data-rec="${esc(r.record_id)}">
        <span><b>${esc(r.main['日期'] || '')}</b>　${esc(r.main['訪視次序'] || '')}</span>
        <span class="pill ${r.status}">${st[r.status] || r.status}</span></button>`).join('') : '<p class="small">這支手機上還沒有這隻狗的紀錄。</p>';
    $app.innerHTML = `<button class="back" id="back">‹ 返回</button>
      <h2>${esc(d.id)}｜${esc(d.name)}</h2><p class="small">${esc(d.type)}｜${esc(d.point)}</p>
      <button class="btn primary block" id="newRec">＋ 新增本次紀錄</button>
      <h3>紀錄</h3><div class="list">${list}</div>
      <button class="btn ghost block" id="pull">從雲端載入這隻狗的紀錄</button>
      <p class="small">看影片補填時，先載入再點選要補的那一筆。</p>`;
    document.getElementById('back').onclick = () => go({ view: 'home' });
    document.getElementById('newRec').onclick = () => { const r = newRecord(d.id); go({ view: 'form', recordId: r.record_id, mode: 'live' }); };
    document.getElementById('pull').onclick = () => pull(d.id, true);
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
    } else if (f.t === 'behavior') {
      const sel = Array.isArray(val) ? val : [];
      const groups = FORM.behaviors.map(g => {
        const count = g.items.filter(o => sel.includes(o)).length;
        return `<details class="behavior-group"${count ? ' open' : ''}><summary>${esc(g.title)}${count ? `（已選 ${count}）` : ''}</summary>
          <div class="behavior-choices">${g.items.map(o => `<button type="button" class="chip${sel.includes(o) ? ' on' : ''}" data-v="${esc(o)}">${esc(o)}</button>`).join('')}</div></details>`;
      }).join('');
      input = `<div class="behavior-picker" ${name}>${groups}</div>
        <div class="hint">依實際看到的動作勾選；不依單一動作自動判定壓力或「超過門檻」。沒有看見不等於沒有發生。</div>`;
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
    const body = (sec.note ? `<div class="hint">${esc(sec.note)}</div>` : '') + sec.fields.map(f => fieldHtml(f, rec.main[f.k], 'main', dog)).join('');
    if (!sec.fields.some(f => fieldHtml(f, rec.main[f.k], 'main', dog))) {
      // 現場模式下整節都是影片補：保留標題，節次才不會跳號
      return `<details class="sec"><summary>${esc(sec.title)}</summary><div class="hint">這一節看影片後補，切到上方「完整（含影片補）」填寫。</div></details>`;
    }
    if (sec.id === 'identity' && rec.main['訪視次序'] !== '第1次') {
      const filled = IDENTITY_KEYS.filter(k => !isEmpty(rec.main[k]));
      const note = filled.length ? '已沿用前次資料，身分有變動才需要修改。' : '找不到前次資料，可展開填寫。';
      return `<details class="sec"><summary>${esc(sec.title)}</summary><div class="hint">${note}</div>${body}</details>`;
    }
    const opened = ['basic','vehicle'].includes(sec.id) || (sec.id === 'identity' && rec.main['訪視次序'] === '第1次');
    return `<details class="sec"${opened ? ' open' : ''}><summary>${esc(sec.title)}</summary>${body}</details>`;
  }

  // 可重複的子表（陪伴活動、自然發生事件）
  function repeatInner(key, def, rec, dog, addLabel) {
    const rows = rec[key] || [];
    const blocks = rows.map((row, i) => `<div class="rep"><div class="rep-h"><b>第 ${i + 1} 筆</b><button type="button" class="link danger" data-del="${key}|${i}">刪除</button></div>
      ${def.fields.map(f => fieldHtml(f, row[f.k], `${key}|${i}`, dog)).join('')}</div>`).join('');
    return `${blocks}<button type="button" class="btn ghost block" data-add="${key}">＋ ${addLabel}</button>`;
  }

  // 某一個時機的行人經過（固定一趟，不能新增或刪除）
  function passInner(timing, rec, dog) {
    const i = (rec.passes || []).findIndex(p => p['經過時機'] === timing);
    if (i < 0) return '';
    const row = rec.passes[i];
    return FORM.passes.fields.filter(f => f.k !== '經過時機' && (!f.only || f.only.includes(timing)))
      .map(f => fieldHtml(f, row[f.k], `passes|${i}`, dog)).join('');
  }

  function blockHtml(L, rec, dog) {
    if (L.sec) return sectionHtml(secById(L.sec), rec, dog);
    const note = L.note ? `<div class="hint">${esc(L.note)}</div>` : '';
    if (L.activities) {
      return `<details class="sec"><summary>${esc(L.title)}</summary>${note}
        <div class="hint">本次若不適合提供活動，可不新增活動；由 A 記錄不提供的原因。</div>
        <h4 class="sub">${esc(FORM.activities.title)}</h4>${repeatInner('activities', FORM.activities, rec, dog, '新增活動')}</details>`;
    }
    if (L.pass) return `<details class="sec"><summary>${esc(L.title)}</summary>${note}${passInner(L.pass, rec, dog)}</details>`;
    if (L.events) {
      const head = FORM.events.head.map(f => fieldHtml(f, rec.main[f.k], 'main', dog)).join('');
      return `<details class="sec"><summary>${esc(FORM.events.title)}</summary><div class="hint">${esc(FORM.events.note)}</div>
        ${head}${repeatInner('events', FORM.events, rec, dog, '新增事件')}</details>`;
    }
    return '';
  }

  // 舊版資料保留原欄位：即使新畫面已不再顯示「陪伴中」測試與階梯分級，仍可查閱，不覆蓋原始紀錄。
  function legacyHtml(rec) {
    const known = new Set(FORM.sections.flatMap(s => s.fields.map(f => f.k)).concat(FORM.events.head.map(f => f.k)));
    const older = Object.entries(rec.main || {}).filter(([k,v]) => !known.has(k) && !isEmpty(v));
    const olderPass = (rec.passes || []).filter(p => !FORM.passes.timings.includes(p['經過時機']));
    const oldKeys = new Set(FORM.passes.fields.map(f => f.k));
    const extraPass = (rec.passes || []).filter(p => FORM.passes.timings.includes(p['經過時機']))
      .map(p => ({ timing:p['經過時機'], vals:Object.entries(p).filter(([k,v]) => !oldKeys.has(k) && !isEmpty(v)) }))
      .filter(x => x.vals.length);
    if (!older.length && !olderPass.length && !extraPass.length) return '';
    const view = (rows) => rows.map(([k,v]) => `<div class="legacy-row"><strong>${esc(k)}：</strong>${esc(Array.isArray(v) ? v.join('、') : typeof v === 'object' ? JSON.stringify(v) : v)}</div>`).join('');
    return `<details class="sec"><summary>舊版歷史欄位（僅供查閱，原始資料保留）</summary>
      <div class="hint">以下是舊版已存內容；新流程不再採用舊版行為階梯自動評分，也不再增加「陪伴中」行人測試。</div>
      ${view(older)}
      ${olderPass.map((p,i) => `<h4 class="sub">舊行人紀錄 ${i+1}（${esc(p['經過時機']||'')}）</h4>${view(Object.entries(p))}`).join('')}
      ${extraPass.map(x=>`<h4 class="sub">${esc(x.timing)}的舊欄位</h4>${view(x.vals)}`).join('')}
    </details>`;
  }

  function renderForm() {
    const recs = loadRecords();
    const rec = recs[state.recordId];
    if (!rec) return go({ view: 'home' });
    if (ensurePasses(rec)) { recs[rec.record_id] = rec; saveRecords(recs); }
    const dog = dogById(rec.dog_id) || { id: rec.dog_id, name: '', type: '' };
    const parts = FORM.layout.map(L => blockHtml(L, rec, dog)).join('') + legacyHtml(rec);
    $app.innerHTML = `<button class="back" id="back">‹ ${esc(dog.id)}｜${esc(dog.name)}</button>
      <div class="mode"><button class="seg${state.mode === 'live' ? ' on' : ''}" data-mode="live">現場快填</button><button class="seg${state.mode === 'all' ? ' on' : ''}" data-mode="all">完整（含影片補）</button></div>
      <form id="f" autocomplete="off">${parts}</form>
      <div class="bar"><button class="btn ghost" id="saveDraft">存草稿</button><button class="btn primary" id="submit">送出</button></div>`;
    document.getElementById('back').onclick = () => { persistForm(); go({ view: 'dog', dogId: rec.dog_id }); };
    $app.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { persistForm(); state.mode = b.dataset.mode; renderForm(); });
    bindForm();
    document.getElementById('saveDraft').onclick = () => { persistForm(); toast('已存在這支手機'); };
    document.getElementById('submit').onclick = () => submitRecord();
  }

  function setVal(rec, path, k, v) {
    if (path === 'main') rec.main[k] = v;
    else { const [key, i] = path.split('|'); if (rec[key] && rec[key][Number(i)]) rec[key][Number(i)][k] = v; }
  }

  function bindForm() {
    $app.querySelectorAll('.chips, .behavior-picker').forEach(box => {
      box.addEventListener('click', e => {
        const b = e.target.closest('.chip'); if (!b) return;
        const multi = box.dataset.t === 'multi' || box.dataset.t === 'behavior';
        if (multi) b.classList.toggle('on');
        else { const was = b.classList.contains('on'); box.querySelectorAll('.chip').forEach(c => c.classList.remove('on')); if (!was) b.classList.add('on'); }
        persistForm();
        if (box.dataset.k === '訪視次序') onVisitChanged();
      });
    });
    $app.querySelectorAll('input,textarea').forEach(el => el.addEventListener('change', () => {
      persistForm();
      if (el.dataset.k === '經過距離（公尺）' && el.value !== '') fillDistance(Number(el.value));
    }));
    $app.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
      persistForm(); const r = loadRecords(); const x = r[state.recordId];
      x[b.dataset.add] = x[b.dataset.add] || [];
      x[b.dataset.add].push({});
      x.updated_at = nowIso(); x.status = 'draft'; r[state.recordId] = x; saveRecords(r); renderForm();
    });
    $app.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
      if (!confirm('確定刪除這一筆？')) return;
      persistForm(); const [key, i] = b.dataset.del.split('|'); const r = loadRecords(); const x = r[state.recordId];
      x[key].splice(Number(i), 1); x.updated_at = nowIso(); x.status = 'draft'; saveRecords(r); renderForm();
    });
  }

  // 改成第 2 次以後且身分是空的，就補上前次資料；改成第 1 次則展開身分區塊
  function onVisitChanged() {
    const r = loadRecords(); const x = r[state.recordId]; if (!x) return;
    const visit = x.main['訪視次序'];
    if (visit !== '第1次') {
      const prev = lastRecordOf(x.dog_id, x.record_id);
      if (prev) IDENTITY_KEYS.forEach(k => { if (isEmpty(x.main[k]) && !isEmpty(prev.main[k])) x.main[k] = prev.main[k]; });
    }
    x.updated_at = nowIso(); x.status = 'draft'; saveRecords(r); renderForm();
  }

  // 填了其中一趟的經過距離，其他還沒填的趟次自動帶入相同距離
  function fillDistance(v) {
    const r = loadRecords(); const x = r[state.recordId]; if (!x) return;
    let changed = false;
    (x.passes || []).forEach(p => { if (isEmpty(p['經過距離（公尺）'])) { p['經過距離（公尺）'] = v; changed = true; } });
    if (!changed) return;
    x.updated_at = nowIso(); x.status = 'draft'; saveRecords(r);
    $app.querySelectorAll('input[data-k="經過距離（公尺）"]').forEach(i => { if (i.value === '') i.value = v; });
  }

  function persistForm() {
    const recs = loadRecords();
    const rec = recs[state.recordId]; if (!rec) return;
    const before = JSON.stringify([rec.main, rec.passes, rec.activities, rec.events]);
    $app.querySelectorAll('.chips, .behavior-picker').forEach(box => {
      const sel = [...box.querySelectorAll('.chip.on')].map(c => c.dataset.v);
      setVal(rec, box.dataset.path, box.dataset.k, box.dataset.t === 'select' ? (sel[0] || '') : sel);
    });
    $app.querySelectorAll('input[data-path],textarea[data-path]').forEach(el => {
      let v = el.value;
      if (el.dataset.t === 'number') v = v === '' ? '' : Number(v);
      setVal(rec, el.dataset.path, el.dataset.k, v);
    });
    if (before === JSON.stringify([rec.main, rec.passes, rec.activities, rec.events])) return;
    rec.updated_at = nowIso();
    rec.status = 'draft';
    recs[rec.record_id] = rec; saveRecords(recs); updateSyncBadge();
  }

  function validate(rec) {
    const miss = [];
    FORM.sections.forEach(s => s.fields.forEach(f => { if (f.req && isEmpty(rec.main[f.k])) miss.push(f.k); }));

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
    return {
      key, app_version: APP_VERSION, form_version: FORM.version, columns: COLUMNS,
      record: {
        record_id: rec.record_id, dog_id: rec.dog_id, dog_name: dog.name, created_at: rec.created_at, updated_at: rec.updated_at,
        main: rec.main, passes: rec.passes, activities: rec.activities, events: rec.events,
      },
    };
  }

  // 上傳仍沿用 POST；Google Apps Script 的 ContentService 會重新導向，
  // 跨網域 GET fetch 在部分手機瀏覽器會被 CORS 阻擋，因此雲端「讀取」改用 JSONP。
  async function callApi(url, opts) {
    const res = await fetch(url, Object.assign({ redirect: 'follow' }, opts || {}));
    const body = await res.text();
    try { return JSON.parse(body); }
    catch (e) { throw new Error(/<html/i.test(body) ? 'Apps Script 回傳網頁而非資料，請檢查部署存取權與版本' : '伺服器回應不是 JSON'); }
  }

  let jsonpSeq = 0;
  function cloudRead(url, params) {
    return new Promise((resolve, reject) => {
      let addr;
      try {
        addr = new URL(url);
        if (addr.protocol !== 'https:' || addr.hostname !== 'script.google.com' || !/\/macros\/s\/[^/]+\/exec$/.test(addr.pathname)) {
          throw new Error('請填入 https://script.google.com/macros/s/…/exec 的部署網址');
        }
      } catch (e) { reject(e); return; }
      const callback = '__mltCloudRead_' + Date.now() + '_' + (++jsonpSeq);
      Object.entries(params).forEach(([k,v]) => { if (v !== '' && v != null) addr.searchParams.set(k, v); });
      addr.searchParams.set('callback', callback);
      addr.searchParams.set('_', String(Date.now()));
      const tag = document.createElement('script');
      tag.async = true;
      tag.referrerPolicy = 'no-referrer';
      let done = false;
      let timer;
      const finish = (error, data) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        tag.remove();
        try { delete window[callback]; } catch (ignore) { window[callback] = undefined; }
        if (error) reject(error); else resolve(data);
      };
      window[callback] = data => finish(null, data);
      tag.onerror = () => finish(new Error('雲端讀取連線失敗；請確認 Apps Script 已更新部署，且網路允許連線'));
      tag.onload = () => { if (!done) finish(new Error('雲端尚未回傳新版讀取格式；請更新 Code.gs 並部署「新版本」')); }; 
      timer = setTimeout(() => finish(new Error('讀取逾時，請檢查網路或稍後重試')), 30000);
      tag.src = addr.toString();
      (document.head || document.body).appendChild(tag);
    });
  }
  const readCloud = (s, action, dogId) => cloudRead(s.url, { action, key: s.key, dog: dogId || '' });

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
        const data = await callApi(s.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payloadOf(rec, s.key)) });
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

  // 從雲端載入：dogId 為 null 時載入全部；手機上尚未上傳的較新紀錄不會被覆蓋
  async function pull(dogId, manual) {
    const s = loadSettings();
    if (!s.url || !s.key) { if (manual) toast('請先到「設定」填網址與存取金鑰'); return; }
    if (!navigator.onLine) { if (manual) toast('目前離線，請到有網路的地方再載入'); return; }
    try {
      const data = await readCloud(s, 'list', dogId);
      if (!data.ok) throw new Error(data.error || '讀取失敗');
      if (!Array.isArray(data.records)) throw new Error('雲端資料格式異常，找不到紀錄清單');
      const recs = loadRecords(); let added = 0, kept = 0;
      data.records.forEach(r => {
        if (!r || !r.record_id) return;
        const local = recs[r.record_id];
        if (local && (local.status !== 'synced' || (local.updated_at || '') > (r.updated_at || ''))) { kept++; return; }
        recs[r.record_id] = { record_id: r.record_id, dog_id: r.dog_id, created_at: r.created_at, updated_at: r.updated_at, status: 'synced',
          main: r.main || {}, passes: r.passes || [], activities: r.activities || [], events: r.events || [] };
        added++;
      });
      saveRecords(recs);
      if (manual) toast(`雲端查到 ${data.records.length} 筆，更新 ${added} 筆${kept ? `、保留手機未上傳或較新 ${kept} 筆` : ''}`);
      if (state.view === 'dog' || state.view === 'home') go({});
    } catch (e) { if (manual) toast('載入失敗：' + e.message); }
  }

  // ---------- 設定 ----------
  function renderSettings() {
    const s = loadSettings();
    $app.innerHTML = `<button class="back" id="back">‹ 返回</button><h2>設定</h2>
      <div class="field"><label class="flabel">Apps Script 網址</label><input id="sUrl" type="url" value="${esc(s.url || '')}" placeholder="https://script.google.com/macros/s/…/exec"></div>
      <div class="field"><label class="flabel">存取金鑰</label><input id="sKey" type="password" value="${esc(s.key || '')}"><div class="hint">與 Apps Script「指令碼屬性」ACCESS_KEY 相同</div></div>
      <button class="btn primary block" id="sSave">儲存</button>
      <button class="btn ghost block" id="sTest">測試連線</button>
      <h3>資料備份</h3><button class="btn ghost block" id="sExport">下載本機所有紀錄（JSON）</button><div class="hint">雲端讀取需同步更新 Apps Script 的 Code.gs 並部署新版本。下載備份可避免本機資料遺失。</div>`;
    document.getElementById('back').onclick = () => go({ view: 'home' });
    const read = () => ({ url: document.getElementById('sUrl').value.trim(), key: document.getElementById('sKey').value.trim() });
    document.getElementById('sSave').onclick = () => { saveSettings(read()); toast('已儲存'); };
    document.getElementById('sTest').onclick = async () => {
      const x = read(); saveSettings(x);
      try { const d = await readCloud(x, 'list'); if (!d.ok) throw new Error(d.error || '雲端拒絕讀取'); if (!Array.isArray(d.records)) throw new Error('讀取回應格式異常'); toast('雲端讀取成功，共 ' + d.records.length + ' 筆紀錄'); }
      catch (e) { toast('連線失敗：' + e.message); }
    };
    document.getElementById('sExport').onclick = () => {
      const blob = new Blob([JSON.stringify(loadRecords(), null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `苗栗田調_備份_${today()}.json`; a.click();
    };
  }

  // ---------- 路由 ----------
  function go(next) {
    const prevView = state.view, prevDog = state.dogId;
    state = Object.assign(state, next);
    if (next && next.view) window.scrollTo(0, 0);
    if (state.view === 'home') renderHome();
    else if (state.view === 'dog') renderDog();
    else if (state.view === 'form') renderForm();
    else if (state.view === 'settings') renderSettings();
    updateSyncBadge();
    // 進入某隻狗的頁面時，自動在背景從雲端載入
    if (next && next.view === 'dog' && (prevView !== 'dog' || prevDog !== state.dogId)) pull(state.dogId, false);
  }

  window.addEventListener('online', () => syncAll(false));
  window.addEventListener('offline', updateSyncBadge);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncAll(false); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  go({ view: 'home' });
  syncAll(false);
})();
