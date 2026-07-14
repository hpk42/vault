import test from 'node:test';
import assert from 'node:assert';
import { Vault } from '../main.js';

test('different passphrases produce different vaults', async () => {
  const v = new Vault();

  await v.unlock('pass-A');
  await v.save('data-A', []);
  await v.lock();

  await v.unlock('pass-B');
  await v.save('data-B', []);
  await v.lock();

  // Unlock A -- must see data-A, not data-B
  await v.unlock('pass-A');
  assert.strictEqual(v.content, 'data-A',
    'vault A must show its own content');
  await v.lock();

  // Unlock B -- must see data-B, not data-A
  await v.unlock('pass-B');
  assert.strictEqual(v.content, 'data-B',
    'vault B must show its own content');
});

test('single-character passphrases work', async () => {
  const v = new Vault();

  await v.unlock('x');
  await v.save('tiny passphrase', []);
  await v.lock();

  await v.unlock('x');
  assert.strictEqual(v.content, 'tiny passphrase',
    'single-char passphrase must round-trip');
});

test('empty vault shows empty content', async () => {
  const v = new Vault();

  await v.unlock('fresh');
  assert.strictEqual(v.content, '',
    'fresh vault must be empty');
});

test('lock saves pending edits', async () => {
  const v = new Vault();

  await v.unlock('abc');
  // Simulate the user typing by setting content
  // directly, then locking (which triggers save).
  v.content = 'typed by user';
  await v.lock();

  await v.unlock('abc');
  assert.strictEqual(v.content, 'typed by user',
    'edits pending at lock time must be saved');
});

test('applyUpdate from other peer is decrypted', async () => {
  // Simulate two peers sharing the same passphrase
  const sender = new Vault();
  const receiver = new Vault();

  await sender.unlock('shared');
  await receiver.unlock('shared');

  // Capture the payload that sender emits
  let sent;
  sender.onSendUpdate = (payload) => { sent = payload; };
  await sender.save('hello from sender', []);

  // Deliver to receiver via applyUpdate
  await receiver.applyUpdate({ payload: sent });
  assert.strictEqual(receiver.content,
    'hello from sender',
    'receiver must see sender content');
});

test('applyUpdate from wrong passphrase is ignored', async () => {
  const sender = new Vault();
  const receiver = new Vault();

  await sender.unlock('key-A');
  await receiver.unlock('key-B');

  let sent;
  sender.onSendUpdate = (payload) => { sent = payload; };
  await sender.save('private to A', []);

  await receiver.applyUpdate({ payload: sent });
  assert.strictEqual(receiver.content, '',
    'wrong-key peer must not see content');
});
