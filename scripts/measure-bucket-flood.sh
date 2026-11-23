#!/usr/bin/env bash
# Mandate: what a deliberately filled payer bucket costs other payers, measured
# with real signed transactions on a LOCAL gnodev chain (chain id "dev").
#
# The realm keeps per-payer lookups in 256 hash buckets (r/mandate/store.gno),
# chosen by sha256(payer address)[0]. An attacker can grind an address into a
# victim's bucket (1 try in 256) and fill the bucket: each Subscribe adds a
# lookup entry for (attacker, session), and a Cancel lets the attacker
# subscribe again with a fresh session address (any address; no key needed).
#
# This script:
#   1. creates throwaway keys in a temporary keybase until it has a victim and
#      an attacker in the same bucket (and a payee with a collector key),
#   2. the victim subscribes and gives the collector a real session,
#   3. the attacker fills the bucket in rounds (one multi-message transaction
#      per 50 subscribe+cancel pairs),
#   4. after each round it measures, with real transactions: the victim's
#      Pull (session-signed), a Subscribe by the victim to a fresh plan with an
#      already indexed session address, and the matching Cancel; and the
#      attacker's storage deposits and gas so far.
#
#   scripts/measure-bucket-flood.sh [rounds per step] [steps]   # default 10 x 4
#
# Safety: as scripts/local-flow.sh: chain id "dev" only, every gnokey call
# passes -remote 127.0.0.1:<port> and -home <temp keybase>, keys and node are
# deleted on exit, no mnemonic is printed or kept.
set -euo pipefail

CHAIN_ID="${CHAIN_ID:-dev}"
if [ "$CHAIN_ID" != "dev" ]; then
	echo "refusing to run: local gnodev chain (dev) only, not $CHAIN_ID" >&2
	exit 1
fi
ROUNDS="${1:-10}" # multi-message transactions per step
STEPS="${2:-4}"
PAIRS=50 # subscribe+cancel pairs per transaction
REPO="$(cd "$(dirname "$0")/.." && pwd)"
RPC_PORT="${RPC_PORT:-36657}"
WEB_PORT="${WEB_PORT:-38888}"
RPC="127.0.0.1:$RPC_PORT"
REALM="gno.land/r/mandate_dev/mandate"
TMP="$(mktemp -d)"
KB="$TMP/kb"
PW="throwaway-local-only"
GNODEV_PID=""
cleanup() {
	if [ -n "$GNODEV_PID" ]; then kill "$GNODEV_PID" 2>/dev/null || true; wait "$GNODEV_PID" 2>/dev/null || true; fi
	rm -rf "$TMP"
}
trap cleanup EXIT
fail() { echo "MISMATCH: $*" >&2; exit 1; }
if curl -s --max-time 1 "http://$RPC/status" >/dev/null 2>&1; then echo "port $RPC_PORT is busy" >&2; exit 1; fi

newkey() { printf '%s\n%s\n' "$PW" "$PW" | gnokey add -home "$KB" -insecure-password-stdin -nobackup -quiet "$1" >/dev/null 2>&1; }
addr_of() { gnokey list -home "$KB" | awk -v k="$1" '$2 == k { for (i = 1; i <= NF; i++) if ($i == "addr:") print $(i + 1) }'; }
pub_of() { gnokey list -home "$KB" | awk -v k="$1" '$2 == k { for (i = 1; i <= NF; i++) if ($i == "pub:") { p = $(i + 1); sub(/,$/, "", p); print p } }'; }
bucket() { printf '%s' "$1" | sha256sum | cut -c1-2; }

echo "## keys"
for k in payee coll victim; do newkey "$k"; done
PAYEE="$(addr_of payee)" COLL="$(addr_of coll)" VICTIM="$(addr_of victim)" GPUB="$(pub_of coll)"
B="$(bucket "$VICTIM")"
tries=0
while :; do
	tries=$((tries + 1))
	newkey "a$tries"
	if [ "$(bucket "$(addr_of "a$tries")")" = "$B" ]; then break; fi
	printf '%s\n' "$PW" | gnokey delete -home "$KB" -insecure-password-stdin -force "a$tries" >/dev/null 2>&1 || true
done
ATT="$(addr_of "a$tries")"
echo "  victim $VICTIM and attacker $ATT share bucket 0x$B (found after $tries keys)"

echo "## gnodev"
mkdir -p "$TMP/gnohome"
(cd "$REPO" && GNOHOME="$TMP/gnohome" exec gnodev local -chain-id dev \
	-add-account "$PAYEE=1000000000ugnot" -add-account "$VICTIM=1000000000ugnot" -add-account "$ATT=100000000000ugnot" \
	-node-rpc-listener "$RPC" -web-listener "127.0.0.1:$WEB_PORT" -no-watch -empty-blocks >"$TMP/gnodev.log" 2>&1) &
GNODEV_PID=$!
for _ in $(seq 90); do
	gnokey query vm/qeval -data "$REALM.Totals()" -remote "$RPC" -home "$KB" >/dev/null 2>&1 && break
	kill -0 "$GNODEV_PID" 2>/dev/null || fail "gnodev exited"
	sleep 1
done

OUT="$TMP/out.txt"
tx() { local s="$1"; shift; printf '%s\n' "$PW" | gnokey maketx "$@" -broadcast -chainid dev -remote "$RPC" -home "$KB" -insecure-password-stdin "$s" >"$OUT" 2>&1 || true; grep -q '^OK!' "$OUT" || fail "$s $*: $(grep -E '^Data:' "$OUT" | head -2)"; }
gas() { sed -n 's/^GAS USED: *\([0-9]*\)$/\1/p' "$OUT"; }
delta() { local d; d="$(sed -n 's/^STORAGE DELTA: *\(-\{0,1\}[0-9]*\) bytes$/\1/p' "$OUT")"; echo "${d:-0}"; }
bal() { local d; d="$(gnokey query "bank/balances/$1" -remote "$RPC" -home "$KB" | sed -n 's/^data: "\([0-9]*\)ugnot"$/\1/p')"; echo "${d:-0}"; }
CALL=(-gas-fee 1000000ugnot -gas-wanted 100000000)
EXP="$(($(date +%s) + 3000))"

tx payee call -pkgpath "$REALM" -func Offer -args "Victim plan" -args 1000000 -args 60 "${CALL[@]}"
tx payee call -pkgpath "$REALM" -func Offer -args "Attacker plan" -args 1000000 -args 60 "${CALL[@]}"
for i in $(seq 0 "$STEPS"); do tx payee call -pkgpath "$REALM" -func Offer -args "Extra $i" -args 1000000 -args 60 "${CALL[@]}"; done
tx payee call -pkgpath "$REALM" -func SetCollectorKey -args "$GPUB" "${CALL[@]}"
tx victim session create -pubkey "$GPUB" -allow-paths "vm/exec:$REALM" -spend-limit 1000000000ugnot -spend-period 60 -expires-at "$EXP" "${CALL[@]}"
tx victim call -pkgpath "$REALM" -func Subscribe -args 1 -args "$COLL" -args "$EXP" "${CALL[@]}"

# One unsigned template, then a transaction with PAIRS subscribe+cancel pairs.
printf '%s\n' "$PW" | gnokey maketx call -pkgpath "$REALM" -func Subscribe -args 2 -args "$COLL" -args "$EXP" -gas-fee 9000000ugnot -gas-wanted 9000000000 -broadcast=false -chainid dev -remote "$RPC" -home "$KB" -insecure-password-stdin "a$tries" >"$TMP/tpl.json" 2>/dev/null
NEXT=0
# sess_addr <n>: a valid address with no key, used as a throwaway session address.
sess_addr() { python3 -c 'import hashlib,sys
CH="qpzry9x8gf2tvdw0s3jn54khce6mua7l"
def pm(v):
    g=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];c=1
    for x in v:
        b=c>>25;c=(c&0x1ffffff)<<5^x
        for i in range(5):c^=g[i] if (b>>i)&1 else 0
    return c
raw=hashlib.sha256(("victim session %s"%sys.argv[1]).encode()).digest()[:20]
acc=n=0;out=[]
for b in raw:
    acc=(acc<<8)|b;n+=8
    while n>=5:n-=5;out.append((acc>>n)&31)
if n:out.append((acc<<(5-n))&31)
m=pm([3,0,7]+out+[0]*6)^1
print("g1"+"".join(CH[x] for x in out+[(m>>5*(5-i))&31 for i in range(6)]))' "$1"; }
flood_tx() {
	python3 - "$TMP" "$NEXT" "$PAIRS" "$ATT" "$REALM" <<'PY'
import hashlib, json, sys
d, start, pairs, att, realm = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], sys.argv[5]
CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
def polymod(v):
    g = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; c = 1
    for x in v:
        b = c >> 25; c = (c & 0x1ffffff) << 5 ^ x
        for i in range(5): c ^= g[i] if (b >> i) & 1 else 0
    return c
def addr(seed):  # any valid address works as a session address; no key exists for it
    raw = hashlib.sha256(("flood session %d" % seed).encode()).digest()[:20]
    acc = n = 0; out = []
    for b in raw:
        acc = (acc << 8) | b; n += 8
        while n >= 5: n -= 5; out.append((acc >> n) & 31)
    if n: out.append((acc << (5 - n)) & 31)
    e = [ord("g") >> 5, 0, ord("g") & 31]
    m = polymod(e + out + [0] * 6) ^ 1
    return "g1" + "".join(CH[x] for x in out + [(m >> 5 * (5 - i)) & 31 for i in range(6)])
s = open(d + "/tpl.json").read(); tx = json.loads(s[s.index("{"):])
msgs = []
for i in range(start, start + pairs):
    a = addr(i)
    msgs.append({"@type": "/vm.m_call", "caller": att, "send": "", "max_deposit": "", "pkg_path": realm, "func": "Subscribe", "args": ["2", a, tx["msg"][0]["args"][2]]})
    msgs.append({"@type": "/vm.m_call", "caller": att, "send": "", "max_deposit": "", "pkg_path": realm, "func": "Cancel", "args": [att, a]})
tx["msg"] = msgs; tx["signatures"] = None
json.dump(tx, open(d + "/flood.json", "w"))
PY
	local num seq
	read -r num seq <<<"$(gnokey query "auth/accounts/$ATT" -remote "$RPC" -home "$KB" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read().split("data:",1)[1]); b=d.get("BaseAccount",d); print(b["account_number"], b.get("sequence","0"))')"
	printf '%s\n' "$PW" | gnokey sign -tx-path "$TMP/flood.json" -chainid dev -account-number "$num" -account-sequence "$seq" -home "$KB" -insecure-password-stdin "a$tries" >/dev/null 2>&1 || fail "sign"
	gnokey broadcast "$TMP/flood.json" -remote "$RPC" -home "$KB" >"$OUT" 2>&1 || true
	grep -q '^OK!' "$OUT" || fail "flood tx: $(grep -E '^Data:' "$OUT" | head -2)"
	NEXT=$((NEXT + PAIRS))
}

# The victim's measurement sessions are indexed up front (subscribe and
# cancel once each), so the per-step Subscribe measures a known key and only
# the bucket differs between steps.
for step in $(seq 0 "$STEPS"); do
	tx victim call -pkgpath "$REALM" -func Subscribe -args 2 -args "$(sess_addr "$step")" -args "$EXP" "${CALL[@]}"
	tx victim call -pkgpath "$REALM" -func Cancel -args "$VICTIM" -args "$(sess_addr "$step")" "${CALL[@]}"
done
wait_period() { sleep 61; }
SUMDEP=0 SUMGAS=0
echo
printf '%-9s %-16s %-16s %-11s %-11s %-11s\n' "entries" "att. deposits" "att. gas used" "Pull gas" "Subscribe" "Cancel"
plan=3
for step in $(seq 0 "$STEPS"); do
	if [ "$step" -gt 0 ]; then
		for _ in $(seq "$ROUNDS"); do
			flood_tx
			SUMDEP=$((SUMDEP + $(delta) * 100))
			SUMGAS=$((SUMGAS + $(gas)))
		done
	fi
	# the victim's Pull, signed with the session key (one period after the last)
	tx coll call -pkgpath "$REALM" -func Pull -send 1000000ugnot -master "$VICTIM" -gas-fee 1000000ugnot -gas-wanted 100000000
	pg=$(gas)
	# the victim subscribes to a fresh plan with a fresh session address, then cancels it
	tx victim call -pkgpath "$REALM" -func Subscribe -args "$plan" -args "$(sess_addr "$step")" -args "$EXP" "${CALL[@]}"
	sg=$(gas)
	tx victim call -pkgpath "$REALM" -func Cancel -args "$VICTIM" -args "$(sess_addr "$step")" "${CALL[@]}"
	cg=$(gas)
	printf '%-9s %-16s %-16s %-11s %-11s %-11s\n' "$NEXT" "${SUMDEP}ugnot" "$SUMGAS" "$pg" "$sg" "$cg"
	plan=$((plan + 1))
	if [ "$step" -lt "$STEPS" ]; then wait_period; fi
done
echo "done"
