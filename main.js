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
    passes: 20,
    memorySize: 2 ** 16,
    tagLength: 32,
  });
  if (raw.length === 0) {
    throw new Error(
      'argon2id produced 0-byte key -- check parameter names'
    );
  }
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
  } catch {
    return null;
  }
}


/* ---- Vault state container ---- */

export class Vault {
  constructor() {
    this.updates = [];
    this.passphrase = null;
    this.key = null;
    this.maxVersion = 0;
    this.content = '';
    this.files = [];
    this.onSendUpdate = null;
    this.onStateChanged = null;
  }

  async unlock(passphrase) {
    this.passphrase = passphrase;
    this.key = await deriveKey(passphrase);
    this.maxVersion = 0;
    await this._resolve();
  }

  async lock() {
    await this.save(this.content, this.files);
    this.passphrase = null;
    this.key = null;
    this.content = '';
    this.files = [];
    this.maxVersion = 0;
  }

  async save(text, files) {
    if (!this.key) return;
    this.content = text;
    this.files = files;

    const inner = {
      version: ++this.maxVersion,
      tiebreak: Math.random().toString(36),
      text: this.content,
      files: this.files,
    };
    const enc = await encrypt(
      this.key,
      te.encode(JSON.stringify(inner))
    );
    const payload = { iv: enc.iv, data: enc.data };
    this.updates.push(payload);

    if (this.onSendUpdate) {
      this.onSendUpdate(payload);
    }
  }

  async applyUpdate(update) {
    const p = update.payload;
    if (!p || !p.iv || !p.data) return;

    this.updates.push(p);
    if (!this.key) return;

    await this._resolve();
    if (this.onStateChanged) this.onStateChanged();
  }

  async _tryDecrypt(p) {
    if (!this.key) return null;
    const buf = await decrypt(this.key, p.iv, p.data);
    if (!buf) return null;
    try {
      return JSON.parse(td.decode(buf));
    } catch { return null; }
  }

  async _resolve() {
    let best = null;
    for (const p of this.updates) {
      const inner = await this._tryDecrypt(p);
      if (!inner) continue;
      if (inner.version > this.maxVersion) {
        this.maxVersion = inner.version;
      }
      if (!best
          || inner.version > best.version
          || (inner.version === best.version
              && inner.tiebreak > best.tiebreak)) {
        best = inner;
      }
    }
    this.content = best?.text || '';
    this.files = best?.files || [];
  }
}


/* ---- browser UI (only runs in DOM environment) ---- */

if (typeof window !== 'undefined'
    && typeof document !== 'undefined') {
  const vault = new Vault();

  vault.onSendUpdate = (payload) => {
    window.webxdc.sendUpdate({ payload }, '');
  };

  vault.onStateChanged = () => {
    const ta = document.getElementById('ta');
    if (ta && ta.value !== vault.content) {
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      ta.value = vault.content;
      ta.selectionStart = start;
      ta.selectionEnd = end;
    }
    renderFileList();
  };

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

  function markDirty() {
    const badge = document.getElementById('edit-badge');
    const lockBtn = document.getElementById('lock-btn');
    if (badge) badge.style.display = '';
    if (lockBtn) lockBtn.classList.add('lock-dirty');
  }

  function renderEntry() {
    const app = document.getElementById('app');
    app.replaceChildren();

    const input = el('input', {
      id: 'number-input', class: 'input',
      type: 'text',
      placeholder: 'Enter passphrase'
    });
    input.onkeydown = e => {
      if (e.key === 'Enter') doUnlock();
    };

    const btn = el('button', {
      id: 'unlock-btn', class: 'btn',
      onclick: doUnlock
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

  async function doUnlock() {
    const input = document.getElementById('number-input');
    const btn = document.getElementById('unlock-btn');
    const status =
      document.getElementById('unlock-status');
    const passphrase = input.value.trim();
    if (!passphrase) return;

    input.disabled = true;
    btn.disabled = true;
    btn.textContent = 'Unlocking\u2026';
    status.textContent = 'Deriving key, please wait\u2026';
    await new Promise(r => setTimeout(r, 50));

    await vault.unlock(passphrase);
    renderVault();
  }

  async function doLock() {
    await vault.lock();
    renderEntry();
  }

  function renderVault() {
    const app = document.getElementById('app');
    app.replaceChildren();

    const numDiv = el('div', { class: 'number' });
    numDiv.textContent = vault.passphrase;

    const lockBtn = el('button', {
      id: 'lock-btn',
      class: 'lock-btn', onclick: doLock
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
    ta.value = vault.content;

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
    ta.selectionStart = ta.selectionEnd =
      ta.value.length;

    ta.oninput = () => {
      vault.content = ta.value;
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
      vault.files.push({ name: file.name, data: b64 });
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
    vault.files.forEach((f, i) => {
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
        vault.files.splice(i, 1);
        markDirty();
        renderFileList();
      };
      actions.append(dlBtn, delBtn);

      item.append(info, actions);
      container.appendChild(item);
    });
  }

  window.webxdc.setUpdateListener(
    (u) => vault.applyUpdate(u), 0);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && vault.key) {
      vault.save(vault.content, vault.files);
    }
  });
  renderEntry();
}
