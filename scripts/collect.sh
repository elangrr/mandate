#!/usr/bin/env bash
# Mandate collector: pull every payment that is due for one collector key.
#
#   scripts/collect.sh -home <keybase dir> -key <collector key name> \
#       -payee <payee address> -remote <rpc url> -chainid <chain id> \
#       -realm <realm path> [-dry-run] [-state <file>] \
#       [-max-checks 100] [-max-pulls 200]
#
# What a run does, all reads being free queries:
#   1. lists the payee's plans (CollectorPlans) and, for each, walks its
#      supporter list in windows of 200 (CollectorScan), keeping only active
#      mandates given to this key;
#   2. pulls every due mandate that has paid before (its session existed);
#   3. for due mandates that have never paid, first asks the chain whether
#      the payer really gave this key a session
#      (auth/accounts/<payer>/session/<key>). Anyone can record a mandate
#      without creating a session, so these may be junk. At most -max-checks
#      such checks per run: the never-checked first, newest first, then the
#      ones that had no session, oldest check first. With -state, results are
#      kept between runs, so a run continues where the last one stopped and
#      junk cannot keep a real new supporter waiting for ever.
#   4. pulls at most -max-pulls mandates per run.
#
# Run it from cron or a loop at least once per period.
#
# Safety:
#   - Nothing has a default: -home, -remote, -chainid, -realm and -payee are
#     required, so it never falls back to gnokey's default key folder or to a
#     node on this machine by accident.
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
	sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//' >&2
	exit 2
}

HOME_DIR="" KEY="" REMOTE="" CHAIN="" REALM="" PAYEE="" STATE="" DRY=0 PWSTDIN=0
GAS_FEE="20000ugnot" GAS_WANTED="20000000" MAX_CHECKS=100 MAX_PULLS=200
while [ $# -gt 0 ]; do
	case "$1" in
	-home) HOME_DIR="${2:-}"; shift 2 ;;
	-key) KEY="${2:-}"; shift 2 ;;
	-payee) PAYEE="${2:-}"; shift 2 ;;
	-remote) REMOTE="${2:-}"; shift 2 ;;
	-chainid) CHAIN="${2:-}"; shift 2 ;;
	-realm) REALM="${2:-}"; shift 2 ;;
	-state) STATE="${2:-}"; shift 2 ;;
	-max-checks) MAX_CHECKS="${2:-}"; shift 2 ;;
	-max-pulls) MAX_PULLS="${2:-}"; shift 2 ;;
	-gas-fee) GAS_FEE="${2:-}"; shift 2 ;;
	-gas-wanted) GAS_WANTED="${2:-}"; shift 2 ;;
	-dry-run) DRY=1; shift ;;
	-insecure-password-stdin) PWSTDIN=1; shift ;;
	-h | -help | --help) usage ;;
	*) echo "unknown argument: $1" >&2; usage ;;
	esac
done

for pair in "home:$HOME_DIR" "key:$KEY" "payee:$PAYEE" "remote:$REMOTE" "chainid:$CHAIN" "realm:$REALM"; do
	if [ -z "${pair#*:}" ]; then
		echo "missing -${pair%%:*}: every option is required, nothing has a default" >&2
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
if ! [[ "$REALM" =~ ^gno\.land/r/[a-z0-9_]+(/[a-z0-9_]+)*$ ]]; then echo "not a realm path: $REALM" >&2; exit 2; fi
if ! [[ "$PAYEE" =~ ^g1[02-9ac-hj-np-z]{38}$ ]]; then echo "not an address: $PAYEE" >&2; exit 2; fi
if [ ! -d "$HOME_DIR" ]; then echo "no keybase folder at -home $HOME_DIR" >&2; exit 2; fi
if ! [[ "$GAS_FEE" =~ ^[0-9]+ugnot$ && "$GAS_WANTED" =~ ^[0-9]+$ && "$MAX_CHECKS" =~ ^[0-9]+$ && "$MAX_PULLS" =~ ^[0-9]+$ ]]; then
	echo "bad -gas-fee, -gas-wanted, -max-checks or -max-pulls" >&2
	exit 2
fi
command -v gnokey >/dev/null || { echo "gnokey not found on PATH" >&2; exit 1; }

PW=""
if [ "$PWSTDIN" = 1 ]; then IFS= read -r PW || true; fi

ADDR="$(gnokey list -home "$HOME_DIR" | awk -v k="$KEY" '$2 == k { for (i = 1; i <= NF; i++) if ($i == "addr:") print $(i + 1) }')"
if ! [[ "$ADDR" =~ ^g1[a-z0-9]{38}$ ]]; then echo "no key named '$KEY' in $HOME_DIR" >&2; exit 2; fi
echo "collector key $KEY ($ADDR) for payee $PAYEE on $CHAIN via $REMOTE"

# qtext <expr>: a realm function returning a string, printed with real newlines.
# Runs in a subshell, so it counts queries in a file.
QCOUNT="$(mktemp)"
trap 'rm -f "$QCOUNT"' EXIT
qtext() {
	local out data
	echo >>"$QCOUNT"
	out="$(gnokey query vm/qeval -data "$REALM.$1" -remote "$REMOTE" -home "$HOME_DIR" 2>&1)" || { echo "query failed: $out" >&2; return 1; }
	data="$(printf '%s\n' "$out" | sed -n 's/^data: ("\(.*\)" string)$/\1/p')"
	if [ -z "$data" ]; then echo "unexpected query output: $out" >&2; return 1; fi
	printf '%b' "$data"
}

# 1. plans, then each plan's supporter list in windows
PLANS=()
page=1
while :; do
	more=0
	while read -r id rest; do
		case "$id" in "" | end) ;; more) more=1 ;; *) [[ "$id" =~ ^[0-9]+$ ]] && PLANS+=("$id") ;; esac
	done <<<"$(qtext "CollectorPlans(address(\"$PAYEE\"), $page)")"
	[ "$more" = 1 ] || break
	page=$((page + 1))
done

PROVEN=() UNPROVEN=() listed=0 waiting=0
for plan in "${PLANS[@]+"${PLANS[@]}"}"; do
	from=0
	while :; do
		next=""
		while read -r idx id payer amount nextpull due pulls; do
			case "$idx" in
			"" | end) continue ;;
			next) next="$id"; continue ;;
			esac
			if ! [[ "$idx" =~ ^[0-9]+$ && "$id" =~ ^[0-9]+$ && "$payer" =~ ^g1[a-z0-9]{38}$ && "$amount" =~ ^[0-9]+$ && "$pulls" =~ ^[0-9]+$ ]]; then
				echo "unexpected line from the realm: $idx $id $payer $amount $nextpull $due $pulls" >&2
				exit 1
			fi
			listed=$((listed + 1))
			if [ "$due" != due ]; then waiting=$((waiting + 1)); continue; fi
			if [ "$pulls" -gt 0 ]; then PROVEN+=("$id $payer $amount"); else UNPROVEN+=("$id $payer $amount"); fi
		done <<<"$(qtext "CollectorScan($plan, address(\"$ADDR\"), $from)")"
		[ -n "$next" ] || break
		from="$next"
	done
done
echo "${#PLANS[@]} plans, $listed active mandates for this key ($waiting not due), ${#PROVEN[@]} due that paid before, ${#UNPROVEN[@]} due that never paid ($(wc -l <"$QCOUNT") realm queries)"

# 3. order the never-paid ones: never checked first (newest first), then by oldest check
NOW="$(date +%s)"
declare -A LAST=()
if [ -n "$STATE" ] && [ -f "$STATE" ]; then
	while read -r sid st; do [[ "$sid" =~ ^[0-9]+$ && "$st" =~ ^[0-9]+$ ]] && LAST[$sid]=$st; done <"$STATE"
fi
ORDERED=()
if [ "${#UNPROVEN[@]}" -gt 0 ]; then
	mapfile -t ORDERED < <(for row in "${UNPROVEN[@]}"; do
		read -r id _ <<<"$row"
		printf '%s %s\n' "${LAST[$id]:-0}" "$row"
	done | sort -k1,1n -k2,2nr | cut -d' ' -f2-)
fi

TODO=("${PROVEN[@]+"${PROVEN[@]}"}")
checks=0 nosession=0 deferred=0
for row in "${ORDERED[@]+"${ORDERED[@]}"}"; do
	read -r id payer amount <<<"$row"
	if [ "$checks" -ge "$MAX_CHECKS" ]; then deferred=$((deferred + 1)); continue; fi
	checks=$((checks + 1))
	LAST[$id]=$NOW
	if gnokey query "auth/accounts/$payer/session/$ADDR" -remote "$REMOTE" -home "$HOME_DIR" >/dev/null 2>&1; then
		TODO+=("$row")
	else
		nosession=$((nosession + 1))
	fi
done
echo "checked $checks never-paid mandates on chain: $nosession without a session (skipped), $deferred left for later runs"
if [ -n "$STATE" ]; then
	tmp="$STATE.tmp.$$"
	for k in "${!LAST[@]}"; do printf '%s %s\n' "$k" "${LAST[$k]}"; done >"$tmp" && mv "$tmp" "$STATE"
fi

# 2 and 4. pull
failed=0 pulled=0 skipped=0
for row in "${TODO[@]+"${TODO[@]}"}"; do
	read -r id payer amount <<<"$row"
	if [ "$pulled" -ge "$MAX_PULLS" ]; then skipped=$((skipped + 1)); continue; fi
	if [ "$DRY" = 1 ]; then
		echo "  would pull mandate $id: ${amount}ugnot from $payer"
		pulled=$((pulled + 1))
		continue
	fi
	echo "  pulling mandate $id: ${amount}ugnot from $payer"
	args=(maketx call -pkgpath "$REALM" -func Pull -send "${amount}ugnot" -master "$payer"
		-gas-fee "$GAS_FEE" -gas-wanted "$GAS_WANTED" -broadcast -chainid "$CHAIN" -remote "$REMOTE" -home "$HOME_DIR")
	if [ "$PWSTDIN" = 1 ]; then
		out="$(printf '%s\n' "$PW" | gnokey "${args[@]}" -insecure-password-stdin "$KEY" 2>&1)" || true
	else
		out="$(gnokey "${args[@]}" "$KEY" 2>&1)" || true
	fi
	pulled=$((pulled + 1))
	if printf '%s\n' "$out" | grep -q '^OK!'; then
		printf '%s\n' "$out" | grep -E '^(GAS USED|STORAGE DELTA|TX HASH):' | sed 's/^/    /'
	else
		failed=$((failed + 1))
		echo "    FAILED: $(printf '%s\n' "$out" | grep -E '^Data:|panic:' | head -2 | tr '\n' ' ')"
	fi
done
[ "$skipped" -gt 0 ] && echo "$skipped due mandates left for the next run (-max-pulls $MAX_PULLS)"
if [ "$failed" -gt 0 ]; then
	echo "$failed pulls failed" >&2
	exit 1
fi
