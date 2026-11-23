#!/usr/bin/env bash
# Mandate collector: pull every payment that is due for one collector key.
#
#   scripts/collect.sh -home <keybase dir> -key <collector key name> \
#       -payee <payee address> -remote <rpc url> -chainid <chain id> \
#       -realm <realm path> [-dry-run] [-state <file>] \
#       [-max-checks 500] [-max-pulls 200]
#
# What a run does, all reads being free queries:
#   1. lists the payee's plans (CollectorPlans) and, for each, walks its
#      supporter list in windows of 200 (CollectorScan), keeping only active
#      mandates given to this key that are due;
#   2. reads each due mandate's session from the chain
#      (auth/accounts/<payer>/session/<key>) and skips, with the reason, a
#      mandate whose session is missing (never created, revoked or expired),
#      is not scoped to exactly vm/exec:<realm>, has a spend limit below the
#      price plus what a pull can cost the payer (the fee plus the storage
#      deposit of a first pull at the chain's storage price), has already
#      spent its budget for the current spend period, or expires within a
#      minute. Anyone can record a mandate without a session, so never-paid
#      mandates may be junk: at most -max-checks of them are read per run,
#      never-read first (newest first), then oldest read first. The default,
#      500, takes about a minute and a half per run; an attacker must record
#      more than 500 new never-paid mandates (about 265 GNOT of deposits)
#      before every run to keep a real first payment waiting, so run the
#      collector often (every 10 minutes, say) rather than lowering it;
#   3. pulls at most -max-pulls mandates. A pull that was included in a
#      block and failed charged the payer the fee: it is remembered and not
#      tried again before the plan's next period. A pull that never reached
#      a block (refused in gnokey's simulation or by the mempool, a network
#      error, a timeout) cost nothing and is tried again on the next run.
#      -simulate skip (for tests only) sends without gnokey's simulation.
#
# With -state <file>, what a run learned is kept for the next one (the file
# only holds mandates still listed, so it does not grow). It is replaced
# atomically through a private temporary file next to it.
#
# Exit status: 0 when every due mandate was pulled or skipped for a reason
# on the payer's side (a revoked session is not an error), 1 when a pull
# failed for another reason or a read failed, 2 for bad arguments.
#
# Needs gnokey (v1.8.0) and python3.
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
GAS_FEE="20000ugnot" GAS_WANTED="20000000" MAX_CHECKS=500 MAX_PULLS=200 SIMULATE=test
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
	-simulate) SIMULATE="${2:-}"; shift 2 ;;
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
if ! [[ "$GAS_FEE" =~ ^[0-9]+ugnot$ && "$GAS_WANTED" =~ ^[0-9]+$ && "$MAX_CHECKS" =~ ^[0-9]+$ && "$MAX_PULLS" =~ ^[0-9]+$ && "$SIMULATE" =~ ^(test|skip)$ ]]; then
	echo "bad -gas-fee, -gas-wanted, -max-checks, -max-pulls or -simulate" >&2
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
TMPFILES=("$QCOUNT")
trap 'rm -f "${TMPFILES[@]}"' EXIT
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
declare -A PERIOD=()
page=1
while :; do
	more=0
	while read -r id rest; do
		case "$id" in "" | end) ;; more) more=1 ;; *)
			read -r _ period _ <<<"$rest"
			[[ "$id" =~ ^[0-9]+$ && "$period" =~ ^[0-9]+$ ]] && PLANS+=("$id") PERIOD[$id]=$period ;;
		esac
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
			if [ "$pulls" -gt 0 ]; then PROVEN+=("$id $payer $amount ${PERIOD[$plan]}"); else UNPROVEN+=("$id $payer $amount ${PERIOD[$plan]}"); fi
		done <<<"$(qtext "CollectorScan($plan, address(\"$ADDR\"), $from)")"
		[ -n "$next" ] || break
		from="$next"
	done
done
echo "${#PLANS[@]} plans, $listed active mandates for this key ($waiting not due), ${#PROVEN[@]} due that paid before, ${#UNPROVEN[@]} due that never paid ($(wc -l <"$QCOUNT") realm queries)"

# Each due mandate's session, read from the chain (free). Prints one word:
# ok, or the reason to skip it: no-session, scope, limit, budget, expired.
# The realm checks the scope again in Pull; the chain checks the rest. A
# skip costs the payer nothing, a refused pull can cost them the fee.
session_check() { # <payer> <amount>
	local out
	out="$(gnokey query "auth/accounts/$1/session/$ADDR" -remote "$REMOTE" -home "$HOME_DIR" 2>&1)" || {
		if grep -q SessionNotFound <<<"$out"; then echo no-session; else echo "query-failed"; fi
		return 0
	}
	printf '%s\n' "$out" | python3 -c '
import json, sys
realm, need, now = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
d = json.loads(sys.stdin.read().split("data:", 1)[1])
s = d.get("BaseSessionAccount", d)
def ugnot(c):
    total = 0
    for part in (c or "").split(","):
        if part.endswith("ugnot") and part[:-5].isdigit():
            total += int(part[:-5])
    return total
exp, period, reset = int(s.get("expires_at") or 0), int(s.get("spend_period") or 0), int(s.get("spend_reset") or 0)
limit, used = ugnot(s.get("spend_limit")), ugnot(s.get("spend_used"))
if d.get("allow_paths") != ["vm/exec:" + realm]:
    print("scope")
elif exp and now + 60 >= exp:
    print("expired")
elif limit < need:
    print("limit")
elif (period == 0 or now < reset + period) and limit - used < need:
    print("budget")
else:
    print("ok")
' "$REALM" "$(($2 + PULL_COST))" "$NOW" 2>/dev/null || echo "query-failed"
}

# What one pull can cost the payer on top of the amount: the fee, plus the
# storage deposit of a first pull (the realm keeps it under STORAGE_BOUND
# bytes), priced at the chain's storage price.
PRICE_OUT="$(gnokey query params/vm:p:storage_price -remote "$REMOTE" -home "$HOME_DIR" 2>&1)" || { echo "could not read the storage price: $PRICE_OUT" >&2; exit 1; }
STORAGE_PRICE="$(sed -n 's/^data: "\([0-9]*\)ugnot"$/\1/p' <<<"$PRICE_OUT")"
[[ "$STORAGE_PRICE" =~ ^[0-9]+$ ]] || { echo "unexpected storage price: $PRICE_OUT" >&2; exit 1; }
STORAGE_BOUND=100
PULL_COST=$((${GAS_FEE%ugnot} + STORAGE_BOUND * STORAGE_PRICE))

# State between runs (-state): one line per mandate, "<id> <last check> <retry after>".
#   last check:  when a never-paid mandate's session was last read, so the
#                -max-checks budget rotates over them;
#   retry after: a pull for it was included in a block and failed (the payer
#                paid the fee); it is not tried again before its plan's next
#                period.
# Only mandates seen in this run's listing are kept, so the file stays as
# long as the list of active mandates for this key.
NOW="$(date +%s)"
declare -A LAST=() RETRY=() SEEN=()
if [ -n "$STATE" ] && [ -f "$STATE" ]; then
	while read -r sid st ra; do
		[[ "$sid" =~ ^[0-9]+$ ]] || continue
		[[ "$st" =~ ^[0-9]+$ ]] && LAST[$sid]=$st
		[[ "${ra:-}" =~ ^[0-9]+$ ]] && RETRY[$sid]=$ra
	done <"$STATE"
fi
save_state() {
	[ -n "$STATE" ] || return 0
	local tmp k
	tmp="$(mktemp "$STATE.XXXXXX")" || { echo "could not write the state file next to $STATE" >&2; return 1; }
	TMPFILES+=("$tmp")
	for k in "${!SEEN[@]}"; do
		if [ -n "${LAST[$k]:-}" ] || [ "${RETRY[$k]:-0}" -gt "$NOW" ]; then
			printf '%s %s %s\n' "$k" "${LAST[$k]:-0}" "${RETRY[$k]:-0}"
		fi
	done >"$tmp" && mv "$tmp" "$STATE"
}

for row in "${PROVEN[@]+"${PROVEN[@]}"}" "${UNPROVEN[@]+"${UNPROVEN[@]}"}"; do
	read -r id _ <<<"$row"
	SEEN[$id]=1
done

# Never-paid ones in check order: never checked first (newest first), then by oldest check.
ORDERED=()
if [ "${#UNPROVEN[@]}" -gt 0 ]; then
	mapfile -t ORDERED < <(for row in "${UNPROVEN[@]}"; do
		read -r id _ <<<"$row"
		printf '%s %s\n' "${LAST[$id]:-0}" "$row"
	done | sort -k1,1n -k2,2nr | cut -d' ' -f2-)
fi

TODO=() checks=0 deferred=0 later=0 qfail=0
declare -A SKIPS=()
consider() { # <row> <never paid 0|1>
	local id payer amount period why
	read -r id payer amount period <<<"$1"
	if [ "${RETRY[$id]:-0}" -gt "$NOW" ]; then later=$((later + 1)); return; fi
	if [ "$2" = 1 ]; then
		if [ "$checks" -ge "$MAX_CHECKS" ]; then deferred=$((deferred + 1)); return; fi
		checks=$((checks + 1))
		LAST[$id]=$NOW
	fi
	why="$(session_check "$payer" "$amount")"
	case "$why" in
	ok) TODO+=("$1") ;;
	query-failed) qfail=$((qfail + 1)); echo "  could not read the session of mandate $id ($payer)" >&2 ;;
	*) SKIPS[$why]=$((${SKIPS[$why]:-0} + 1)); echo "  skipping mandate $id ($payer): $(reason "$why")" ;;
	esac
}
reason() {
	case "$1" in
	no-session) echo "no session for this key (never created, revoked or expired on chain)" ;;
	scope) echo "the session is not scoped to exactly vm/exec:$REALM" ;;
	limit) echo "the session's spend limit is below the price + $PULL_COST ugnot for fee and storage" ;;
	budget) echo "the session's budget for this spend period is already used" ;;
	expired) echo "the session expires within a minute" ;;
	esac
}
for row in "${PROVEN[@]+"${PROVEN[@]}"}"; do consider "$row" 0; done
for row in "${ORDERED[@]+"${ORDERED[@]}"}"; do consider "$row" 1; done
skipped_total=0
for k in "${!SKIPS[@]}"; do skipped_total=$((skipped_total + SKIPS[$k])); done
echo "sessions read: $skipped_total skipped, $checks of them never paid, $deferred never-paid left for later runs, $later waiting after a refused pull"
save_state

# Pull. Only a transaction that was included in a block and failed is put
# off to the plan's next period: it charged the payer the fee, and trying
# again soon would charge it again. Anything that never reached a block (a
# refusal in gnokey's simulation, a mempool refusal, a network error or a
# timeout) cost the payer nothing and is tried again on the next run. For
# the exit status, a refusal the payer caused (revoked or expired session,
# budget used, not enough coins, mandate cancelled meanwhile) is not an
# error; anything else is.
failed=0 refused=0 pulled=0 over=0 deferred_now=0
for row in "${TODO[@]+"${TODO[@]}"}"; do
	read -r id payer amount period <<<"$row"
	if [ "$pulled" -ge "$MAX_PULLS" ]; then over=$((over + 1)); continue; fi
	pulled=$((pulled + 1))
	if [ "$DRY" = 1 ]; then
		echo "  would pull mandate $id: ${amount}ugnot from $payer"
		continue
	fi
	echo "  pulling mandate $id: ${amount}ugnot from $payer"
	args=(maketx call -pkgpath "$REALM" -func Pull -send "${amount}ugnot" -master "$payer"
		-gas-fee "$GAS_FEE" -gas-wanted "$GAS_WANTED" -simulate "$SIMULATE" -broadcast -chainid "$CHAIN" -remote "$REMOTE" -home "$HOME_DIR")
	if [ "$PWSTDIN" = 1 ]; then
		out="$(printf '%s\n' "$PW" | gnokey "${args[@]}" -insecure-password-stdin "$KEY" 2>&1)" || true
	else
		out="$(gnokey "${args[@]}" "$KEY" 2>&1)" || true
	fi
	if printf '%s\n' "$out" | grep -q '^OK!'; then
		printf '%s\n' "$out" | grep -E '^(GAS USED|STORAGE DELTA|TX HASH):' | sed 's/^/    /'
		unset 'RETRY[$id]'
		continue
	fi
	msg="$(printf '%s\n' "$out" | grep -E '^Data:|panic:|error' | head -2 | tr '\n' ' ')"
	# gnokey prints the block height of a delivered transaction; a refusal in
	# simulation or in the mempool shows height 0 or none at all.
	if grep -qE '^HEIGHT: *[1-9]' <<<"$out"; then
		RETRY[$id]=$((NOW + period))
		deferred_now=$((deferred_now + 1))
		when="included in a block and failed, the fee was charged: not tried again before the next period"
	else
		when="not sent, nothing charged: tried again on the next run"
	fi
	if grep -qiE 'session not found|session expired|spend limit|insufficient (funds|coins)|mandate: (no active mandate|expired|too early)' <<<"$out"; then
		refused=$((refused + 1))
		echo "    refused on the payer's side ($when): $msg"
	else
		failed=$((failed + 1))
		echo "    FAILED ($when): $msg"
	fi
done
save_state
[ "$over" -gt 0 ] && echo "$over due mandates left for the next run (-max-pulls $MAX_PULLS)"
echo "done: $pulled pulled or tried, $refused refused on the payer's side, $failed failed, $deferred_now put off to the next period"
# Exit status: 0 when every due mandate was pulled or skipped for a reason on
# the payer's side (a revoked session is not an error); 1 when a pull failed
# for another reason or a session could not be read.
if [ "$failed" -gt 0 ] || [ "$qfail" -gt 0 ]; then
	echo "$failed pulls failed, $qfail sessions could not be read" >&2
	exit 1
fi
