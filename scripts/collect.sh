#!/usr/bin/env bash
# Mandate collector: pull every payment that is due for one collector key.
#
#   scripts/collect.sh -home <keybase dir> -key <collector key name> \
#       -remote <rpc url> -chainid <chain id> -realm <realm path> [-dry-run]
#
# It reads, through free queries, the mandates of every payer who gave a
# session to this key (CollectorList in the realm), and for each one that is
# due runs:
#
#   gnokey maketx call -pkgpath <realm> -func Pull -send <amount>ugnot \
#       -master <payer> -gas-fee 20000ugnot -gas-wanted 20000000 ... <key>
#
# With -dry-run it only prints what it would pull. Run it from cron or a
# loop at least once per period.
#
# Safety:
#   - Nothing has a default: -home, -remote and -chainid are required, so it
#     never falls back to gnokey's default key folder or to a node on this
#     machine by accident.
#   - Chain ids: only "dev" (a local gnodev chain, with a 127.0.0.1 or
#     localhost remote) and "onyx-1" (with the Onyx RPC) are accepted.
#   - The key is only ever used by gnokey itself. Its password is read once
#     from stdin when -insecure-password-stdin is given (for scripts and
#     tests); otherwise gnokey asks for it for each pull.
#   - The fee counts against the payer's fee allowance (the session's spend
#     limit is the price plus a small allowance), so keep it small.
#
# Why a shell script and not a Go program: gnokey already does key storage,
# signing and broadcasting with sessions (-master). A Go collector would have
# to depend on the whole gno module to do the same, and would be one more
# program holding the key. This script is short enough to read in full
# before you trust it with a key.
set -euo pipefail

usage() {
	sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//' >&2
	exit 2
}

HOME_DIR="" KEY="" REMOTE="" CHAIN="" REALM="" DRY=0 PWSTDIN=0
GAS_FEE="20000ugnot" GAS_WANTED="20000000"
while [ $# -gt 0 ]; do
	case "$1" in
	-home) HOME_DIR="${2:-}"; shift 2 ;;
	-key) KEY="${2:-}"; shift 2 ;;
	-remote) REMOTE="${2:-}"; shift 2 ;;
	-chainid) CHAIN="${2:-}"; shift 2 ;;
	-realm) REALM="${2:-}"; shift 2 ;;
	-gas-fee) GAS_FEE="${2:-}"; shift 2 ;;
	-gas-wanted) GAS_WANTED="${2:-}"; shift 2 ;;
	-dry-run) DRY=1; shift ;;
	-insecure-password-stdin) PWSTDIN=1; shift ;;
	-h | -help | --help) usage ;;
	*) echo "unknown argument: $1" >&2; usage ;;
	esac
done

for v in HOME_DIR KEY REMOTE CHAIN REALM; do
	if [ -z "${!v}" ]; then
		echo "missing -$(echo "$v" | tr 'A-Z_' 'a-z-' | sed 's/home-dir/home/;s/chain/chainid/'): every option is required, nothing has a default" >&2
		exit 2
	fi
done
case "$CHAIN" in
dev)
	case "$REMOTE" in
	127.0.0.1:* | localhost:* | http://127.0.0.1:* | http://localhost:*) ;;
	*) echo "refusing: chain id dev is only for a local node (127.0.0.1 or localhost), not $REMOTE" >&2; exit 2 ;;
	esac
	;;
onyx-1)
	if [ "$REMOTE" != "https://rpc.onyx.testnets.gno.land:443" ]; then
		echo "refusing: for onyx-1 use -remote https://rpc.onyx.testnets.gno.land:443" >&2
		exit 2
	fi
	;;
*)
	echo "refusing: chain id must be dev (local) or onyx-1 (test network), not '$CHAIN'" >&2
	exit 2
	;;
esac
if ! [[ "$REALM" =~ ^gno\.land/r/[a-z0-9_]+(/[a-z0-9_]+)*$ ]]; then
	echo "not a realm path: $REALM" >&2
	exit 2
fi
if [ ! -d "$HOME_DIR" ]; then
	echo "no keybase folder at -home $HOME_DIR" >&2
	exit 2
fi
if ! [[ "$GAS_FEE" =~ ^[0-9]+ugnot$ && "$GAS_WANTED" =~ ^[0-9]+$ ]]; then
	echo "bad -gas-fee or -gas-wanted" >&2
	exit 2
fi
command -v gnokey >/dev/null || { echo "gnokey not found on PATH" >&2; exit 1; }

PW=""
if [ "$PWSTDIN" = 1 ]; then
	IFS= read -r PW || true
fi

# The collector key's address, from the keybase (no network).
ADDR="$(gnokey list -home "$HOME_DIR" | awk -v k="$KEY" '$2 == k { for (i = 1; i <= NF; i++) if ($i == "addr:") print $(i + 1) }')"
if ! [[ "$ADDR" =~ ^g1[a-z0-9]{38}$ ]]; then
	echo "no key named '$KEY' in $HOME_DIR" >&2
	exit 2
fi
echo "collector key $KEY ($ADDR) on $CHAIN via $REMOTE"

# list prints the due mandates of one page as "<id> <payer> <amount>", and
# "more" when another page follows.
list_page() {
	local out data
	out="$(gnokey query vm/qeval -data "$REALM.CollectorList(address(\"$ADDR\"), $1)" -remote "$REMOTE" -home "$HOME_DIR" 2>&1)" || {
		echo "query failed: $out" >&2
		return 1
	}
	# data: ("<lines with \n>" string)
	data="$(printf '%s\n' "$out" | sed -n 's/^data: ("\(.*\)" string)$/\1/p')"
	if [ -z "$data" ]; then
		echo "unexpected query output: $out" >&2
		return 1
	fi
	printf '%b' "$data"
}

due=() seen=0 page=1
while :; do
	lines="$(list_page "$page")"
	more=0
	while IFS=' ' read -r id payer amount next status when; do
		case "$id" in
		"") continue ;;
		more) more=1; continue ;;
		end) continue ;;
		esac
		if ! [[ "$id" =~ ^[0-9]+$ && "$payer" =~ ^g1[a-z0-9]{38}$ && "$amount" =~ ^[0-9]+$ && "$next" =~ ^[0-9]+$ ]]; then
			echo "unexpected line from the realm: $id $payer $amount $next $status $when" >&2
			exit 1
		fi
		seen=$((seen + 1))
		if [ "$status" = active ] && [ "$when" = due ]; then
			due+=("$id $payer $amount")
		else
			echo "  mandate $id from $payer: $status, $when (next pull from $next)"
		fi
	done <<<"$lines"
	[ "$more" = 1 ] || break
	page=$((page + 1))
done
echo "$seen mandates, ${#due[@]} due"

failed=0
for row in "${due[@]+"${due[@]}"}"; do
	read -r id payer amount <<<"$row"
	if [ "$DRY" = 1 ]; then
		echo "  would pull mandate $id: ${amount}ugnot from $payer"
		continue
	fi
	echo "  pulling mandate $id: ${amount}ugnot from $payer"
	args=(maketx call -pkgpath "$REALM" -func Pull -send "${amount}ugnot" -master "$payer"
		-gas-fee "$GAS_FEE" -gas-wanted "$GAS_WANTED" -broadcast -chainid "$CHAIN" -remote "$REMOTE" -home "$HOME_DIR")
	if [ "$PWSTDIN" = 1 ]; then
		if out="$(printf '%s\n' "$PW" | gnokey "${args[@]}" -insecure-password-stdin "$KEY" 2>&1)"; then :; else :; fi
	else
		if out="$(gnokey "${args[@]}" "$KEY" 2>&1)"; then :; else :; fi
	fi
	if printf '%s\n' "$out" | grep -q '^OK!'; then
		printf '%s\n' "$out" | grep -E '^(GAS USED|STORAGE DELTA|TX HASH):' | sed 's/^/    /'
	else
		failed=$((failed + 1))
		echo "    FAILED: $(printf '%s\n' "$out" | grep -E '^Data:|panic:' | head -2 | tr '\n' ' ')"
	fi
done
if [ "$failed" -gt 0 ]; then
	echo "$failed pulls failed" >&2
	exit 1
fi
