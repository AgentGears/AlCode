# Third-Party Notices

This project incorporates code from the following third-party projects. Their
copyright and license notices are preserved here as required. "Full ownership"
of ALCODE means ownership of maintenance and product direction, not removal of
third-party copyright or license notices.

## pi (earendil-works/pi-mono)

- **Source:** https://github.com/earendil-works/pi-mono
- **License:** MIT
- **Copyright:** © 2025 Mario Zechner
- **Use:** Selected source (agent loop, provider layer, tools, extension
  system) imported and converted into owned ALCODE infrastructure.
- **Provenance record:** `docs/provenance/pi.md`

## Planned imports (Phase 0.3 / 0.4 / 0.8)

The following are intended as references or ports. Records will be added to
`docs/provenance/` at import time.

- **Ola** (Node/JS, MIT-style internal) — memory semantic core, ported JS→TS.
- **Ouroboros** (Python) — reasoning semantic core, ported Py→TS.
- **open-harness** (MIT) — GUI streaming layer (`ui-stream.ts`, React provider).
- **codebase-memory-mcp** (MIT, pure C) — code intelligence (optional, Phase 0.9).

## Reference-only (patterns borrowed, code not imported)

- **qwen-code** (Apache-2.0) — hooks layer, auto-skill minting pattern.
- **kimi-code** (MIT) — MCP client, ACP adapter.
- **oh-my-pi** (MIT) — plugin marketplace pattern.

Each imported codebase gets a provenance record (repo, commit, license,
imported files, modifications, attribution) at `docs/provenance/<name>.md`.
