# Vault

Encrypted [webxdc](https://webxdc.org) app host.

Each passphrase unlocks its own end-to-end encrypted "room" hosting a "guest" webxdc app:
the first user to unlock a passphrase uploads a `.xdc` file.
Everyone entering the same passphrase runs the same app
and collaborates through encrypted updates;
everyone not knowing the passphrase else sees unreadable ciphertext.

## How it Works

Entering a passphrase derives a symmetric AES-256 key via Argon2id.

All outer chat updates carry only `{ iv, data }` AES-256-GCM ciphertexts
with empty descriptions.

Two inner payload types exist:

* `app_definition`: the guest `.xdc` archive.
  If competing definitions exist, the lowest outer serial wins.

* `room_update`: an update sent by the guest app via its
  `webxdc.sendUpdate()`.

Unlocking attempts to decrypt every update in the chat history;
the payloads that decrypt form the app definition and its update stream.


### Running guest apps

The guest `.xdc` is decrypted and unzipped entirely in memory
and run from a *sandboxed* `srcdoc` iframe
(`sandbox="allow-scripts allow-forms allow-modals"`, opaque origin):
every archive file becomes a `blob:` URL,
and all `src`/`href`/`url()` references in HTML and CSS are rewritten to those URLs.
App-supplied CSP meta tags are dropped
(they would block the blob: URLs; guests have no network anyway).

Since `blob:` URLs are origin-bound, the vault cannot create them for the guest:
the srcdoc is a small boot document
carrying all archive files (base64) plus the bundling code,
which bundles *inside* the sandbox and replaces itself with the rewritten app document.

The sandbox is a real boundary:
the guest cannot reach the vault document, the key, or the passphrase --
its only capability is the postMessage bridge described below.

Nesting works: a vault can run inside another vault;
each level bundles its guest independently and encrypts once more.


### Guest webxdc API

The guest's packaged `webxdc.js` is replaced by a shim
that bridges each API the outer runtime provides, via postMessage
(the shim is injected into `index.html` even if the app
never references `webxdc.js` itself):

* `sendUpdate` / `setUpdateListener`: room updates travel
  encrypted as `room_update` payloads.
  Descriptions are always sent empty;
  `sendUpdateMaxSize` is the outer budget minus encryption overhead.

* `joinRealtimeChannel`: forwarded over the outer realtime channel,
  shared by all chat members.
  Each message is framed as 12-byte IV || GCM ciphertext;
  frames that fail authentication (other rooms) are silently dropped.

* `importFiles`, `sendToChat`: forwarded to the outer runtime.
  `sendToChat` shares content *out of the encrypted room* --
  an explicit user choice, confirmed via the runtime's dialog.

* `selfAddr`, `selfName`: identical to the outer values.

The shim also patches `fetch`/`XMLHttpRequest`
and other dynamic asset references (see limitations below)
so runtime requests for archive paths resolve to the blob URLs.


### Sharing a vault with contents

The entry screen links to a share screen:
enter one or more passphrases,
and Vault packages itself plus the matching encrypted updates
(as `preloaded.json`) into a new `vault-collection.xdc`,
sent to the chat via `sendToChat`.
Opening the collection preloads that history --
recipients still need the passphrase(s) to unlock the room(s),
and new updates keep flowing through the new chat.


### Guest app limitations

* **App size**: the archive must fit in one encrypted outer update,
  i.e. `webxdc.sendUpdateMaxSize` minus overhead (fallback: 1 MB).

* **Dynamic asset references**: static HTML/CSS refs,
  `fetch`/`XMLHttpRequest`, `new URL('./asset', import.meta.url)`,
  and runtime-assigned media/image/script sources
  (`el.src = path`, `setAttribute('src', ...)`, `new Audio(path)`) resolve;
  computed `import()` and `new Worker(path)` do not.

* **No Service Workers** (they need a real origin).

* **Ephemeral storage only**: to keep room plaintext off the disk,
  `localStorage`/`sessionStorage` are replaced by in-memory stand-ins
  that vanish when the vault is locked or closed,
  and `indexedDB` is hidden (apps take their feature-detection fallback).
  The sandbox's opaque origin enforces this -- real web storage is unreachable.
  Durable room state belongs in webxdc updates.

* **Sandbox restrictions**: no popups or new windows, no top-level navigation.
  `srcdoc` documents forbid history URL rewriting;
  `pushState`/`replaceState` fall back to state-only navigation,
  so routing works but the address never changes.


### Proposed webxdc runtime APIs

Vault chooses isolation: guests run in a sandboxed opaque origin,
at the cost of bundling complexity and some app compatibility (see limitations above).
Two runtime additions would remove that cost (1)
and strengthen key derivation (2):

1. `webxdc.runXdc(bytes, webxdcImpl)` -- nested app hosting:
   run zip bytes as a child app in a real isolated origin,
   with the caller supplying the child's `webxdc` implementation.
   Guests would get working relative URLs, dynamic `import()`, Workers,
   and partitioned storage, while keeping full isolation --
   Vault's entire bundling and patching layer would disappear.
   Service workers would work wherever the runtime supports
   them for top-level apps (runtime-limited instead of impossible).

   The design should be *embedded*, not fullscreen/modal:
   the child runs concurrently and the caller stays in control:

   ```js
   const handle = await webxdc.runXdc(bytes, {
     sendUpdate, setUpdateListener,
     joinRealtimeChannel, /* caller's implementation */
   });
   container.append(handle.element); // child iframe
   handle.terminate();               // caller ends it
   ```

   Host apps need to keep their UI framing around the child,
   tear it down at any time (Vault: on lock),
   and mediate API calls *while* the child runs;
   nesting requires each level to embed.

   Runtime implementation sketch (e.g. Delta Chat): mint a
   fresh origin per child (as already done for top-level apps),
   serve the zip bytes from it via the existing request-interception machinery,
   and inject a `webxdc.js` that routes to the caller's `webxdcImpl`
   instead of to core,
   formalizing the postMessage bridge Vault implements manually today.

2. `webxdc.appId` -- an identifier shared by all peers of an app instance,
   usable as per-instance KDF salt (see the fixed-salt note below).



## Security & Threat Model

Vault adds a passphrase-derived encryption layer on top of
whatever transport the webxdc runtime provides:
everything a room does is a uniform `{ iv, data }` ciphertext
before it reaches the outer chat.


### Assumptions

Vault presumes an isolated,
[specification-compliant](https://webxdc.org/docs/spec/messenger.html) webxdc environment:
no network access, no way to talk to anything but the webxdc runtime.
Vault and its guest apps inherit this isolation --
neither can exfiltrate room content to the outside world.


### Assets

Confidentiality and integrity of the guest app archive, its filename,
all updates and realtime messages;
the passphrase and the key derived from it.


### Adversaries and guarantees

* **Server / network observer**: transport is up to the runtime;
  even an observer reading the raw update stream sees only ciphertexts.

* **Chat member without the passphrase**: sees only ciphertexts
  with random IVs and empty descriptions.
  GCM authentication rejects forged or tampered payloads,
  so they cannot inject content or bind an app to an unknown passphrase.

* **Device seizure / database access**: must brute-force the passphrase
  at one Argon2id derivation (64 MiB, 20 passes) per guess;
  memory-hardness blunts GPU/ASIC acceleration.
  A high-entropy passphrase is the security anchor of the whole design.


### Cryptographic design

* **Key derivation**: Argon2id (64 MiB, 20 passes,
  parallelism 1) -> 256-bit non-extractable WebCrypto key.

* **Fixed salt** (`"vault-v1"`): a per-room salt would itself be readable metadata,
  which this design avoids.
  The cost: a precomputed passphrase dictionary works against every vault instance,
  so passphrase entropy is the *only* secret.
  A runtime-provided `webxdc.appId` (see proposed APIs) could
  serve as per-instance salt instead.

* **Encryption**: AES-256-GCM, fresh random 96-bit IV per message.
  Updates travel as base64 `{ iv, data }` JSON,
  realtime frames as raw `IV || ciphertext`.


### Non-goals and residual risks

* **Traffic analysis**: sizes, timing, and frequency of updates
  reveal *that* and *when* a room is active -- never *what* it contains.

* **No forward secrecy or key rotation**: one static key per passphrase, forever.
  Whoever ever learns the passphrase can decrypt the room's entire past and future;
  there is no revocation short of abandoning the room.

* **Guest apps are origin-isolated, not audited**: the guest
  runs in a sandboxed iframe with an opaque origin and cannot reach the vault document,
  the key, or the passphrase;
  its only capability is the postMessage bridge for
  reading and writing its own room's updates and realtime data,
  plus user-confirmed actions (`importFiles` picker, `sendToChat` dialog).
  This relies on the browser's sandbox being correct.

* **Runtime exposure**: while unlocked, plaintext lives in memory;
  locking discards the key.
  A compromised OS, runtime, or browser engine is out of scope.

* **Passphrase distribution** happens out of band and is the
  users' responsibility.


## Reproducible Building

```bash
pnpm install
pnpm build
```

`vault.xdc` is built deterministically:
ZIP entries are sorted alphabetically with fixed modification times,
so the same source commit always yields the identical binary and SHA-256 hash.


## Developing

Run against the vite dev server with webxdc-dev
(hot-reload, simulates multiple peers):

```bash
pnpm dev:webxdc
```

Run the tests (no mocks; slow key-derivation tests included)
and the linter:

```bash
pnpm test
pnpm lint
```


## Releasing

```bash
pnpm release
```

Runs tests and lint, bumps the minor version, builds,
pushes commit and tag,
and creates a GitHub release with `vault.xdc` attached.
The release workflow verifies the uploaded artifact
by rebuilding it and comparing hashes.


## Updating Argon2id

The Argon2id WASM binaries are inlined as base64 in `argon2id-inline.js`.
After updating the `argon2id` npm package, regenerate the inline file:

```bash
pnpm update argon2id
pnpm inline-wasm
```

This runs automatically as part of `pnpm build` via the
`prebuild` hook.
