# Upstream zsign

This repository vendors `zhlynn/zsign` under `vendor/zsign`.

- Upstream: https://github.com/zhlynn/zsign
- Vendored commit: `28a6421`
- License: MIT, preserved at `vendor/zsign/LICENSE`

The vendored tree also contains zlib and minizip source under
`vendor/zsign/src/third-party/`. Their original copyright and distribution
notices are preserved in those source files. The browser runtime links
OpenSSL 3.5.7 under Apache-2.0; its complete license is copied to
`licenses/openssl-3.5.7.txt`. See `THIRD_PARTY_NOTICES.md` for the complete
project-level compliance index.

Local patches are intentionally small and browser-focused:

- Emscripten-safe file mapping in `src/common/fs.*`
- Browser unsupported stubs for raw-socket OCSP and `system()`
- Emscripten exclusion for the macOS-only `csreq` diagnostic `popen`
- `optind` reset before `main()` so repeated WASM invocations are deterministic
