import loadArgon2id from './argon2id-inline.js';

/* ---- crypto helpers ---- */

const argon2Ready = loadArgon2id();
const te = new TextEncoder();
const td = new TextDecoder();
const FIXED_SALT = te.encode('vault-v1');

async function deriveKey(passphrase) {
  const argon2id = await argon2Ready;
  const raw = argon2id({
    password: te.encode(passphrase),
    salt: FIXED_SALT,
    parallelism: 1,
    passes: 3,
    memorySize: 2 ** 16,
    hashLength: 32,
  });
  return crypto.subtle.importKey(
    'raw', raw,
    { name: 'AES-GCM' },
    false, ['encrypt', 'decrypt']
  );
}

async function encrypt(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, plaintext
  );
  return {
    iv: btoa(String.fromCharCode(...iv)),
    data: btoa(String.fromCharCode(...new Uint8Array(ct)))
  };
}

async function decrypt(key, ivB64, dataB64) {
  try {
    const iv = Uint8Array.from(
      atob(ivB64), c => c.charCodeAt(0));
    const ct = Uint8Array.from(
      atob(dataB64), c => c.charCodeAt(0));
    return await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, key, ct);
  } catch { return null; }
}


/* ---- DOM helper ---- */

function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on'))
        e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (typeof c === 'string') e.append(c);
    else if (c) e.append(c);
  }
  return e;
}


/* ---- app state ---- */

const allUpdates = [];

let currentPassphrase = null;
let currentKey = null;
let maxVersion = 0;
let currentContent = '';
let currentFiles = [];

function markDirty() {
  const badge = document.getElementById('edit-badge');
  const lockBtn = document.getElementById('lock-btn');
  if (badge) badge.style.display = '';
  if (lockBtn) lockBtn.classList.add('lock-dirty');
}


/* ---- entry screen ---- */

function renderEntry() {
  const app = document.getElementById('app');
  app.replaceChildren();

  const input = el('input', {
    id: 'number-input', class: 'input',
    type: 'text',
    placeholder: 'Enter passphrase'
  });
  input.onkeydown = e => {
    if (e.key === 'Enter') unlock();
  };

  const btn = el('button', {
    id: 'unlock-btn', class: 'btn',
    onclick: unlock
  }, 'Unlock Vault');

  const status = el('div', {
    id: 'unlock-status', class: 'hint'
  });

  app.append(
    el('div', { class: 'entry' },
      el('img', { class: 'icon', src: 'icon.jpg' }),
      el('h1', null, 'Vault'),
      input, btn, status
    )
  );

  input.focus();
}


/* ---- unlock / lock ---- */

async function unlock() {
  const input = document.getElementById('number-input');
  const btn = document.getElementById('unlock-btn');
  const status = document.getElementById('unlock-status');
  const passphrase = input.value.trimEnd();
  if (!passphrase) return;

  input.disabled = true;
  btn.disabled = true;
  btn.textContent = 'Unlocking\u2026';
  status.textContent = 'Deriving key, please wait\u2026';

  await new Promise(r => setTimeout(r, 50));

  currentPassphrase = passphrase;
  currentKey = await deriveKey(passphrase);
  maxVersion = 0;

  // Try decrypting every update. Successful ones
  // belong to this vault.
  for (const p of allUpdates) {
    await decryptAndCache(p);
  }
  resolveVault();
  renderVault();
}

async function decryptAndCache(p) {
  if (p._inner !== undefined) return p._inner;
  const buf = await decrypt(currentKey, p.iv, p.data);
  if (!buf) { p._inner = null; return null; }
  try {
    p._inner = JSON.parse(td.decode(buf));
    return p._inner;
  } catch { p._inner = null; return null; }
}

// Clears cached decryption results so a different
// passphrase can be tried next time.
function clearCache() {
  for (const p of allUpdates) delete p._inner;
}

async function lock() {
  await saveVault();
  currentPassphrase = null;
  currentKey = null;
  currentContent = '';
  currentFiles = [];
  maxVersion = 0;
  clearCache();
  renderEntry();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && currentKey) {
    saveVault();
  }
});


/* ---- vault screen ---- */

function renderVault() {
  const app = document.getElementById('app');
  app.replaceChildren();

  const numDiv = el('div', { class: 'number' });
  numDiv.textContent = currentPassphrase;

  const lockBtn = el('button', {
    id: 'lock-btn',
    class: 'lock-btn', onclick: lock
  }, 'Lock');

  const editBadge = el('span', {
    id: 'edit-badge', class: 'edit-badge'
  }, 'editing');
  editBadge.style.display = 'none';

  const header = el('div', { class: 'vault-header' },
    el('div', null,
      el('div', { class: 'label' }, 'Vault'),
      numDiv
    ),
    el('div', { class: 'vault-actions' },
      editBadge, lockBtn
    )
  );

  const ta = el('textarea', {
    id: 'ta', placeholder: 'Write anything...'
  });
  ta.value = currentContent;

  const fileInput = el('input', {
    type: 'file', id: 'file-input',
    style: 'display:none'
  });
  const attachLabel = el('label', {
    class: 'attach-btn'
  }, '+ Attach', fileInput);

  const fileListDiv = el('div', { id: 'file-list' });

  const fileSection = el('div', {
    class: 'file-section'
  },
    el('div', { class: 'file-header' },
      el('span', null,
        'Attachments (max 200 KB each)'),
      attachLabel
    ),
    fileListDiv
  );

  const hint = el('div', { class: 'hint' },
    'Changes are saved when you lock the vault');

  app.append(header, ta, fileSection, hint);

  ta.focus();
  ta.selectionStart = ta.selectionEnd = ta.value.length;

  ta.oninput = () => {
    currentContent = ta.value;
    markDirty();
  };

  fileInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 200 * 1024) {
      alert('Max file size is 200 KB');
      return;
    }
    const buf = await file.arrayBuffer();
    const b64 = btoa(String.fromCharCode(
      ...new Uint8Array(buf)));
    currentFiles.push({ name: file.name, data: b64 });
    markDirty();
    renderFileList();
    e.target.value = '';
  };

  renderFileList();
}

function renderFileList() {
  const container = document.getElementById('file-list');
  if (!container) return;
  container.replaceChildren();
  currentFiles.forEach((f, i) => {
    const item = document.createElement('div');
    item.className = 'file-item';

    const info = document.createElement('div');
    info.className = 'file-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'file-name';
    nameEl.textContent = f.name;
    info.append(nameEl);

    const actions = document.createElement('div');
    actions.className = 'file-actions';
    const dlBtn = document.createElement('button');
    dlBtn.className = 'dl';
    dlBtn.textContent = '\u2193';
    dlBtn.onclick = () => {
      const raw = Uint8Array.from(
        atob(f.data), c => c.charCodeAt(0));
      const blob = new Blob([raw]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = f.name; a.click();
      URL.revokeObjectURL(url);
    };
    const delBtn = document.createElement('button');
    delBtn.className = 'del';
    delBtn.textContent = '\u00d7';
    delBtn.onclick = () => {
      currentFiles.splice(i, 1);
      markDirty();
      renderFileList();
    };
    actions.append(dlBtn, delBtn);

    item.append(info, actions);
    container.appendChild(item);
  });
}


/* ---- save & sync ---- */

async function saveVault() {
  if (!currentKey) return;

  const inner = {
    version: ++maxVersion,
    tiebreak: Math.random().toString(36),
    text: currentContent,
    files: currentFiles,
  };
  const enc = await encrypt(
    currentKey,
    te.encode(JSON.stringify(inner))
  );

  const payload = { iv: enc.iv, data: enc.data };

  allUpdates.push(payload);
  payload._inner = inner;

  window.webxdc.sendUpdate({ payload }, '');
}


/* ---- webxdc update listener ---- */

async function applyUpdate(update) {
  const p = update.payload;
  if (!p || !p.iv || !p.data) return;

  allUpdates.push(p);

  if (!currentKey) return;

  const inner = await decryptAndCache(p);
  if (!inner) return;

  if (inner.version > maxVersion) {
    maxVersion = inner.version;
  }

  resolveVaultAsync();
}

async function resolveVaultAsync() {
  let best = null;
  for (const p of allUpdates) {
    const inner = await decryptAndCache(p);
    if (!inner) continue;
    if (inner.version > maxVersion) {
      maxVersion = inner.version;
    }
    if (!best
        || inner.version > best.version
        || (inner.version === best.version
            && inner.tiebreak > best.tiebreak)) {
      best = inner;
    }
  }
  if (!best) return;
  currentContent = best.text || '';
  currentFiles = best.files || [];
  const ta = document.getElementById('ta');
  if (ta && ta.value !== currentContent) {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.value = currentContent;
    ta.selectionStart = start;
    ta.selectionEnd = end;
  }
  renderFileList();
}


/* ---- boot ---- */

function resolveVault() {
  let best = null;
  for (const p of allUpdates) {
    const inner = p._inner;
    if (!inner) continue;
    if (inner.version > maxVersion) {
      maxVersion = inner.version;
    }
    if (!best
        || inner.version > best.version
        || (inner.version === best.version
            && inner.tiebreak > best.tiebreak)) {
      best = inner;
    }
  }
  currentContent = best?.text || '';
  currentFiles = best?.files || [];
}

window.webxdc.setUpdateListener(applyUpdate, 0);
renderEntry();
