// Thin UI layer: translates DOM/webxdc/postMessage events into
// calls on the core classes (src/core.js) and back. Contains no
// mechanics of its own; the core is tested without mocks in
// tests/vault.test.js.

import { Vault, RealtimeBridge, maxPlaintextSize }
  from './src/core.js';
import { unzipToMap } from './src/unzip.js';
import { buildGuestHtml } from './src/bundle.js';
import shimSource from './src/webxdc-shim.js?raw';

// size budget for one encrypted outer update, derived from
// what the webxdc runtime advertises
const PLAINTEXT_BUDGET =
  maxPlaintextSize(window.webxdc.sendUpdateMaxSize);

const vault = new Vault({ maxAppSize: PLAINTEXT_BUDGET });
let iframe = null;
let running = false;
let guestUrls = [];
let outerChannel = null;
let rtBridge = null;

vault.onSendUpdate = (payload, descr) => {
  window.webxdc.sendUpdate({ payload }, descr);
};

vault.onAppChanged = () => {
  if (vault.key && !running) runApp();
};

window.webxdc.setUpdateListener(
  (u) => vault.applyUpdate(u), 0);


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

  screen(
    el('div', { class: 'entry' },
      el('img', { class: 'icon', src: 'icon.jpg' }),
      el('h1', null, 'Vault'),
      input, btn, status,
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
    const { html, urls } = buildGuestHtml({
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
        // guest updates are wrapped in one encrypted
        // envelope, so pass the derived budget down
        sendUpdateMaxSize: PLAINTEXT_BUDGET,
      },
      createUrl: (bytes, type) =>
        URL.createObjectURL(new Blob([bytes], { type })),
    });
    guestUrls = urls;
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
  // the guest runs same-origin (no sandbox attribute): it is
  // trusted like the vault itself and can in principle reach
  // this document. Isolation from the outside world comes
  // from the webxdc runtime, not from the vault.
  iframe = el('iframe', { id: 'guest-frame' });
  iframe.srcdoc = html;
  screen(header(), iframe);
}

function teardownApp() {
  running = false;
  iframe = null;
  for (const u of guestUrls) URL.revokeObjectURL(u);
  guestUrls = [];
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
    vault.setInnerUpdateListener(msg.serial, (update) => {
      target.postMessage(
        { type: 'vault-update', update }, '*');
    });
    target.postMessage({ type: 'vault-replay-done' }, '*');
  } else if (msg.type === 'vault-sendUpdate') {
    vault.sendSubAppUpdate(msg.update);
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

renderEntry();
