// ── Config ──────────────────────────────────────────────
const CLIENT_ID = '874728563260-lllh2p9or21nci4dikkabl0el89b99ql.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'Progresso Emagrecimento';
const INDEX_FILE  = 'progresso_index.json';

// ── State ────────────────────────────────────────────────
let tokenClient  = null;
let accessToken  = null;
let tokenExpiry  = null;
let folderId     = null;
let entries      = [];
let selectedPhoto = null;
let currentEntryId = null;  // id do registro aberto no lightbox

// ── Auth ─────────────────────────────────────────────────
function initGoogle() {
  if (!window.google) { setTimeout(initGoogle, 300); return; }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: async (resp) => {
      if (resp.error) {
        // prompt:'none' falhou (sem sessão ativa), pede login normal
        if (resp.error === 'interaction_required' || resp.error === 'login_required') {
          tokenClient.requestAccessToken({ prompt: 'select_account' });
          return;
        }
        setStatus('Erro de autenticação', 'err');
        return;
      }
      accessToken = resp.access_token;
      tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
      localStorage.setItem('progresso_authed', '1');
      localStorage.setItem('progresso_expiry', tokenExpiry.toString());
      await onSignedIn();
    }
  });

  if (localStorage.getItem('progresso_authed')) {
    setHeaderSub('reconectando…');
    // Tenta sem popup primeiro; callback trata o erro se necessário
    tokenClient.requestAccessToken({ prompt: 'none' });
  }
}

async function onSignedIn() {
  document.getElementById('auth-btn').textContent = 'Sair';
  document.getElementById('auth-btn').classList.add('signed-in');
  setHeaderSub('carregando dados…');
  await ensureFolder();
  await loadIndex();
  enableSave();
  renderGallery();
  renderProgress();
  scheduleTokenRefresh();
}

function scheduleTokenRefresh() {
  const msUntilExpiry = tokenExpiry - Date.now();
  if (msUntilExpiry <= 0) return;
  setTimeout(() => {
    tokenClient.requestAccessToken({ prompt: '' });
  }, msUntilExpiry);
}

function handleAuth() {
  if (accessToken) { signOut(); return; }
  tokenClient.requestAccessToken({ prompt: 'consent' });
}

function signOut() {
  google.accounts.oauth2.revoke(accessToken, () => {
    accessToken = null; tokenExpiry = null; folderId = null; entries = [];
    localStorage.removeItem('progresso_authed');
    localStorage.removeItem('progresso_expiry');
    document.getElementById('auth-btn').textContent = 'Entrar com Google';
    document.getElementById('auth-btn').classList.remove('signed-in');
    setHeaderSub('faça login para começar');
    document.getElementById('save-btn').disabled = true;
    renderGallery(); renderProgress();
  });
}

window.addEventListener('load', initGoogle);

// ── Fetch image as base64 ─────────────────────────────────
async function fetchImageBase64(fileId) {
  if (imgCache[fileId]) return imgCache[fileId];
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  if (!res.ok) return null;
  const blob = await res.blob();
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      imgCache[fileId] = reader.result;
      resolve(reader.result);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

// Inject base64 into all img tags with data-fileid
async function hydrateImages(container) {
  const imgs = container.querySelectorAll('img[data-fileid]');
  await Promise.all([...imgs].map(async (img) => {
    const fileId = img.dataset.fileid;
    const src = await fetchImageBase64(fileId);
    if (src) img.src = src;
    else img.style.display = 'none';
  }));
}

// ── Drive helpers ─────────────────────────────────────────
async function driveReq(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: 'Bearer ' + accessToken, ...(opts.headers || {}) }
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function ensureFolder() {
  const q = `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await driveReq(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`);
  if (res.files.length) { folderId = res.files[0].id; return; }
  const f = await driveReq('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
  });
  folderId = f.id;
}

async function loadIndex() {
  const q = `name='${INDEX_FILE}' and '${folderId}' in parents and trashed=false`;
  const res = await driveReq(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`);
  if (!res.files.length) { entries = []; setHeaderSub('0 registros'); return; }
  const indexId = res.files[0].id;
  const data = await fetch(`https://www.googleapis.com/drive/v3/files/${indexId}?alt=media`, {
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  entries = await data.json();
  setHeaderSub(`${entries.length} registro${entries.length !== 1 ? 's' : ''}`);
}

async function saveIndex() {
  const q = `name='${INDEX_FILE}' and '${folderId}' in parents and trashed=false`;
  const res = await driveReq(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`);
  const blob = new Blob([JSON.stringify(entries)], { type: 'application/json' });

  if (res.files.length) {
    const id = res.files[0].id;
    await fetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: blob
    });
  } else {
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ name: INDEX_FILE, parents: [folderId] })], { type: 'application/json' }));
    form.append('file', blob);
    await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken },
      body: form
    });
  }
}

async function uploadPhoto(file, filename) {
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ name: filename, parents: [folderId] })], { type: 'application/json' }));
  form.append('file', file);
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken },
    body: form
  });
  const data = await res.json();
  return data.id;
}

// ── Save entry ────────────────────────────────────────────
async function saveEntry() {
  if (!accessToken) { setStatus('Faça login primeiro', 'err'); return; }

  const date   = document.getElementById('input-date').value;
  const weight = parseFloat(document.getElementById('input-weight').value);
  const note   = document.getElementById('input-note').value.trim();

  if (!date)   { setStatus('Informe a data', 'err'); return; }
  if (!weight) { setStatus('Informe o peso', 'err'); return; }

  showLoading('Fazendo upload da foto…');

  try {
    let fileId = null;
    if (selectedPhoto) {
      const filename = `progresso_${date}_${Date.now()}.jpg`;
      fileId = await uploadPhoto(selectedPhoto, filename);
      // Pre-cache the photo we just selected (already in memory)
      const reader = new FileReader();
      reader.onload = (e) => { if (fileId) imgCache[fileId] = e.target.result; };
      reader.readAsDataURL(selectedPhoto);
    }

    const entry = { id: Date.now(), date, weight, note, fileId };
    entries.unshift(entry);
    setLoading('Salvando índice…');
    await saveIndex();

    setHeaderSub(`${entries.length} registro${entries.length !== 1 ? 's' : ''}`);
    resetForm();
    renderGallery();
    renderProgress();
    setStatus('Salvo com sucesso! ✓', 'ok');
  } catch (e) {
    entries.shift();
    setStatus('Erro: ' + e.message, 'err');
    console.error(e);
  } finally {
    hideLoading();
  }
}

// ── Gallery ───────────────────────────────────────────────
async function renderGallery() {
  const el = document.getElementById('gallery-content');
  if (!entries.length) {
    el.innerHTML = `<div class="gallery-empty"><div class="big">📷</div><p style="margin-top:12px">Nenhum registro ainda</p></div>`;
    return;
  }

  const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date));
  const cards = sorted.map(e => {
    const imgHtml = e.fileId
      ? `<img data-fileid="${e.fileId}" src="" alt="foto" style="width:100%;aspect-ratio:3/4;object-fit:cover;display:block;background:var(--surface2);" />`
      : `<div style="aspect-ratio:3/4;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:32px;">📷</div>`;
    return `
      <div class="gallery-card" onclick='openLightbox(${JSON.stringify(e)})'>
        ${imgHtml}
        <div class="card-info">
          <div class="card-date">${formatDate(e.date)}</div>
          <div class="card-weight">${e.weight} <span>kg</span></div>
        </div>
      </div>`;
  }).join('');

  el.innerHTML = `<div class="gallery-grid">${cards}</div>`;
  await hydrateImages(el);
}

// ── Lightbox ──────────────────────────────────────────────
async function openLightbox(entry) {
  currentEntryId = entry.id;
  document.getElementById('lightbox').classList.add('open');
  const img = document.getElementById('lb-img');

  if (entry.fileId) {
    img.src = '';
    img.style.display = 'block';
    showLoading('Carregando foto…');
    const src = await fetchImageBase64(entry.fileId);
    hideLoading();
    if (src) img.src = src;
    else img.style.display = 'none';
  } else {
    img.style.display = 'none';
  }

  document.getElementById('lb-date').textContent = formatDate(entry.date);
  document.getElementById('lb-weight').textContent = entry.weight + ' kg';
  document.getElementById('lb-note').textContent = entry.note || '';
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
  currentEntryId = null;
}

async function deleteEntry() {
  if (!currentEntryId) return;
  if (!confirm('Apagar este registro? A foto também será removida do Drive.')) return;

  const idx = entries.findIndex(e => e.id === currentEntryId);
  if (idx === -1) return;
  const entry = entries[idx];

  showLoading('Apagando…');
  try {
    // Apaga a foto do Drive se existir
    if (entry.fileId) {
      await fetch(`https://www.googleapis.com/drive/v3/files/${entry.fileId}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + accessToken }
      });
      delete imgCache[entry.fileId];
    }

    entries.splice(idx, 1);
    await saveIndex();
    setHeaderSub(`${entries.length} registro${entries.length !== 1 ? 's' : ''}`);
    closeLightbox();
    renderGallery();
    renderProgress();
  } catch (e) {
    setStatus('Erro ao apagar: ' + e.message, 'err');
    console.error(e);
  } finally {
    hideLoading();
  }
}

document.getElementById('lightbox').addEventListener('click', function(e) {
  if (e.target === this) closeLightbox();
});

// ── Progress ──────────────────────────────────────────────
async function renderProgress() {
  const el = document.getElementById('progress-content');
  if (entries.length < 2) {
    el.innerHTML = `<div class="gallery-empty"><div class="big">📈</div><p style="margin-top:12px">Registre pelo menos 2 pesos para ver a evolução</p></div>`;
    return;
  }

  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  const first  = sorted[0];
  const last   = sorted[sorted.length - 1];
  const diff   = (last.weight - first.weight).toFixed(1);
  const diffNum = parseFloat(diff);
  const diffClass = diffNum < 0 ? 'positive' : (diffNum > 0 ? 'negative' : '');
  const diffSign  = diffNum > 0 ? '+' : '';

  const timeline = [...sorted].reverse().map((e, i, arr) => {
    const prev = arr[i + 1];
    let diffHtml = '';
    if (prev) {
      const d = (e.weight - prev.weight).toFixed(1);
      const dn = parseFloat(d);
      const cl = dn < 0 ? 'pos' : (dn > 0 ? 'neg' : '');
      const sign = dn > 0 ? '+' : '';
      diffHtml = `<div class="tl-diff ${cl}">${sign}${d} kg</div>`;
    }
    const imgHtml = e.fileId
      ? `<img data-fileid="${e.fileId}" src="" alt="" style="width:44px;height:44px;border-radius:8px;object-fit:cover;flex-shrink:0;background:var(--surface2);" />`
      : `<div style="width:44px;height:44px;border-radius:8px;background:var(--surface2);display:flex;align-items:center;justify-content:center;flex-shrink:0;">📷</div>`;
    return `
      <div class="timeline-item">
        ${imgHtml}
        <div class="tl-info">
          <div class="tl-date">${formatDate(e.date)}</div>
          <div class="tl-weight">${e.weight} kg</div>
          ${e.note ? `<div class="tl-note">${e.note}</div>` : ''}
        </div>
        ${diffHtml}
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="stat-row">
      <div class="stat-card">
        <div class="stat-label">Início</div>
        <div class="stat-value">${first.weight} <span style="font-size:16px;font-family:'DM Sans',sans-serif">kg</span></div>
        <div class="stat-sub">${formatDate(first.date)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Atual</div>
        <div class="stat-value">${last.weight} <span style="font-size:16px;font-family:'DM Sans',sans-serif">kg</span></div>
        <div class="stat-sub">${formatDate(last.date)}</div>
      </div>
    </div>
    <div class="stat-row">
      <div class="stat-card">
        <div class="stat-label">Total perdido</div>
        <div class="stat-value ${diffClass}">${diffSign}${diff} kg</div>
        <div class="stat-sub">${entries.length} registros</div>
      </div>
    </div>
    <div class="section-title" style="margin-top:8px">Histórico</div>
    <div class="timeline">${timeline}</div>
  `;
  await hydrateImages(el);
}

// ── Photo handling ────────────────────────────────────────
function handlePhoto(input) {
  if (!input.files || !input.files[0]) return;
  selectedPhoto = input.files[0];
  const reader = new FileReader();
  reader.onload = (e) => {
    const zone = document.getElementById('upload-zone');
    zone.classList.add('has-image');
    let img = zone.querySelector('img.preview');
    if (!img) { img = document.createElement('img'); img.className = 'preview'; zone.appendChild(img); }
    img.src = e.target.result;
  };
  reader.readAsDataURL(selectedPhoto);
}

// ── UI helpers ────────────────────────────────────────────
function showPage(name, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  btn.classList.add('active');
  if (name === 'gallery') renderGallery();
  if (name === 'progress') renderProgress();
}

function enableSave() {
  document.getElementById('save-btn').disabled = false;
}

function setStatus(msg, type = '') {
  const el = document.getElementById('status-msg');
  el.textContent = msg;
  el.className = type;
  if (type === 'ok') setTimeout(() => { el.textContent = ''; el.className = ''; }, 4000);
}

function setHeaderSub(text) {
  document.getElementById('header-sub').textContent = text;
}

function showLoading(msg = 'Aguarde…') {
  document.getElementById('loading-msg').textContent = msg;
  document.getElementById('loading').classList.add('show');
}

function setLoading(msg) {
  document.getElementById('loading-msg').textContent = msg;
}

function hideLoading() {
  document.getElementById('loading').classList.remove('show');
}

function resetForm() {
  selectedPhoto = null;
  document.getElementById('photo-input').value = '';
  document.getElementById('input-weight').value = '';
  document.getElementById('input-note').value = '';
  const zone = document.getElementById('upload-zone');
  zone.classList.remove('has-image');
  const img = zone.querySelector('img.preview');
  if (img) img.remove();
}

function formatDate(str) {
  if (!str) return '';
  const [y, m, d] = str.split('-');
  const months = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  return `${d} ${months[parseInt(m) - 1]} ${y}`;
}

document.getElementById('input-date').value = new Date().toISOString().split('T')[0];

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
