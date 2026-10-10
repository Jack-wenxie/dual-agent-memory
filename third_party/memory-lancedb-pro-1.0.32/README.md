# memory-lancedb-pro 1.0.32 (vendored subset)

The memory host imports `src/store.ts` from memory-lancedb-pro 1.0.32 by relative path (`lancedb-memory-host/memory-lancedb-pro/src/store.ts`). This directory records where that file comes from and exactly how our copy differs.

| Path | Content |
|---|---|
| `pristine/src/store.ts` | Byte-identical to `package/src/store.ts` in the npm tarball recorded in `PROVENANCE.json`. |
| `patches/0001-store.patch` | Unified diff from the pristine file to our `store.ts`. |
| `PROVENANCE.json` | Name, version, source, tarball size, sha1 and sha512 integrity, upstream tag and commit, declared license and author, file hashes. |
| `verify_upstream.py` | Rebuilds our `store.ts` from the pristine file plus the patch and compares bytes. With `--tarball`, it also checks the tarball integrity and that the pristine file equals the tarball entry. |

```
python third_party/memory-lancedb-pro-1.0.32/verify_upstream.py
python third_party/memory-lancedb-pro-1.0.32/verify_upstream.py --tarball memory-lancedb-pro-1.0.32.tgz
```

Only `src/store.ts` is shipped from the upstream package; its other files are not used by the host. `private-score-provenance.ts` next to it was added by this project.

## License

The upstream `package.json` declares the MIT license and the author win4r. Neither the 1.0.32 npm tarball nor the v1.0.32 tag contains a LICENSE file, so no upstream copyright line is reproduced here. See `THIRD_PARTY_NOTICES` at the repository root. Our changes and the added module are covered by this repository's license.
