"""Verify the vendored memory-lancedb-pro 1.0.32 subset.

The provenance record must match this release exactly before any file is read: schema, name and version; exactly one
vendored file (src/store.ts) and exactly one module added by this project, at fixed relative paths, with well-formed
hashes. A missing, empty, duplicated or redirected entry is refused.

Offline checks (default):
  1. pristine/src/store.ts has the recorded sha256;
  2. pristine/src/store.ts plus patches/0001-store.patch equals lancedb-memory-host/memory-lancedb-pro/src/store.ts
     byte for byte;
  3. the module added by this project has the recorded sha256.
With --tarball PATH (the npm tarball of memory-lancedb-pro 1.0.32) it also checks the tarball's sha512 integrity and
that the pristine file equals package/src/store.ts inside it. Nothing is extracted to disk.

Usage: python third_party/memory-lancedb-pro-1.0.32/verify_upstream.py [--tarball memory-lancedb-pro-1.0.32.tgz]
Exit status: 0 every check passed; 1 a check failed; 2 the provenance record or a required file is invalid.
"""
import argparse
import base64
import hashlib
import json
import re
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX40 = re.compile(r"^[0-9a-f]{40}$")
INTEGRITY = re.compile(r"^sha512-[A-Za-z0-9+/]{86}==$")
UP = "third_party/memory-lancedb-pro-1.0.32"
RELEASE = {"schema": "dual-agent-memory-third-party/v1", "name": "memory-lancedb-pro", "version": "1.0.32"}
VENDORED = {"upstream_path": "package/src/store.ts",
            "pristine_path": f"{UP}/pristine/src/store.ts",
            "patch_path": f"{UP}/patches/0001-store.patch",
            "public_path": "lancedb-memory-host/memory-lancedb-pro/src/store.ts"}
VENDORED_HASHES = ("pristine_sha256", "patch_sha256", "public_sha256")
ADDED = "lancedb-memory-host/memory-lancedb-pro/src/private-score-provenance.ts"


class ContractError(Exception):
    """The provenance record or a required file does not match this release."""


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def apply_unified_patch(original: bytes, patch: bytes) -> bytes:
    """Apply a single-file unified diff strictly: every context and removed line must match exactly."""
    text = original.decode("utf-8")
    if not text.endswith("\n"):
        raise ValueError("the original file must end with a newline")
    old = text.split("\n")[:-1]
    lines = patch.decode("utf-8").split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    i = 0
    while i < len(lines) and not lines[i].startswith("@@"):
        if not lines[i].startswith(("--- ", "+++ ")):
            raise ValueError(f"unexpected header line {i + 1}")
        i += 1
    out, pos = [], 0
    while i < len(lines):
        match = HUNK.match(lines[i])
        if not match:
            raise ValueError(f"bad hunk header at patch line {i + 1}")
        old_start, old_len = int(match.group(1)), int(match.group(2) or 1)
        new_len = int(match.group(4) or 1)
        start = old_start - 1 if old_len else old_start
        if start < pos or start > len(old):
            raise ValueError("hunks overlap or are out of order")
        out.extend(old[pos:start])
        pos = start
        i += 1
        seen_old = seen_new = 0
        while i < len(lines) and not lines[i].startswith("@@"):
            tag, body = lines[i][:1], lines[i][1:]
            if tag in (" ", "-"):
                if pos >= len(old) or old[pos] != body:
                    raise ValueError(f"patch does not apply at original line {pos + 1}")
                pos += 1
                seen_old += 1
                if tag == " ":
                    out.append(body)
                    seen_new += 1
            elif tag == "+":
                out.append(body)
                seen_new += 1
            elif tag == "\\":
                raise ValueError("files without a final newline are not supported")
            else:
                raise ValueError(f"bad patch line {i + 1}")
            i += 1
        if seen_old != old_len or seen_new != new_len:
            raise ValueError("hunk length does not match its header")
    out.extend(old[pos:])
    return ("\n".join(out) + "\n").encode("utf-8")


def check_contract(provenance):
    """Return (vendored entry, added entry) or raise ContractError. Reads no payload file."""
    if not isinstance(provenance, dict):
        raise ContractError("PROVENANCE_NOT_OBJECT")
    for key, value in RELEASE.items():
        if provenance.get(key) != value:
            raise ContractError(f"{key.upper()}_MISMATCH")
    tarball = provenance.get("tarball")
    if not (isinstance(tarball, dict) and type(tarball.get("bytes")) is int and tarball["bytes"] > 0
            and isinstance(tarball.get("sha1"), str) and HEX40.match(tarball["sha1"])
            and isinstance(tarball.get("integrity"), str) and INTEGRITY.match(tarball["integrity"])):
        raise ContractError("TARBALL_RECORD_INVALID")
    vendored = provenance.get("vendored")
    if not isinstance(vendored, list) or len(vendored) != 1:
        raise ContractError("VENDORED_MUST_BE_EXACTLY_ONE")
    item = vendored[0]
    if not isinstance(item, dict) or set(item) != set(VENDORED) | set(VENDORED_HASHES):
        raise ContractError("VENDORED_FIELDS")
    for key, value in VENDORED.items():
        if item[key] != value:
            raise ContractError(f"VENDORED_{key.upper()}_MISMATCH")
    for key in VENDORED_HASHES:
        if not (isinstance(item[key], str) and HEX64.match(item[key])):
            raise ContractError(f"VENDORED_{key.upper()}_INVALID")
    added = provenance.get("added_by_this_project")
    if not isinstance(added, list) or len(added) != 1:
        raise ContractError("ADDED_MUST_BE_EXACTLY_ONE")
    entry = added[0]
    if not (isinstance(entry, dict) and set(entry) == {"path", "sha256"} and entry["path"] == ADDED
            and isinstance(entry["sha256"], str) and HEX64.match(entry["sha256"])):
        raise ContractError("ADDED_RECORD_INVALID")
    return item, entry


def read_required(relative: str) -> bytes:
    path = ROOT / relative
    if path.is_symlink() or not path.is_file():
        raise ContractError(f"REQUIRED_FILE_MISSING:{relative}")
    return path.read_bytes()


def all_true(value) -> bool:
    if isinstance(value, dict):
        return bool(value) and all(all_true(v) for v in value.values())
    return value is True


def verify(tarball_path=None) -> dict:
    try:
        provenance = json.loads((HERE / "PROVENANCE.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ContractError("PROVENANCE_UNREADABLE") from None
    item, entry = check_contract(provenance)
    pristine = read_required(item["pristine_path"])
    patch = read_required(item["patch_path"])
    public = read_required(item["public_path"])
    added = read_required(entry["path"])
    try:
        rebuilt = apply_unified_patch(pristine, patch) == public
    except (ValueError, UnicodeDecodeError):
        rebuilt = False
    checks = {
        "store": {"pristine_sha256": sha256(pristine) == item["pristine_sha256"],
                  "patch_sha256": sha256(patch) == item["patch_sha256"],
                  "public_sha256": sha256(public) == item["public_sha256"],
                  "pristine_plus_patch_equals_public": rebuilt},
        "added_module": {"sha256": sha256(added) == entry["sha256"]},
    }
    if tarball_path is not None:
        try:
            data = tarball_path.read_bytes()
        except OSError:
            raise ContractError("TARBALL_UNREADABLE") from None
        digest = provenance["tarball"]["integrity"].split("-", 1)[1]
        integrity = base64.b64encode(hashlib.sha512(data).digest()).decode("ascii") == digest
        try:
            with tarfile.open(tarball_path, "r:gz") as tar:
                member = tar.getmember(item["upstream_path"])
                handle = tar.extractfile(member) if member.isfile() else None
                entry_equal = handle is not None and handle.read() == pristine
        except (KeyError, tarfile.TarError, OSError):
            entry_equal = False
        checks["tarball"] = {"sha512_integrity": integrity, "entry_equals_pristine": entry_equal}
    expected = {"store", "added_module"} | ({"tarball"} if tarball_path is not None else set())
    if set(checks) != expected:
        raise ContractError("CHECKS_INCOMPLETE")
    return checks


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Verify the vendored memory-lancedb-pro subset.")
    parser.add_argument("--tarball", type=Path, help="npm tarball of memory-lancedb-pro 1.0.32")
    args = parser.parse_args(argv)
    try:
        checks = verify(args.tarball)
    except ContractError as error:
        print(json.dumps({"ok": False, "error": str(error)}, indent=1))
        return 2
    ok = all_true(checks)
    print(json.dumps({"ok": ok, "checks": checks}, indent=1))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
