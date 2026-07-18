// Thin UI layer: translates DOM/webxdc/postMessage events into
// calls on the core classes (src/core.js) and back. Contains no
// mechanics of its own; the core is tested without mocks in
// tests/vault.test.js.

import {
  Vault, RealtimeBridge, maxPlaintextSize,
  deriveKey, decryptEnvelope,
} from './src/core.js';
import { unzipToMap } from './src/unzip.js';
import { buildBootHtml } from './src/bundle.js';
import bundleSource from './src/bundle.js?raw';
import shimSource from './src/webxdc-shim.js?raw';
import { zipEntries } from './src/zip.js';

// size budget for one encrypted outer update, derived from
// what the webxdc runtime advertises
const PLAINTEXT_BUDGET =
  maxPlaintextSize(window.webxdc.sendUpdateMaxSize);

const vault = new Vault({ maxAppSize: PLAINTEXT_BUDGET });
let iframe = null;
let running = false;
let outerChannel = null;
let rtBridge = null;

vault.onSendUpdate = (payload, descr) => {
  window.webxdc.sendUpdate({ payload }, descr);
};

vault.onAppChanged = () => {
  if (vault.key && !running) runApp();
};

// load preloaded updates before listening to the outer chat
async function loadPreloaded() {
  try {
    const res = await fetch('preloaded.json');
    if (!res.ok) return;
    const payloads = await res.json();
    if (Array.isArray(payloads)) {
      await vault.preload(payloads);
    }
  } catch {
    // no preloaded data -- normal startup
  }
}

// load preloaded updates first, then start listening to
// the outer chat; chained instead of top-level await to
// stay compatible with the es2020/safari14 build target
loadPreloaded().then(() => {
  window.webxdc.setUpdateListener(
    (u) => vault.applyUpdate(u), 0);
});


/* ---- tiny DOM helper ---- */

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

function screen(...children) {
  const app = document.getElementById('app');
  app.replaceChildren(...children.filter(Boolean));
  return app;
}


/* ---- entry screen ---- */

function renderEntry() {
  const input = el('input', {
    id: 'pass-input', class: 'input',
    type: 'text',
    autocapitalize: 'off', autocorrect: 'off',
    spellcheck: 'false',
    placeholder: 'Enter passphrase',
  });
  input.onkeydown = e => {
    if (e.key === 'Enter') doUnlock();
  };
  const btn = el('button', {
    id: 'unlock-btn', class: 'btn', onclick: doUnlock,
  }, 'Unlock Vault');
  const status = el('div', {
    id: 'unlock-status', class: 'hint',
  });

  const shareLink = el('div', { class: 'hint' },
    el('a', {
      href: '#', onclick: (e) => {
        e.preventDefault(); renderShareScreen();
      },
    }, 'Share vault with contents\u2026'),
  );

  screen(
    el('div', { class: 'entry' },
      el('img', { class: 'icon', src: 'icon.jpg' }),
      el('h1', null, 'Vault'),
      input, btn, status, shareLink,
    )
  );
  input.focus();
}

async function doUnlock() {
  const input = document.getElementById('pass-input');
  const btn = document.getElementById('unlock-btn');
  const status = document.getElementById('unlock-status');
  const passphrase = input.value.trim();
  if (!passphrase) return;

  input.disabled = true;
  btn.disabled = true;
  btn.textContent = 'Unlocking\u2026';
  status.textContent = 'Deriving key, please wait\u2026';
  await new Promise(r => setTimeout(r, 50));

  await vault.unlock(passphrase);
  if (vault.appDefinition) runApp();
  else renderUpload();
}

function doLock() {
  teardownApp();
  vault.lock();
  renderEntry();
}


/* ---- upload screen (no app bound to this passphrase) ---- */

function fmtSize(bytes) {
  return bytes >= 1024 * 1024
    ? (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    : Math.floor(bytes / 1024) + ' KB';
}

function renderUpload(waiting) {
  const fileInput = el('input', {
    type: 'file', accept: '.xdc',
    style: 'display:none',
  });
  fileInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!/\.xdc$/i.test(file.name)) {
      alert('app must have a .xdc extension');
      return;
    }
    if (file.size > vault.maxAppSize) {
      alert(`app is too large (max ${fmtSize(vault.maxAppSize)})`);
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    await vault.uploadApp(bytes, file.name);
    // the app starts when our own update echoes back
    // through the outer update listener (onAppChanged)
    renderUpload(true);
  };

  screen(
    header(),
    el('div', { class: 'entry' },
      el('h1', null, waiting
        ? 'Encrypting & sending app\u2026'
        : 'No app installed'),
      el('div', { class: 'hint' }, waiting
        ? 'Waiting for the app update to arrive.'
        : `Choose a .xdc file (max ${fmtSize(vault.maxAppSize)}) `
          + 'to bind to this passphrase. This choice is permanent.'),
      waiting ? null : el('button', {
        class: 'btn',
        onclick: () => fileInput.click(),
      }, 'Select .xdc app'),
      fileInput,
    )
  );
}


/* ---- run screen (guest app in iframe) ---- */

function header() {
  return el('div', { class: 'vault-header' },
    el('div', null,
      el('div', { class: 'label' }, 'Vault'),
      el('div', { class: 'number' }, vault.passphrase),
    ),
    el('button', {
      class: 'lock-btn', onclick: doLock,
    }, 'Lock'),
  );
}

async function runApp() {
  if (running) return;
  running = true;
  try {
    const files = await unzipToMap(vault.appDefinition.bytes);
    const html = buildBootHtml({
      files,
      shimSource,
      info: {
        selfAddr: window.webxdc.selfAddr,
        selfName: window.webxdc.selfName,
        hasRealtime: typeof window.webxdc.joinRealtimeChannel
          === 'function',
        hasImportFiles: typeof window.webxdc.importFiles
          === 'function',
        hasSendToChat: typeof window.webxdc.sendToChat
          === 'function',
        // room updates are wrapped in one encrypted
        // envelope, so pass the derived budget down
        sendUpdateMaxSize: PLAINTEXT_BUDGET,
      },
      bundleSource,
    });
    renderFrame(html);
  } catch (err) {
    running = false;
    console.error(err);
    screen(
      header(),
      el('div', { class: 'entry' },
        el('h1', null, 'Failed to start app'),
        el('div', { class: 'hint' }, String(err)),
      )
    );
  }
}

function renderFrame(html) {
  // no allow-same-origin: the guest runs in an opaque origin
  // and cannot reach this document, the Vault, or the key;
  // it can only speak the postMessage bridge protocol. Its
  // blob: URLs are created inside the sandbox and die with
  // the iframe document, so nothing needs revoking here.
  iframe = el('iframe', {
    id: 'guest-frame',
    sandbox: 'allow-scripts allow-forms allow-modals',
  });
  iframe.srcdoc = html;
  screen(header(), iframe);
}

function teardownApp() {
  running = false;
  iframe = null;
  if (outerChannel) outerChannel.leave();
  outerChannel = null;
  rtBridge = null;
}


/* ---- bridge: guest iframe <-> core classes ---- */

function ensureRealtime() {
  if (rtBridge) return;
  outerChannel = window.webxdc.joinRealtimeChannel();
  rtBridge = new RealtimeBridge(vault.key);
  rtBridge.onSend = (bytes) => outerChannel.send(bytes);
  outerChannel.setListener(
    (bytes) => rtBridge.handleIncoming(bytes));
}

window.addEventListener('message', (ev) => {
  if (!iframe || ev.source !== iframe.contentWindow) return;
  const msg = ev.data;
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'vault-setUpdateListener') {
    const target = iframe.contentWindow;
    vault.setRoomUpdateListener(msg.serial, (update) => {
      target.postMessage(
        { type: 'vault-update', update }, '*');
    });
    target.postMessage({ type: 'vault-replay-done' }, '*');
  } else if (msg.type === 'vault-sendUpdate') {
    vault.sendRoomUpdate(msg.update);
  } else if (msg.type === 'vault-realtime-join') {
    ensureRealtime();
    const target = iframe.contentWindow;
    rtBridge.setGuestListener((bytes) => {
      target.postMessage(
        { type: 'vault-realtime-data', data: bytes }, '*');
    });
  } else if (msg.type === 'vault-realtime-send') {
    if (rtBridge) {
      rtBridge.sendFromGuest(new Uint8Array(msg.data));
    }
  } else if (msg.type === 'vault-realtime-leave') {
    if (rtBridge) rtBridge.leaveGuest();
  } else if (msg.type === 'vault-importFiles') {
    const target = iframe.contentWindow;
    window.webxdc.importFiles(msg.filter).then((files) => {
      target.postMessage(
        { type: 'vault-importFiles-result', files }, '*');
    });
  } else if (msg.type === 'vault-sendToChat') {
    const target = iframe.contentWindow;
    Promise.resolve(window.webxdc.sendToChat(msg.content))
      .then(() => target.postMessage(
        { type: 'vault-sendToChat-result', ok: true }, '*'))
      .catch((err) => target.postMessage(
        { type: 'vault-sendToChat-result', ok: false,
          error: String(err) }, '*'));
  } else if (msg.type === 'vault-guest-error') {
    showGuestError(String(msg.error));
  }
});

// surface guest errors outside the iframe (its devtools
// console can be hard to reach on mobile)
function showGuestError(text) {
  console.error('[vault guest]', text);
  let banner = document.getElementById('guest-error');
  if (!banner) {
    banner = el('div', { id: 'guest-error' });
    document.getElementById('app').append(banner);
  }
  banner.append(el('div', null, text));
}


/* ---- share collection screen ---- */

function renderShareScreen() {
  // each verified room: { pass, appName, appSize, updates }
  // updates is the array of raw { serial, payload } entries
  const rooms = [];
  const roomList = el('div', { class: 'room-list' });
  const status = el('div', { class: 'share-status' });
  const generateBtn = el('button', {
    class: 'btn', disabled: 'disabled',
    onclick: () => doGenerate(rooms, status, generateBtn),
  }, 'Share');

  function refreshRoomList() {
    roomList.replaceChildren(
      ...rooms.map((r, i) => el('div', { class: 'room-item' },
        el('div', { class: 'room-info' },
          el('div', { class: 'room-app' }, r.pass),
          el('div', { class: 'room-meta' },
            `${r.appName} \u00b7 ${fmtSize(r.appSize)}`
            + ` \u00b7 ${r.updates.length} update(s)`),
        ),
        el('button', {
          class: 'room-remove',
          onclick: () => { rooms.splice(i, 1); refreshRoomList(); },
        }, '\u00d7'),
      ))
    );
    if (rooms.length > 0) generateBtn.removeAttribute('disabled');
    else generateBtn.setAttribute('disabled', 'disabled');
  }

  const input = el('input', {
    class: 'input', type: 'text',
    autocapitalize: 'off', autocorrect: 'off',
    spellcheck: 'false',
    placeholder: 'Enter passphrase',
  });
  const addBtn = el('button', {
    class: 'btn', onclick: () => tryAdd(),
  }, 'Add');

  async function tryAdd() {
    const pass = input.value.trim();
    if (!pass) return;
    if (rooms.some(r => r.pass === pass)) {
      setStatus('Already added.', 'err');
      return;
    }
    input.disabled = true;
    addBtn.disabled = true;
    addBtn.textContent = 'Checking\u2026';
    setStatus('Deriving key, please wait\u2026', 'info');
    // let the greyed-out state paint before argon2
    // blocks the main thread
    await new Promise(r => setTimeout(r, 50));

    let key;
    try {
      key = await deriveKey(pass);
    } catch (err) {
      setStatus(`Key derivation failed: ${err}`, 'err');
      input.disabled = false;
      addBtn.disabled = false;
      addBtn.textContent = 'Add';
      return;
    }

    setStatus('Scanning updates\u2026', 'info');
    let appName = null;
    let appSize = 0;
    const matching = [];
    for (const u of vault.updates) {
      const env = await decryptEnvelope(key, u.payload);
      if (!env) continue;
      matching.push(u);
      if (env.header.type === 'app_definition') {
        appName = env.header.filename || 'app.xdc';
        appSize = env.body.length;
      }
    }

    input.disabled = false;
    addBtn.disabled = false;
    addBtn.textContent = 'Add';

    if (!appName) {
      setStatus('No app found for this passphrase.', 'err');
      input.select();
      return;
    }

    rooms.push({
      pass, appName, appSize, updates: matching,
    });
    input.value = '';
    setStatus('');
    refreshRoomList();
    input.focus();
  }

  function setStatus(text, cls) {
    status.textContent = text;
    status.className = 'share-status' + (cls ? ' ' + cls : '');
  }

  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); tryAdd(); }
  };

  screen(
    el('div', { class: 'share-card' },
      el('h2', null, 'Share Vault with contents'),
      el('div', { class: 'share-row' }, input, addBtn),
      status,
      roomList,
      el('div', { class: 'share-actions' },
        el('button', {
          class: 'btn-secondary', onclick: renderEntry,
        }, 'Cancel'),
        generateBtn,
      ),
    )
  );
  input.focus();
}

async function doGenerate(rooms, status, btn) {
  btn.setAttribute('disabled', 'disabled');

  const collected = [];
  for (const r of rooms) {
    collected.push(...r.updates);
  }

  const preloaded = collected.map(u => u.payload);

  status.textContent = `Packaging ${preloaded.length} update(s)\u2026`;
  status.className = 'share-status info';

  try {
    const xdcBytes = await buildCollectionXdc(preloaded);
    status.textContent =
      `Collection ready (${fmtSize(xdcBytes.length)})`;
    status.className = 'share-status ok';
    await window.webxdc.sendToChat({
      file: {
        name: 'vault-collection.xdc',
        blob: new Blob([xdcBytes]),
      },
      text: 'Vault collection',
    });
  } catch (err) {
    status.textContent = `Error: ${err}`;
    status.className = 'share-status err';
  }
  btn.removeAttribute('disabled');
}

// fetch the running app's own files and repackage them
// with a preloaded.json into a new .xdc
async function buildCollectionXdc(preloaded) {
  const te = new TextEncoder();
  const entries = [];

  const htmlRes = await fetch('index.html');
  const htmlText = await htmlRes.text();

  // the built HTML references a bundled JS file in assets/;
  // in dev mode Vite serves unbundled source modules that
  // cannot work inside a standalone .xdc archive
  if (!htmlText.includes('/assets/')) {
    throw new Error(
      'sharing requires a production build (pnpm build)');
  }

  entries.push({ name: 'index.html', data: te.encode(htmlText) });

  // discover JS/CSS assets referenced by the HTML
  const assetRefs = [];
  htmlText.replace(
    /(?:src|href)\s*=\s*["']([^"']+)["']/gi,
    (_m, ref) => {
      if (!ref.startsWith('http') && !ref.startsWith('data:')
          && !ref.startsWith('#') && ref !== 'webxdc.js') {
        assetRefs.push(ref);
      }
    });
  for (const ref of assetRefs) {
    try {
      const res = await fetch(ref);
      if (res.ok) {
        entries.push({
          name: ref.replace(/^\.?\//, ''),
          data: new Uint8Array(await res.arrayBuffer()),
        });
      }
    } catch { /* skip unreachable refs */ }
  }

  // icon from the original app
  try {
    const res = await fetch('icon.jpg');
    if (res.ok) {
      entries.push({
        name: 'icon.jpg',
        data: new Uint8Array(await res.arrayBuffer()),
      });
    }
  } catch { /* optional */ }

  // build a manifest that keeps the source link from the original
  let sourceUrl = '';
  try {
    const mf = await (await fetch('manifest.toml')).text();
    const m = mf.match(/source_code_url\s*=\s*"([^"]+)"/);
    if (m) sourceUrl = `\nsource_code_url = "${m[1]}"`;
  } catch { /* optional */ }

  entries.push({
    name: 'manifest.toml',
    data: te.encode(`name = "Vault Collection"${sourceUrl}\n`),
  });

  entries.push({
    name: 'preloaded.json',
    data: te.encode(JSON.stringify(preloaded)),
  });

  return zipEntries(entries);
}


renderEntry();
