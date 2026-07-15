# Vault

Encrypted vault [webxdc](https://webxdc.org) app.
Each vault is locked behind a passphrase --
only those who know it can read or edit the content.


## How it Works

Upon entering a passphrase, the app derives a symmetric key using the Argon2id
algorithm with a fixed, hardcoded salt ("vault-v1").

Every time you edit and lock the vault, the entire state (the text, version counter,
tiebreak nonce, and attachments) is serialized to JSON and encrypted as a single
block using AES-256-GCM.

A fresh, random initialization vector (IV) is generated for each update to ensure
that saving the same content multiple times produces different-looking ciphertext.
The resulting payload written to the disk contains only the IV and the encrypted data.

To unlock, the app computes the key from your passphrase and attempts to decrypt
all update payloads in the chat history. Payloads that decrypt successfully are
collected, and the one with the highest version/tiebreak is displayed.


## Building

```bash
pnpm install
pnpm build
```

The `.xdc` file is produced as `vault.xdc`.


## Developing

Run against the vite dev server with webxdc-dev
(hot-reload, simulates multiple peers):

```bash
pnpm dev:webxdc
```


## Updating Argon2id

The Argon2id WASM binaries are inlined as base64
in `argon2id-inline.js`.
After updating the `argon2id` npm package, regenerate:

```bash
pnpm update argon2id
pnpm inline-wasm
```

This runs automatically as part of `pnpm build`
via the `prebuild` hook.
