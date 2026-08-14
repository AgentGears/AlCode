# Phase 0.9 package digest profile

**Status:** normative Phase 0.9 implementation profile (`alcode-plugin-tree-v1`)

This profile implements the frozen package-generation invariant: two installed trees that may execute differently must not silently share a generation identity, and source mutation during staging must not publish a trusted mixed tree.

## Accepted tree entries

The v1 profile accepts only regular files and directories. Symlinks, junctions, Windows reparse points, sockets, devices, FIFOs, and other special entries are rejected. This intentionally chooses containment simplicity over preserving platform-specific link semantics.

Every relative path is normalized before staging/digesting:

- path separators become `/`;
- paths are Unicode NFC;
- empty, absolute, drive-qualified, UNC, `.` and `..` path segments are rejected;
- NUL is rejected;
- two entries whose normalized NFC paths collide after deterministic Unicode lowercase comparison are rejected, even on a case-sensitive filesystem;
- the normalized path must remain beneath the package root after resolution.

The case-collision rule deliberately over-rejects some Linux-only trees so a package accepted by the profile does not acquire a different identity solely because it is later staged on a case-insensitive host.

## Execution-relevant metadata

A canonical entry binds:

- normalized relative path;
- entry kind (`file` or `directory`);
- regular-file byte length and SHA-256 digest;
- a normalized executable-mode class when the host filesystem exposes meaningful POSIX execute bits.

Modification time, inode/file ID, ownership IDs, access time, and other incidental filesystem metadata are excluded. Directory entries are included so an explicitly material directory tree is deterministic; empty directories therefore participate in the digest.

When a host exposes materially different execution permission semantics, the resulting generation digest is allowed to differ: the invariant is execution-equivalent tree identity, not a promise that different execution semantics hash identically.

## Canonical tree framing

The tree digest is SHA-256 over UTF-8 canonical framing beginning with:

```text
ALCODE_PLUGIN_TREE_V1\0
```

followed by entries sorted by normalized path. Each entry is length-delimited rather than concatenated ambiguously. The implementation may choose the concrete binary framing, but the same canonicalizer must be used by staging, validation fixtures, generation lookup, and cross-platform tests. A canonicalizer version change mints a different profile/version; it must not silently reinterpret an existing digest.

## TOCTOU-safe staging

Activation never executes the mutable registration source. The Host stages under an ALCODE-owned temporary directory and performs this bounded protocol:

1. recursively `lstat`/hash the source into a pre-copy canonical manifest, rejecting unsupported/escaping/ambiguous entries;
2. copy only entries described by that manifest into the temporary staging root;
3. hash each staged file and require its bytes/metadata class to match the corresponding pre-copy manifest entry;
4. rescan the mutable source and require its canonical manifest to equal the pre-copy manifest;
5. validate `plugin.json`, component files, containment, and supported version against the staged bytes only;
6. compute the generation digest from the staged canonical manifest;
7. atomically publish the staged directory to the content-addressed generation location.

If any source/staged manifest differs, a path disappears/appears, an unsupported entry is encountered, or validation observes ambiguity, activation fails and a later attempt starts from a new observation. A source that mutates and returns to the exact same execution-equivalent manifest is not distinguishable from the same content and is safe for this identity purpose.

If the target content-addressed generation already exists, the Host verifies it against the same canonical profile before reuse; mismatch is corruption and fails closed.

## Installed generation and mutable data

`PLUGIN_ROOT` resolves to the published installed generation, never the mutable source. `PLUGIN_DATA` is outside the generation tree and is keyed by its independent opaque data-owner identity. Package digest identity never depends on `PLUGIN_DATA` bytes.

Temporary staging directories are Host-owned and cleaned after failure/success under bounded policy. Automatic destructive garbage collection of retained `PLUGIN_DATA` is outside Phase 0.9.

## Required fixtures

Blocking fixtures cover at least:

- path traversal/absolute path rejection;
- case-only and Unicode-normalization collisions;
- symlink/junction/reparse/special-entry rejection where the platform can create them;
- byte changes and execution-relevant metadata changes producing different identities;
- mtime-only changes not changing identity;
- source mutation during staging yielding one verified manifest or rejection, never a mixed trusted generation;
- deterministic behavior on Ubuntu and Windows.
