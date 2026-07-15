# Vault

Encrypted [webxdc](https://webxdc.org) app host.

Each passphrase unlocks its own end-to-end encrypted "room"
hosting a webxdc app: the first user to unlock a passphrase
uploads a `.xdc` file, which is then permanently bound to that passphrase.
Everyone entering the same passphrase runs the same app 
and collaborates through encrypted updates; 
everyone else sees only unreadable ciphertext.

Vault runs in a *webxdc runtime* -- the hosting messenger
(e.g. Delta Chat) that executes webxdc apps.


## How it Works

Entering a passphrase derives a symmetric AES-256 key via
Argon2id (fixed salt `"vault-v1"`). All outer chat updates
carry only `{ iv, data }` AES-256-GCM ciphertexts with empty
descriptions. Two inner payload types exist:

- `app_definition`: the guest `.xdc` archive. If competing
  definitions exist, the lowest outer serial wins, permanently.

- `sub_app_update`: an update sent by the guest app via its
  `webxdc.sendUpdate()`.

Unlocking attempts to decrypt every update in the chat history;
the payloads that decrypt form the app definition and its
update stream.

### Running guest apps

The guest `.xdc` is decrypted and unzipped entirely in memory
and run from a plain `srcdoc` iframe, same-origin with the
vault: every archive file becomes a `blob:` URL, and all
`src`/`href`/`url()` references in HTML and CSS are rewritten
to those URLs. No Service Worker or network is involved.

The iframe is deliberately *not* sandboxed, maximizing
compatibility (blob workers, same-origin blob loads): guest
apps are as trusted as the vault itself -- see the threat
model.

### Guest webxdc API

The guest's packaged `webxdc.js` is replaced by a shim that
bridges each API the outer runtime provides, via postMessage:

- `sendUpdate` / `setUpdateListener`: guest updates travel
  encrypted as `sub_app_update` payloads. 
  Descriptions are always sent empty; 
  `sendUpdateMaxSize` is the outer budget minus encryption overhead.

- `joinRealtimeChannel`: forwarded over the outer realtime
  channel, shared by all chat members. Each message is framed
  as 12-byte IV || GCM ciphertext; frames that fail
  authentication (other rooms) are silently dropped.

- `importFiles`, `sendToChat`: forwarded to the outer runtime.
  `sendToChat` shares content *out of the encrypted room* --
  an explicit user choice, confirmed via the runtime's dialog.

- `selfAddr`, `selfName`: identical to the outer values.

The shim also patches `fetch`/`XMLHttpRequest` so runtime
requests for archive paths resolve to the blob URLs.

### Guest app limitations

- **App size**: the archive must fit in one encrypted outer
  update, i.e. `webxdc.sendUpdateMaxSize` minus overhead
  (fallback: 1 MB).

- **Dynamic asset references**: static HTML/CSS refs,
  `fetch`/`XMLHttpRequest`, and
  `new URL('./asset', import.meta.url)` resolve; computed
  `import()`, `new Worker(path)`, and relative paths assigned
  to DOM properties like `img.src` do not.

- **Ephemeral storage only**: to keep room plaintext off the
  disk, `localStorage`/`sessionStorage` are replaced by
  in-memory stand-ins that vanish when the vault is locked or
  closed, and `indexedDB` is hidden (apps take their
  feature-detection fallback). Durable room state belongs in
  webxdc updates. This is hygiene for honest apps, not a
  security boundary -- same-origin guests could undo it.

- **No Service Workers** (they need a real origin).

- **History routing**: `srcdoc` documents forbid history URL
  rewriting; `pushState`/`replaceState` fall back to
  state-only navigation, so routing works but the address
  never changes.

### Proposed webxdc runtime APIs

With web platform means alone, strong guest isolation and app
compatibility conflict. Two runtime additions would resolve
this:

1. `webxdc.runXdc(bytes, webxdcImpl)` -- nested app hosting:
   run zip bytes as a child app in a real isolated origin with
   partitioned storage, with the caller supplying the child's
   `webxdc` implementation. Vault's entire bundling and
   patching layer would disappear, and guest isolation would
   become a real security boundary: a malicious guest could no
   longer reach the vault document, key, or outer `webxdc` API
   -- only the callbacks the vault hands it (see the threat
   model's trusted-guest caveat, which this would largely
   remove).

2. `webxdc.appId` -- an identifier shared by all peers of an
   app instance, usable as per-instance KDF salt (see the
   fixed-salt note below).

### Nesting

A vault can run inside another vault: each level bundles its
guest independently and encrypts once more.


## Security & Threat Model

Vault adds a passphrase-derived encryption layer on top of
whatever transport the webxdc runtime provides: everything a
room does is a uniform `{ iv, data }` ciphertext before it
reaches the outer chat.

### Assumptions

Vault presumes an isolated,
[specification-compliant](https://webxdc.org/docs/spec/messenger.html)
webxdc environment: no network access, no way to talk to
anything but the webxdc runtime. Vault and its guest apps
inherit this isolation -- neither can exfiltrate room content
to the outside world.

### Assets

Confidentiality and integrity of the guest app archive, its
filename, all updates and realtime messages; the passphrase
and the key derived from it.

### Adversaries and guarantees

- **Server / network observer**: transport is up to the
  runtime; even an observer reading the raw update stream sees
  only ciphertexts.

- **Chat member without the passphrase**: sees only
  ciphertexts with random IVs and empty descriptions. GCM
  authentication rejects forged or tampered payloads, so they
  cannot inject content or bind an app to an unknown
  passphrase.

- **Device seizure / database access**: must brute-force the
  passphrase at one Argon2id derivation (64 MiB, 20 passes)
  per guess; memory-hardness blunts GPU/ASIC acceleration.
  A high-entropy passphrase is the security anchor of the
  whole design.

### Cryptographic design

- **Key derivation**: Argon2id (64 MiB, 20 passes,
  parallelism 1) -> 256-bit non-extractable WebCrypto key.

- **Fixed salt** (`"vault-v1"`): a per-room salt would itself
  be readable metadata, which this design avoids. The cost: a
  precomputed passphrase dictionary works against every vault
  instance, so passphrase entropy is the *only* secret.
  A runtime-provided `webxdc.appId` (see proposed APIs) could
  serve as per-instance salt instead.

- **Encryption**: AES-256-GCM, fresh random 96-bit IV per
  message. Updates travel as base64 `{ iv, data }` JSON,
  realtime frames as raw `IV || ciphertext`.

### Non-goals and residual risks

- **Traffic analysis**: sizes, timing, and frequency of
  updates reveal *that* and *when* a room is active -- never
  *what* it contains.

- **No sender authentication in a room**: the passphrase is a
  shared group key; anyone holding it can read and forge any
  room message. Attribution relies on the outer chat.

- **No forward secrecy or key rotation**: one static key per
  passphrase, forever. Whoever ever learns the passphrase can
  decrypt the room's entire past and future; there is no
  revocation short of abandoning the room.

- **Guest apps are fully trusted, not audited**: the
  unsandboxed guest can reach the vault document and the outer
  `webxdc` API: read the unlocked room's passphrase and
  content, corrupt or spam the room, send *plaintext* updates
  into the outer chat, or share content via
  `sendToChat`/`importFiles`. It still cannot reach the
  outside world (runtime isolation), and other rooms remain
  ciphertext. The binding is permanent -- only run `.xdc`
  files you trust as much as the vault itself.

- **Availability**: any chat member can flood the chat with
  garbage updates; Vault ignores them but the runtime still
  stores and transfers them.

- **Runtime exposure**: while unlocked, plaintext lives in
  memory; locking discards the key. A compromised OS, runtime,
  or browser engine is out of scope.

- **Passphrase distribution** happens out of band and is the
  users' responsibility.


## Reproducible Building

```bash
pnpm install
pnpm build
```

`vault.xdc` is built deterministically: ZIP entries are sorted
alphabetically with fixed modification times, so the same
source commit always yields the identical binary and SHA-256
hash. The release workflow verifies the uploaded `vault.xdc`
by rebuilding it and comparing hashes.


## Developing

Run against the vite dev server with webxdc-dev
(hot-reload, simulates multiple peers):

```bash
pnpm dev:webxdc
```


## Updating Argon2id

The Argon2id WASM binaries are inlined as base64 in
`argon2id-inline.js`. After updating the `argon2id` npm
package, regenerate the inline file:

```bash
pnpm update argon2id
pnpm inline-wasm
```

This runs automatically as part of `pnpm build` via the
`prebuild` hook.
