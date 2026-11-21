# Lenar Wallet

A lightweight, non-custodial browser-extension wallet for the **Lenar** blockchain (Chrome / Chromium, Manifest V3). Your keys are generated and stored on your device and never leave it.

The cryptography (BIP-39 mnemonic, Ed25519 key derivation, Keccak-256, transaction and message signing) is written in **Rust** and compiled to **WebAssembly** (`pkg/libcrypto*`). The UI and RPC logic are plain JavaScript (`popup.html`, `popup.js`, `background.js`).

---

## Network details

| Field            | Value                               |
| ---------------- | ----------------------------------- |
| Network name     | Alpha                               |
| Status           | **Mainnet Alpha**                   |
| RPC URL          | `https://alpha.lenarchain.xyz/`     |
| Chain ID         | `1`                                 |
| Token symbol     | **$LP** (entered as `LP` in the wallet) |
| Address prefix   | `rx`                                |
| BIP-44 coin type | `15000`                             |

The Alpha network is built in and selected by default. You can add other chains (name, RPC URL, chain ID, symbol, Mainnet/Testnet) under **Settings → Network**.

Quick RPC health check:

```bash
curl https://alpha.lenarchain.xyz/chainid
curl https://alpha.lenarchain.xyz/block_number
```

Endpoints used by the wallet (all `GET`): `chainid`, `block_number`, `block/<n>`, `account/<address>`, `transaction/<hash>`, `power_price`, `traffic`.

> Mainnet Alpha is an early network. Only use funds you can afford to lose, and always back up your recovery phrase.

---

## Quick start: use the prebuilt wallet (no Rust needed)

The easiest way to install. A GitHub Actions workflow (`.github/workflows/release-extension.yml`) builds everything and publishes a ready-to-install zip: `lenar-wallet-vX.Y.Z.zip`.

### Download

- **Releases (recommended):** open the repository's **Releases** page and download `lenar-wallet-vX.Y.Z.zip` (plus the `.sha256` file if you want to verify it).
- **Latest build without a release:** open the **Actions** tab → **Release extension (zip)** → pick the latest successful run → download the **lenar-wallet** artifact (GitHub wraps it in one more zip; unzip it once to get `lenar-wallet-vX.Y.Z.zip`).

Optional integrity check:

```bash
sha256sum -c lenar-wallet-vX.Y.Z.zip.sha256
```

### Install on desktop (Chrome / Edge / Brave)

1. Unzip `lenar-wallet-vX.Y.Z.zip` into a folder, for example `lenar-wallet/`. Keep this folder; the browser loads the extension from it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the `lenar-wallet/` folder (the one containing `manifest.json`).
4. Pin **Lenar Wallet** from the puzzle-piece menu.

### Install on Android

1. Download `lenar-wallet-vX.Y.Z.zip` to your phone. **Do not unzip it** for the import: the browser reads the zip directly, and `manifest.json` is already at its root.
2. In an Android browser that supports Chromium extensions (e.g. Kiwi Browser), open `chrome://extensions` and enable **Developer mode**.
3. Tap **+ (from .zip/.crx/.user.js)** and choose the downloaded zip.
4. Open the browser menu (⋮) → **Lenar Wallet**.

If the import fails, extract the zip with a file manager and check that `manifest.json`, `background.js`, `popup.html`, `popup.js`, `pkg/`, `icons/` and `fonts/` are all present (see the Android troubleshooting table below).

### Use the wallet

1. **Create a wallet:** open Lenar Wallet → **Create Wallet** → choose a password (at least 10 characters; it only unlocks the wallet on this device).
2. **Back up the recovery phrase:** write the words on paper, in order, and store them offline. Never screenshot it or share it. Tap **I've Saved It**, then complete the **Verify** step.
3. **Or import:** choose **Import Existing Wallet** and enter your existing recovery phrase.
4. **Check the network:** the header should show **Alpha** with the **Mainnet** label and symbol **LP**. This is the default (`https://alpha.lenarchain.xyz/`, chain ID 1).
5. **Receive $LP:** tap your address on the Home screen to copy it, and share your `rx...` address with the sender.
6. **Send $LP:** tap **Send**, enter the recipient `rx...` address and the amount, then **Review Transaction** and **Confirm**.
7. **Track transactions:** use the **Explorer** button on Home to search a transaction hash, block, or account.
8. **Sign a message:** open the **Sign Message** page inside the wallet (signing only happens from inside the wallet, never from a website).
9. **Lock / unlock:** use **Lock Wallet** when you are done; **Unlock** with your password next time.

### Publish a new release (maintainers)

```bash
# 1. bump "version" in manifest.json (and Cargo.toml if you like), commit it
# 2. tag and push
git tag v0.1.0
git push origin v0.1.0
```

Pushing a tag starting with `v` makes the workflow build the WASM, assemble the extension, and attach `lenar-wallet-v<manifest version>.zip` to a new GitHub Release. You can also run it manually from the **Actions** tab (**Run workflow**); the zip is then available as a downloadable artifact only.

---

## Repository layout

```
.
├── Cargo.toml          # Rust crate "libcrypto" (cdylib -> WASM)
├── src/lib.rs          # Rust source: keys, signing, hashing
├── manifest.json       # Chrome extension manifest (MV3)
├── background.js       # Service worker (RPC, wallet logic)
├── popup.html          # Wallet UI
├── popup.js            # Wallet UI logic
├── icons/              # Extension icons + logo.svg
├── fonts/              # Figtree font (bundled locally)
└── pkg/                # GENERATED by the build (WASM + JS glue)
```

> `pkg/` is build output. It must exist before the extension will load, because `background.js` imports `./pkg/libcrypto.js`.

---

## 1. Build from source (desktop)

Only needed if you want to compile the extension yourself. Otherwise use the **Quick start** above.

### Requirements

- **Rust 1.85 or newer** (`rust-version = "1.85"` in `Cargo.toml`)
- The WebAssembly target for Rust
- `wasm-bindgen-cli` (version must match the `wasm-bindgen` crate, see below)
- A Chromium-based desktop browser (Chrome 114+, Edge, Brave, ...)

### Step 1: Install Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustc --version        # must be 1.85.0 or newer
rustup update stable   # if it is older
```

On Windows, download `rustup-init.exe` from <https://rustup.rs>.

### Step 2: Add the WASM target

```bash
rustup target add wasm32-unknown-unknown
```

### Step 3: Compile the Rust code to WASM

From the project root (the folder that contains `Cargo.toml`):

```bash
cargo build --release --target wasm32-unknown-unknown
```

The output is `target/wasm32-unknown-unknown/release/libcrypto.wasm`.

### Step 4: Generate the JS bindings into `pkg/`

Install `wasm-bindgen-cli` at the **same version** as the `wasm-bindgen` crate that Cargo just resolved:

```bash
cargo install wasm-bindgen-cli --version "$(cargo pkgid wasm-bindgen | cut -d@ -f2)"
```

Then generate the `pkg/` folder:

```bash
wasm-bindgen \
  --target web \
  --out-dir pkg \
  --out-name libcrypto \
  target/wasm32-unknown-unknown/release/libcrypto.wasm
```

You should now have:

```
pkg/
├── libcrypto.js
├── libcrypto.d.ts
├── libcrypto_bg.wasm
└── libcrypto_bg.wasm.d.ts
```

> `--target web` and `--out-name libcrypto` are required: `background.js` does `import init, {...} from "./pkg/libcrypto.js"`.

**Alternative: `wasm-pack`** (does steps 3 and 4 in one command)

```bash
cargo install wasm-pack
wasm-pack build --release --target web --out-dir pkg
```

This also creates `pkg/package.json` and a few other files; they are harmless, but only the `libcrypto.js` and `libcrypto_bg.wasm` files are needed at runtime.

**Optional: shrink the WASM** (needs [binaryen](https://github.com/WebAssembly/binaryen)):

```bash
wasm-opt -Oz pkg/libcrypto_bg.wasm -o pkg/libcrypto_bg.wasm
```

The release profile uses `lto = true` and `codegen-units = 1`, so the same source plus the same toolchain gives the same WASM.

### Step 5: Load the extension in desktop Chrome

1. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select the project root folder, the one that contains `manifest.json`, `pkg/`, `icons/` and `fonts/`.
5. **Lenar Wallet** appears in the list. Click the puzzle-piece icon in the toolbar and pin it.

After changing any code, click the **reload** icon on the extension card. If you changed the Rust code, repeat steps 3 and 4 first.

### First use

1. Open the extension and choose **Create wallet** (or import an existing recovery phrase).
2. **Write down your recovery phrase on paper** and keep it offline. Anyone with it controls your funds, and it cannot be recovered if lost.
3. The network is already set to **Alpha (Mainnet, RPC `https://alpha.lenarchain.xyz/`, symbol `LP`)**.

Notes:

- The extension is **not allowed in Incognito** (`"incognito": "not_allowed"`).
- Requires Chrome **114 or newer**.
- The RPC host `https://alpha.lenarchain.xyz/*` is pre-approved. For any custom RPC, the browser will ask for permission when you add it.

---

## 2. Install on Android

Chrome's "Load unpacked" (import by folder) is not available on Android. Instead, you import a **`.zip`** file, using an Android browser that supports Chromium extensions and installing from a `.zip`/`.crx` (for example **Kiwi Browser**, or a similar Chromium-based browser with extension support).

> Firefox for Android is **not** compatible: this extension uses a Chrome-style Manifest V3 service worker.
> Kiwi Browser is no longer actively developed, so download it only from its official project page, and keep only small amounts in a wallet on a phone.

### Step 1: Prepare the ZIP

> Using the prebuilt release zip from the **Quick start** section? Skip this step and go to Step 2.

The source zip alone (`Cargo.toml`, `src/`, `popup.js`, ...) **cannot be imported**, because it does not contain the generated `pkg/` folder, the icons, or the fonts. First build on a computer (Section 1, steps 1-4), then create an install zip containing **only the files the extension needs**:

```bash
zip -r lenar-wallet-android.zip \
  manifest.json \
  background.js \
  popup.html \
  popup.js \
  pkg/libcrypto.js \
  pkg/libcrypto_bg.wasm \
  icons \
  fonts
```

Windows (PowerShell):

```powershell
Compress-Archive -Path manifest.json,background.js,popup.html,popup.js,pkg,icons,fonts -DestinationPath lenar-wallet-android.zip
```

The important rule: **`manifest.json` must be at the root of the zip**, not inside a subfolder. Do not zip the parent folder itself.

Files you do **not** need on the phone: `Cargo.toml`, `src/`, `target/`, `LICENSE-*`, `.github/`, `.gitignore`, `tree.txt`, `pkg/*.d.ts`, and any other `.zip` files.

### Step 2: Copy the ZIP to your phone

Send it via USB, cloud storage, or any file-sharing app, and save it somewhere easy to find, such as `Downloads/`.

### Step 3: Check the contents (optional but recommended)

If the import fails, extract the zip with a file manager (e.g. **Files by Google** or **ZArchiver**) and verify that you see this structure directly inside the extracted folder:

```
manifest.json
background.js
popup.html
popup.js
pkg/libcrypto.js
pkg/libcrypto_bg.wasm
icons/ (icon16.png, icon32.png, icon48.png, icon128.png, logo.svg)
fonts/ (figtree-latin-wght-normal.woff2)
```

If everything sits inside one extra folder (e.g. `lenar-wallet/manifest.json`), re-zip the files from **inside** that folder so that `manifest.json` ends up at the zip root.

### Step 4: Import into the Android browser (Kiwi example)

1. Open the browser and go to `chrome://extensions`.
2. Turn on **Developer mode**.
3. Tap **+ (from .zip/.crx/.user.js)**.
4. Pick `lenar-wallet-android.zip` from your files.
5. **Lenar Wallet** should appear in the extension list, enabled.
6. Open the browser menu (⋮) → **Lenar Wallet** to open the wallet popup.

### Step 5: Use it

Create or import a wallet, back up the recovery phrase, and confirm the network shows **Alpha (Mainnet)** with symbol **LP**.

### Android troubleshooting

| Problem | Fix |
| --- | --- |
| "Manifest file is missing or unreadable" | `manifest.json` is not at the zip root. Re-zip as described above. |
| "Could not load ... pkg/libcrypto.js" / service worker registration failed | `pkg/` is missing from the zip. Rebuild (Section 1) and re-zip. |
| Fonts or icons missing | Include the `icons/` and `fonts/` folders in the zip. |
| Extension does not open or the popup is blank | Browser too old. Chrome/Chromium **114+** is required. Update the browser. |
| "Cannot connect to node" | Check your internet, and test `https://alpha.lenarchain.xyz/chainid` in the browser. |
| Needs a custom RPC permission | Approve the permission prompt when adding a custom network. |

---

## Security notes

- Never share your recovery phrase or private key with anyone, including project members.
- The wallet signs only inside the extension; there is no external sign request from websites.
- Only load extension files you built yourself or got from a source you trust. An altered extension can steal your keys.
- Keys are stored locally on your device. If you lose the device and the recovery phrase, funds cannot be recovered.

---

## License

Dual-licensed under **MIT** or **Apache-2.0**, at your option. See `LICENSE-MIT` and `LICENSE-APACHE`.
