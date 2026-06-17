# zsign WASM

Desktop-Chromium web app for local, in-browser IPA signing with a WebAssembly build of
[`zhlynn/zsign`](https://github.com/zhlynn/zsign).

The app runs zsign inside a dedicated Web Worker. IPA files, P12/private-key material,
provisioning profiles, dylibs, and generated output stay on the local machine unless
you explicitly upload or host the signed IPA somewhere else.

## Current Status

- Browser signing works locally in desktop Chromium.
- The UI is intentionally simplified around the common flow: IPA, P12, provisioning
  profile, dylib, password, output IPA name, bundle ID, cert cache, logs, download,
  and install QR preparation.
- Advanced zsign options remain wired in TypeScript/worker code for later UI work.
- Cert/profile/password caching is optional and stored in browser IndexedDB.
- Generated WASM runtime files are committed under `public/wasm/` so a fresh clone can
  run without rebuilding Emscripten/OpenSSL first.
- Heavy rebuild workspaces are ignored and reproducible: `deps/`, `tools/emsdk/`,
  `.build/`, `dist/`, `node_modules/`, `.tmp/`.

## What "Fully Local" Means

Signing is fully local:

- No signing server is required.
- zsign executes in the browser worker.
- Private key material does not need to leave the browser.
- Signed IPA output is produced as a browser download.

The install QR flow is different:

- iOS OTA install needs an IPA URL reachable by the iPhone.
- Browser `blob:` URLs and downloaded files are not reachable from the iPhone.
- Palera can generate/serve a manifest plist, but the manifest still needs a
  `fetchurl` pointing at an HTTPS IPA URL the iPhone can fetch.
- A Feather-style fully local install flow needs a native/local companion HTTPS
  server. Browser-only JavaScript cannot listen for inbound HTTPS requests from the
  iPhone.

## Feather / Palera Notes

[Feather](https://github.com/claration/Feather) runs a native Vapor server inside the
iOS app. Its fully local mode uses `itms-services://` plus a trusted HTTPS certificate
for `*.backloop.dev`. That hostname resolves to loopback, which works because Feather's
server is running on the same iPhone.

For this desktop browser project, `*.backloop.dev` would point the iPhone back to
itself, not to the desktop machine. The same architecture can be added later with a
small companion server that serves the signed IPA and manifest from the desktop over a
trusted HTTPS hostname.

The current QR feature mirrors Feather's semi-local/Palera path:

```text
https://api.palera.in/genPlist?bundleid=...&name=...&version=...&fetchurl=<HTTPS_IPA_URL>
itms-services://?action=download-manifest&url=<encoded_manifest_url>
```

## Quick Start

```powershell
npm install
npm run dev
```

Open the Vite URL, usually:

```text
http://localhost:5173
```

## Normal Use

1. Choose an IPA.
2. Choose a P12/PFX.
3. Choose one or more `.mobileprovision` files.
4. Enter the P12 password.
5. Optional: choose dylibs to inject.
6. Optional: enter a new bundle ID.
7. Optional: enable `Cache cert info`.
8. Click `Sign`.
9. Download the signed IPA from the output row.

The output name defaults to the input IPA name with `_signed` appended.

## Install QR Use

The QR section expects:

- HTTPS URL to the signed IPA, reachable from the iPhone.
- Bundle ID.
- App name.
- Version.

Click `QR` to generate an `itms-services://` QR code using Palera's manifest endpoint.

This does not upload the IPA. It only creates the manifest URL. The IPA must already be
hosted at the `fetchurl` you provide.

## Static Hosting

Build the static web app:

```powershell
npm run build
```

Host the generated `dist/` directory on an HTTPS static host.

The host must serve:

```text
.wasm -> application/wasm
.js/.mjs -> text/javascript or application/javascript
```

Important trust note: a hosted static site is still code your browser downloads. If the
hosting account or domain is compromised, the app code could be changed. For maximum
trust, self-host a known build or run locally from a checked-out commit.

## Rebuilding WASM

The committed `public/wasm/zsign.mjs` and `public/wasm/zsign.wasm` are enough for normal
development. Rebuild only when zsign, OpenSSL, or the Emscripten build scripts change.

```powershell
npm run setup:emsdk
npm run build:openssl
npm run build:wasm
npm run wasm:smoke
```

Pinned build inputs:

- Emscripten `6.0.0`
- OpenSSL `3.5.7`
- zsign upstream commit documented in `docs/UPSTREAM.md`

## Verification

```powershell
npm run build
npm run test:e2e
```

Smoke test the WASM CLI:

```powershell
npm run wasm:smoke
```

## Repository Layout

```text
src/                 Vite TypeScript app, UI, zsign API wrapper, worker
public/wasm/         committed zsign WASM runtime used by the browser app
scripts/             Emscripten/OpenSSL/zsign build and smoke-test scripts
vendor/zsign/        vendored upstream zsign source
docs/                upstream and WASM build notes
tests/e2e/           Playwright browser checks
tests/fixtures/      safe synthetic test fixtures only
```

## Security Hygiene

`.gitignore` intentionally excludes real signing material and user apps:

- `*.p12`, `*.pfx`
- `*.mobileprovision`, `*.provisionprofile`
- `*.ipa`
- private keys and cert-like local files

Only synthetic fixtures should live in `tests/fixtures/`.

## Browser Limits

Browser-only mode cannot:

- run `ideviceinstaller`
- perform zsign's raw-socket live OCSP checks
- host a local HTTPS server that an iPhone can fetch from

Those actions should return clear unsupported behavior or be handled by a future
optional companion server.

See also:

- [docs/UPSTREAM.md](docs/UPSTREAM.md)
- [docs/WASM_BUILD.md](docs/WASM_BUILD.md)
