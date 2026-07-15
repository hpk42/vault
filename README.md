# Vault

Encrypted vault [webxdc](https://webxdc.org) app.
Each vault is locked behind a passphrase --
only those who know it can read or edit the content.

Uses Argon2id (WASM) for key derivation
and AES-256-GCM for encryption.
All data on disk is encrypted;
update payloads contain only `{ iv, data }`.


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
