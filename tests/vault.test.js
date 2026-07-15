import test from 'node:test';
import assert from 'node:assert';
import {
  Vault, RealtimeBridge, deriveKey, MAX_APP_SIZE,
  maxPlaintextSize, packEnvelope, unpackEnvelope,
} from '../src/core.js';

/* No mocks: peers are real Vault/RealtimeBridge instances
   wired together by piping output callbacks into input
   methods -- an in-memory chat / realtime channel. */

// in-memory webxdc chat: assigns outer serials and echoes
// every update to all members (including the sender, as the
// real webxdc API does)
function connectChat(...vaults) {
  let serial = 0;
  const chat = { sent: [], deliveries: [] };
  for (const v of vaults) {
    v.onSendUpdate = (payload, descr) => {
      chat.sent.push({ payload, descr });
      const s = ++serial;
      for (const w of vaults) {
        chat.deliveries.push(
          w.applyUpdate({ serial: s, payload }));
      }
    };
  }
  chat.settle = () => Promise.all(chat.deliveries);
  return chat;
}

// in-memory realtime channel: broadcasts to all other
// bridges (the real channel does not echo to the sender)
function connectChannel(...bridges) {
  const channel = { wire: [], deliveries: [] };
  for (const b of bridges) {
    b.onSend = (bytes) => {
      channel.wire.push(bytes);
      for (const o of bridges) {
        if (o !== b) {
          channel.deliveries.push(o.handleIncoming(bytes));
        }
      }
    };
  }
  channel.settle = () => Promise.all(channel.deliveries);
  return channel;
}

// capture the encrypted payloads a vault emits without
// delivering them anywhere (for out-of-order scenarios)
function capturePayloads(vault) {
  const payloads = [];
  vault.onSendUpdate = (payload) => payloads.push(payload);
  return payloads;
}

const te = new TextEncoder();


/* ---- passphrase isolation ---- */

test('updates from wrong passphrase are ignored', async () => {
  const a = new Vault();
  const b = new Vault();
  const chat = connectChat(a, b);
  await a.unlock('pass-A');
  await b.unlock('pass-B');

  const received = [];
  b.setInnerUpdateListener(0, u => received.push(u));
  const zipA = te.encode('zip-A');
  const zipB = te.encode('zip-B');
  await a.uploadApp(zipA, 'a.xdc');
  await b.uploadApp(zipB, 'b.xdc');
  await a.sendRoomUpdate({ payload: 'private to A' });
  await chat.settle();

  assert.deepStrictEqual(a.appDefinition.bytes, zipA,
    'vault A must run its own app');
  assert.deepStrictEqual(b.appDefinition.bytes, zipB,
    'foreign app definition must not clobber B\'s app');
  assert.strictEqual(b.roomUpdates.length, 0,
    'wrong-key vault must not decrypt room updates');
  assert.strictEqual(received.length, 0,
    'wrong-key inner listener must never fire');
});


/* ---- app definition lifecycle ---- */

test('fresh passphrase has no app', async () => {
  const v = new Vault();
  await v.unlock('fresh');
  assert.strictEqual(v.appDefinition, null,
    'fresh vault must have no app definition');
});

test('uploaded app round-trips', async () => {
  const a = new Vault();
  const b = new Vault();
  const chat = connectChat(a, b);
  await a.unlock('shared');
  await b.unlock('shared');

  const zip = crypto.getRandomValues(new Uint8Array(5000));
  await a.uploadApp(zip, 'game.xdc');
  await chat.settle();

  assert.deepStrictEqual(b.appDefinition.bytes, zip,
    'peer must receive byte-identical app');
  assert.strictEqual(b.appDefinition.filename, 'game.xdc');
  assert.deepStrictEqual(a.appDefinition.bytes, zip,
    'uploader must see its own app via echo');
});

test('lowest outer serial wins on competing definitions',
  async () => {
    const sender = new Vault();
    await sender.unlock('race');
    const payloads = capturePayloads(sender);
    await sender.uploadApp(te.encode('first'), 'first.xdc');
    await sender.uploadApp(te.encode('second'), 'second.xdc');

    const v = new Vault();
    await v.unlock('race');
    // "second" arrives first but has the higher serial
    await v.applyUpdate({ serial: 5, payload: payloads[1] });
    assert.strictEqual(v.appDefinition.filename, 'second.xdc');
    await v.applyUpdate({ serial: 3, payload: payloads[0] });
    assert.strictEqual(v.appDefinition.filename, 'first.xdc',
      'definition with lowest outer serial must win');
    assert.strictEqual(v.appDefinition.serial, 3);
  });

test('app definition is permanent', async () => {
  const sender = new Vault();
  await sender.unlock('perm');
  const payloads = capturePayloads(sender);
  await sender.uploadApp(te.encode('first'), 'first.xdc');
  await sender.uploadApp(te.encode('later'), 'later.xdc');

  const v = new Vault();
  await v.unlock('perm');
  await v.applyUpdate({ serial: 2, payload: payloads[0] });
  await v.applyUpdate({ serial: 7, payload: payloads[1] });
  assert.strictEqual(v.appDefinition.filename, 'first.xdc',
    'later definition must never replace an earlier one');
});

test('oversized app is rejected', async () => {
  const v = new Vault({ maxAppSize: 1000 });
  const chat = connectChat(v);
  await v.unlock('big');
  const zip = new Uint8Array(1001);
  await assert.rejects(() => v.uploadApp(zip, 'big.xdc'),
    /limit/, 'oversized upload must throw');
  assert.strictEqual(chat.sent.length, 0,
    'nothing must be sent for a rejected upload');
});

test('app size limit derives from the outer budget', () => {
  // an app at the computed limit must produce an outer
  // payload that fits into the advertised update size:
  // envelope + GCM tag + base64 + JSON framing < budget
  const budget = 100 * 1024;
  const limit = maxPlaintextSize(budget);
  const envelope = packEnvelope(
    { type: 'app_definition', filename: 'a.xdc' },
    new Uint8Array(limit));
  const ivB64 = 16, tag = 16, jsonFraming = 64;
  const outer = Math.ceil((envelope.length + tag) / 3) * 4
    + ivB64 + jsonFraming;
  assert.ok(outer <= budget,
    `outer payload ${outer} must fit budget ${budget}`);
  assert.ok(limit > budget / 2,
    'limit must not be needlessly conservative');
  // absent or bogus runtime limits fall back to the default
  assert.strictEqual(maxPlaintextSize(undefined),
    MAX_APP_SIZE);
  assert.strictEqual(maxPlaintextSize(0), MAX_APP_SIZE);
});

test('envelope round-trips header and binary body', () => {
  const body = new Uint8Array([0, 255, 1, 128, 66]);
  const packed = packEnvelope(
    { type: 'app_definition', filename: 'x.xdc' }, body);
  const { header, body: out } = unpackEnvelope(packed);
  assert.deepStrictEqual(header,
    { type: 'app_definition', filename: 'x.xdc' });
  assert.deepStrictEqual(new Uint8Array(out), body);
  assert.strictEqual(unpackEnvelope(new Uint8Array(2)), null);
});


/* ---- room update flow ---- */

test('room updates round-trip', async () => {
  const a = new Vault();
  const b = new Vault();
  const chat = connectChat(a, b);
  await a.unlock('shared');
  await b.unlock('shared');

  const received = [];
  b.setInnerUpdateListener(0, u => received.push(u));
  await a.sendRoomUpdate(
    { payload: { move: 'e4' }, info: 'white moved' });
  await chat.settle();

  assert.strictEqual(received.length, 1);
  assert.deepStrictEqual(received[0].payload, { move: 'e4' },
    'guest payload must round-trip unchanged');
  assert.strictEqual(received[0].info, 'white moved');
  assert.strictEqual(received[0].serial, 1);
  assert.strictEqual(received[0].max_serial, 1);
});

test('updates are forwarded in outer serial order',
  async () => {
    const sender = new Vault();
    await sender.unlock('order');
    const payloads = capturePayloads(sender);
    for (const n of [1, 2, 3]) {
      await sender.sendRoomUpdate({ payload: n });
    }

    const v = new Vault();
    await v.unlock('order');
    // out-of-order arrival: serials 3, 1, 2
    await v.applyUpdate({ serial: 3, payload: payloads[2] });
    await v.applyUpdate({ serial: 1, payload: payloads[0] });
    await v.applyUpdate({ serial: 2, payload: payloads[1] });

    const received = [];
    v.setInnerUpdateListener(0, u => received.push(u));
    assert.deepStrictEqual(
      received.map(u => u.serial), [1, 2, 3],
      'replay must be ordered by outer serial');
    assert.deepStrictEqual(
      received.map(u => u.payload), [1, 2, 3]);
  });

test('setUpdateListener replays only after given serial',
  async () => {
    const a = new Vault();
    const b = new Vault();
    const chat = connectChat(a, b);
    await a.unlock('resume');
    await b.unlock('resume');
    for (const n of [1, 2, 3, 4, 5]) {
      await a.sendRoomUpdate({ payload: n });
    }
    await chat.settle();

    const received = [];
    b.setInnerUpdateListener(2, u => received.push(u));
    assert.deepStrictEqual(
      received.map(u => u.serial), [3, 4, 5],
      'only updates with serial > 2 must be replayed');
  });


/* ---- metadata hygiene ---- */

test('outer updates always use empty descr and expose only '
    + 'ciphertext', async () => {
  const v = new Vault();
  const chat = connectChat(v);
  await v.unlock('hygiene');
  await v.uploadApp(te.encode('zip'), 'secret-name.xdc');
  await v.sendRoomUpdate({ payload: 'x', info: 'moved' });
  await chat.settle();

  assert.strictEqual(chat.sent.length, 2);
  for (const { payload, descr } of chat.sent) {
    assert.strictEqual(descr, '',
      'descr must always be empty');
    assert.deepStrictEqual(
      Object.keys(payload).sort(), ['data', 'iv'],
      'payload must contain only iv and data');
  }
  const wire = JSON.stringify(chat.sent);
  assert.ok(!wire.includes('secret-name'),
    'filename must not appear on the wire');
  assert.ok(!wire.includes('moved'),
    'info must not appear on the wire');
});


/* ---- realtime forwarding ---- */

test('realtime data round-trips between same-passphrase '
    + 'peers', async () => {
  const key = await deriveKey('rt-shared');
  const a = new RealtimeBridge(key);
  const b = new RealtimeBridge(key);
  const channel = connectChannel(a, b);

  const received = [];
  b.setGuestListener(bytes => received.push(bytes));
  const data = te.encode('hello realtime');
  await a.sendFromGuest(data);
  await channel.settle();

  assert.strictEqual(received.length, 1);
  assert.deepStrictEqual(received[0], data,
    'same-key peer must receive identical bytes');
});

test('realtime data from other passphrase rooms is dropped',
  async () => {
    const a = new RealtimeBridge(await deriveKey('room-A'));
    const b = new RealtimeBridge(await deriveKey('room-B'));
    const channel = connectChannel(a, b);

    const received = [];
    b.setGuestListener(bytes => received.push(bytes));
    await a.sendFromGuest(te.encode('only for room A'));
    await channel.settle();

    assert.strictEqual(received.length, 0,
      'other-room data must be silently dropped');
  });

test('realtime payloads on the wire are ciphertext',
  async () => {
    const key = await deriveKey('rt-wire');
    const a = new RealtimeBridge(key);
    const channel = connectChannel(a);

    const plain = te.encode('plaintext marker');
    await a.sendFromGuest(plain);

    assert.strictEqual(channel.wire.length, 1);
    const framed = channel.wire[0];
    // 12-byte IV + ciphertext + 16-byte GCM tag
    assert.strictEqual(framed.length, plain.length + 12 + 16);
    assert.ok(!containsSubarray(framed, plain),
      'plaintext must not appear on the wire');
  });

test('leave detaches the guest listener', async () => {
  const key = await deriveKey('rt-leave');
  const a = new RealtimeBridge(key);
  const b = new RealtimeBridge(key);
  const channel = connectChannel(a, b);

  const received = [];
  b.setGuestListener(bytes => received.push(bytes));
  b.leaveGuest();
  await a.sendFromGuest(te.encode('after leave'));
  await channel.settle();

  assert.strictEqual(received.length, 0,
    'no data must be forwarded after leave');
});

function containsSubarray(haystack, needle) {
  outer:
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}
