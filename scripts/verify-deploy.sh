#!/usr/bin/env bash
# Compare a package as stored on Onyx with a local directory, file by file.
# Read-only: it only runs free queries (vm/qpkgmeta_json, vm/qfile).
#
#   scripts/verify-deploy.sh                     # the deployed realm against r/mandate
#   scripts/verify-deploy.sh <pkgpath> <dir>     # any package against a local folder
#
# It prints one line per file: "same", "DIFFERENT", "only on chain" or
# "only here", then the package's status (live or parked), and exits 1 if
# any file differs or is missing on either side.
#
# It never touches a key: gnokey is given an empty temporary keybase.
set -euo pipefail

REMOTE="https://rpc.onyx.testnets.gno.land:443"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PKG="${1:-$(sed -n 's/^module = "\(.*\)"$/\1/p' "$REPO/r/mandate/gnomod.toml")}"
DIR="${2:-$REPO/r/mandate}"
command -v gnokey >/dev/null || { echo "gnokey not found on PATH" >&2; exit 1; }
[ -d "$DIR" ] || { echo "no folder $DIR" >&2; exit 2; }
KB="$(mktemp -d)"
TMP="$(mktemp -d)"
trap 'rm -rf "$KB" "$TMP"' EXIT
q() { gnokey query "$1" -data "$2" -remote "$REMOTE" -home "$KB"; }

meta="$(q vm/qpkgmeta_json "$PKG" | sed -n 's/^data: //p')"
echo "package: $PKG"
echo "status:  $meta"
listing="$(q vm/qfile "$PKG" 2>&1)" || { echo "could not list the package on chain: $listing" >&2; exit 1; }
mapfile -t onchain < <(printf '%s\n' "$listing" | sed -n '/^data: /,$p' | sed 's/^data: //' | grep -v '^$')
bad=0
declare -A seen=()
for f in "${onchain[@]}"; do
	local_file="$(cd "$DIR" && find . -type f -name "$(basename "$f")" | head -1)"
	seen[$(basename "$f")]=1
	if [ -z "$local_file" ]; then
		echo "only on chain  $f"
		bad=1
		continue
	fi
	q vm/qfile "$PKG/$f" | sed -n '/^data: /,$p' | sed '1s/^data: //' >"$TMP/chain"
	# gnokey prints the body followed by a newline; compare without trailing
	# blank lines. The chain adds an [addpkg] section (the creator) to
	# gnomod.toml on upload: that section is left out of the comparison.
	norm() { if [ "$2" = gnomod.toml ]; then sed '/^\[addpkg\]/,$d' "$1"; else cat "$1"; fi | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}'; }
	if cmp -s <(norm "$TMP/chain" "$(basename "$f")") <(norm "$DIR/$local_file" "$(basename "$f")"); then
		echo "same           $f"
	else
		echo "DIFFERENT      $f"
		bad=1
	fi
done
while IFS= read -r f; do
	b="$(basename "$f")"
	[ -n "${seen[$b]:-}" ] || { echo "only here      $b"; bad=1; }
done < <(cd "$DIR" && find . -type f \( -name '*.gno' -o -name 'gnomod.toml' \))
if [ "$bad" = 0 ]; then echo "OK: the package on chain is identical to $DIR"; else echo "MISMATCH" >&2; exit 1; fi
