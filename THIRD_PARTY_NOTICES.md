# Third-party notices

This repository is licensed under the [MIT License](LICENSE). It includes one file from another project and depends on packages that are installed separately.

## Included upstream source

| Item | Details |
|---|---|
| Project | memory-lancedb-pro 1.0.32 |
| Files | `third_party/memory-lancedb-pro-1.0.32/pristine/src/store.ts` (unmodified) and `lancedb-memory-host/memory-lancedb-pro/src/store.ts` (modified; the changes are in `third_party/memory-lancedb-pro-1.0.32/patches/0001-store.patch`) |
| Source | `https://registry.npmjs.org/memory-lancedb-pro/-/memory-lancedb-pro-1.0.32.tgz`; repository `https://github.com/CortexReach/memory-lancedb-pro`, tag `v1.0.32` |
| License | MIT, as declared in the package's `package.json` |
| Author | win4r, as declared in the package's `package.json` |

Neither the 1.0.32 package nor the `v1.0.32` tag contains a LICENSE file, so there is no upstream copyright line to reproduce. The MIT terms are in [LICENSES/MIT.txt](LICENSES/MIT.txt). Our modifications to `store.ts` are covered by this repository's license. Hashes and the verification procedure are in [third_party/memory-lancedb-pro-1.0.32/](third_party/memory-lancedb-pro-1.0.32/README.md).

## npm dependencies

Node dependencies are not included in this repository; npm installs them from the registry according to the committed lockfiles. The table summarises the `license` fields recorded in the two lockfiles. It counts the non-root package entries in each lockfile, including development dependencies and optional platform-specific entries, so it is not the number of packages installed on any particular machine.

| Lockfile | Entries | MIT | Apache-2.0 | ISC | BSD-3-Clause | BSD-2-Clause | 0BSD | No field |
|---|---|---|---|---|---|---|---|---|
| `lancedb-memory-host/package-lock.json` | 171 | 146 | 13 | 7 | 2 | 1 | 1 | 1 |
| `mqe/package-lock.json` | 95 | 85 | 0 | 7 | 2 | 1 | 0 | 0 |

The package without a `license` field is `json-bignum` 0.0.3, a dependency of `apache-arrow`. Its LICENSE file contains the MIT terms (copyright 2012-2013 Datalanche, Inc.).

These fields are declarations by the package authors, not a legal review, and this repository has not checked each package's license file. Before you redistribute any dependency, check its package metadata and license files.

## Python

`bti/` uses only the Python standard library. Its optional LanceDB ingestion needs the `lancedb` and `pandas` packages, which this repository does not install or include.

## Workflow actions

The workflow in `.github/workflows/` runs `actions/checkout`, `actions/setup-node` and `actions/setup-python`, pinned by commit, on GitHub's runners. They are not included in this repository.
