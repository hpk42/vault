import loadArgon2id from '../argon2id-inline.js';


/* ---- crypto helpers ---- */

const argon2Ready = loadArgon2id();
const te = new TextEncoder();
const td = new TextDecoder();
const FIXED_SALT = te.encode('vault-v1');
const IV_BYTES = 12;

// fallback when the runtime doesn't advertise a limit
export const MAX_APP_SIZE = 1024 * 1024;

// largest plaintext (app archive or room update) that still
// fits into one outer update of the given size budget: the
// encrypted envelope travels as base64 { iv, data } JSON
// (4/3 inflation), plus AES-GCM tag, IV, and framing --
// covered by 1 KB of slack
export function maxPlaintextSize(sendUpdateMaxSize) {
  if (!Number.isFinite(sendUpdateMaxSize)
      || sendUpdateMaxSize <= 2048) return MAX_APP_SIZE;
  return Math.floor((sendUpdateMaxSize - 1024) * 3 / 4);
}

export async function deriveKey(passphrase) {
  const argon2id = await argon2Ready;
  const raw = argon2id({
    password: te.encode(passphrase.normalize('NFC')),
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

// chunked base64 (spread-based conversion overflows the call
// stack for payloads in the 1 MB range)
export function b64encode(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(
      null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export function b64decode(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

// binary framing: iv (12 bytes) || ciphertext
export async function encryptBytes(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, plaintext
  );
  const out = new Uint8Array(IV_BYTES + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), IV_BYTES);
  return out;
}

// returns null when authentication fails (wrong key/room)
export async function decryptBytes(key, framed) {
  try {
    const iv = framed.subarray(0, IV_BYTES);
    const ct = framed.subarray(IV_BYTES);
    const buf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, key, ct);
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

// binary envelope: avoids base64-encoding binary bodies
// (the zip) *inside* the encrypted JSON, which would inflate
// payloads twice. Layout:
//   4-byte big-endian header length || header JSON || body
export function packEnvelope(header, body = new Uint8Array()) {
  const h = te.encode(JSON.stringify(header));
  const out = new Uint8Array(4 + h.length + body.length);
  new DataView(out.buffer).setUint32(0, h.length);
  out.set(h, 4);
  out.set(body, 4 + h.length);
  return out;
}

// returns { header, body } or null on malformed input
export function unpackEnvelope(bytes) {
  try {
    const hlen = new DataView(
      bytes.buffer, bytes.byteOffset, bytes.byteLength
    ).getUint32(0);
    const header = JSON.parse(
      td.decode(bytes.subarray(4, 4 + hlen)));
    return { header, body: bytes.subarray(4 + hlen) };
  } catch {
    return null;
  }
}

// encrypted envelope as outer-update payload { iv, data }
export async function encryptEnvelope(key, header, body) {
  const framed = await encryptBytes(
    key, packEnvelope(header, body));
  return {
    iv: b64encode(framed.subarray(0, IV_BYTES)),
    data: b64encode(framed.subarray(IV_BYTES)),
  };
}

// returns { header, body } or null (bad payload / wrong key)
export async function decryptEnvelope(key, payload) {
  if (!payload || !payload.iv || !payload.data) return null;
  let framed;
  try {
    const iv = b64decode(payload.iv);
    const data = b64decode(payload.data);
    framed = new Uint8Array(iv.length + data.length);
    framed.set(iv, 0);
    framed.set(data, iv.length);
  } catch {
    return null;
  }
  const buf = await decryptBytes(key, framed);
  if (!buf) return null;
  return unpackEnvelope(buf);
}


/* ---- Vault: encrypted webxdc app host ----

   Pure core class. All I/O goes through plain data:
   inputs  : applyUpdate(), unlock(), uploadApp(),
             sendRoomUpdate(), setRoomUpdateListener()
   outputs : onSendUpdate(payload, descr) and onAppChanged()
             callbacks.
   It never touches webxdc, DOM or iframes,
   so tests wire real instances together without mocks.     */

export class Vault {
  constructor({ maxAppSize: limit = MAX_APP_SIZE } = {}) {
    this.maxAppSize = limit;
    this.updates = [];        // raw outer { serial, payload }
    this._serialOffset = 0;   // count of preloaded updates
    this.passphrase = null;
    this.key = null;
    this.appDefinition = null; // { serial, filename, bytes }
    this.roomUpdates = [];      // { serial, update }, sorted
    this.onSendUpdate = null;  // (payload, descr) => {}
    this.onAppChanged = null;  // () => {}
    this._roomListener = null; // { fn, lastSerial }
    this._queue = Promise.resolve();
  }

  async unlock(passphrase) {
    this.passphrase = passphrase;
    this.key = await deriveKey(passphrase);
    const updates = this.updates.slice();
    for (const u of updates) {
      await this._integrate(u);
    }
  }

  lock() {
    this.passphrase = null;
    this.key = null;
    this.appDefinition = null;
    this.roomUpdates = [];
    this._roomListener = null;
  }

  // feed every outer webxdc update (own echoes included) here;
  // processing is serialized to preserve arrival order
  applyUpdate(update) {
    if (!update) return Promise.resolve();
    return this._apply({
      serial: update.serial + this._serialOffset,
      payload: update.payload,
    });
  }

  // payloads baked into a shared collection archive occupy
  // serials 1..N; applyUpdate() shifts live chat serials by
  // N so they sort after the preloaded history and new
  // updates keep working
  preload(payloads) {
    let last = Promise.resolve();
    for (const payload of payloads) {
      last = this._apply(
        { serial: ++this._serialOffset, payload });
    }
    return last;
  }

  _apply(u) {
    const p = u.payload;
    if (!p || !p.iv || !p.data) return Promise.resolve();
    this.updates.push(u);
    this._queue = this._queue.then(() => {
      if (this.key) return this._integrate(u);
    });
    return this._queue;
  }

  async uploadApp(bytes, filename) {
    if (!this.key) throw new Error('vault is locked');
    if (bytes.length > this.maxAppSize) {
      throw new Error(
        `app exceeds ${this.maxAppSize} bytes limit`);
    }
    const payload = await encryptEnvelope(this.key, {
      type: 'app_definition',
      filename: filename ?? 'app.xdc',
    }, bytes);
    this._send(payload);
  }

  async sendRoomUpdate(update) {
    if (!this.key) throw new Error('vault is locked');
    const payload = await encryptEnvelope(this.key, {
      type: 'room_update',
      update,
    });
    this._send(payload);
  }

  // fn receives room updates ordered by outer serial, with
  // update.serial / update.max_serial set to outer serials;
  // only updates with serial > sinceSerial are delivered
  setRoomUpdateListener(sinceSerial, fn) {
    if (!fn) {
      this._roomListener = null;
      return;
    }
    this._roomListener = { fn, lastSerial: sinceSerial };
    this._forward();
  }

  _send(payload) {
    if (this.onSendUpdate) this.onSendUpdate(payload, '');
  }

  async _integrate({ serial, payload }) {
    const env = await decryptEnvelope(this.key, payload);
    if (!env || !env.header) return;
    const { header, body } = env;
    if (header.type === 'app_definition') {
      // the definition with the lowest outer serial wins,
      // permanently: later definitions never replace it
      if (!this.appDefinition
          || serial < this.appDefinition.serial) {
        this.appDefinition = {
          serial,
          filename: header.filename,
          bytes: body.slice(),
        };
        if (this.onAppChanged) this.onAppChanged();
      }
    } else if (header.type === 'room_update'
        && header.update) {
      insertSorted(this.roomUpdates,
        { serial, update: header.update });
      this._forward();
    }
  }

  _forward() {
    const l = this._roomListener;
    if (!l || this.roomUpdates.length === 0) return;
    const maxSerial =
      this.roomUpdates[this.roomUpdates.length - 1].serial;
    for (const ru of this.roomUpdates) {
      if (ru.serial <= l.lastSerial) continue;
      l.lastSerial = ru.serial;
      l.fn(Object.assign({}, ru.update, {
        serial: ru.serial,
        max_serial: maxSerial,
      }));
    }
  }
}

function insertSorted(arr, item) {
  let i = arr.length;
  while (i > 0 && arr[i - 1].serial > item.serial) i--;
  arr.splice(i, 0, item);
}


/* ---- RealtimeBridge ----

   Forwards the guest's realtime channel over the outer
   (chat-wide, passphrase-agnostic) realtime channel. Room
   isolation comes from encryption: data that fails GCM
   authentication (other passphrase rooms) is dropped.

   inputs  : sendFromGuest(), handleIncoming(),
             setGuestListener(), leaveGuest()
   output  : onSend(bytes) callback (wired to the real
             outer channel's send by the UI layer).        */

export class RealtimeBridge {
  constructor(key) {
    this.key = key;
    this.onSend = null;       // (Uint8Array) => {}
    this._listener = null;
  }

  setGuestListener(fn) {
    this._listener = fn;
  }

  leaveGuest() {
    this._listener = null;
  }

  async sendFromGuest(bytes) {
    const framed = await encryptBytes(this.key, bytes);
    if (this.onSend) this.onSend(framed);
  }

  async handleIncoming(bytes) {
    const plain = await decryptBytes(this.key, bytes);
    if (plain === null) return; // other room: drop silently
    if (this._listener) this._listener(plain);
  }
}
