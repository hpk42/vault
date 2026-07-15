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

A fresh, random initialization vector (IV) is generated for each update.
Although the plaintext changes with each edit (preventing identical payloads from
being stored), a unique IV is still strictly required to satisfy AES-256-GCM
security properties. Reusing an IV with the same key (a "nonce reuse") would
destroy both confidentiality and authenticity, allowing an attacker to decrypt
updates or forge payloads.
The resulting payload written to the disk contains only the IV and the encrypted data.

To unlock, the app computes the key from your passphrase and attempts to decrypt
all update payloads in the chat history. Payloads that decrypt successfully are
collected, and the one with the highest version/tiebreak is displayed.


## Security & Threat Model

The primary threat model is an attacker who has seized a device and obtained access to
the local database containing all update payloads, or intercepted the network traffic.

* **Exposed Data**: The database only contains `{ iv, data }` payloads. No metadata, version
  counters, salts, plain text, or filenames are stored in the clear.

* **Brute-Force Protection**: To guess the passphrase, the attacker must run Argon2id
  for each attempt to derive the key and verify if the data decrypts.

* **Argon2id Parameters**: By using Argon2id with 64 MiB memory and 20 passes, key derivation
  is memory-hard. This limits GPU/ASIC acceleration, making brute-force attacks extremely slow.

* **Recommendation**: A weak or short numeric PIN can be brute-forced. A strong alphanumeric
  passphrase of 8 or more characters is recommended for secure protection.


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
