#!/usr/bin/env bash
# Mandate: what an attacker can do to OTHER payers through shared structures,
# measured with real signed transactions on a LOCAL gnodev chain (chain id
# "dev"). Each run measures one scenario, then the victim's own calls:
#
#   scripts/measure-shared.sh baseline        # nothing else on the chain
#   scripts/measure-shared.sh loop  2000      # one address subscribes and cancels N times
#   scripts/measure-shared.sh depth 2300      # N new payer addresses, one mandate each
#   scripts/measure-shared.sh junk  10000     # N addresses, each with one active mandate
#                                             # on the victim payee's plans for its
#                                             # collector key, without any session (the
#                                             # realm allows one active mandate per payer
#                                             # and session key)
#
# After the scenario: the victim (a real payer with a real session) pulls
# twice, subscribes to another plan and cancels it; the script prints the gas
# of each, the attacker's storage deposits, and (junk) how long the
# collector takes and what it skips.
#
# How: the many attacker addresses of "depth" and "junk" are loaded as
# genesis transactions (gnodev -txs-file), which gnodev applies through the
# normal message handlers without checking signatures, so only public keys
# are needed: they are generated here and their private halves are never
# kept. Live transactions use throwaway keys in a temporary keybase.
#
# Safety: chain id "dev" only; every gnokey call passes -remote
# 127.0.0.1:<port> and -home <temp keybase>; everything is deleted on exit.
set -euo pipefail

CHAIN_ID="${CHAIN_ID:-dev}"
[ "$CHAIN_ID" = dev ] || { echo "refusing to run: local gnodev chain (dev) only, not $CHAIN_ID" >&2; exit 1; }
MODE="${1:-baseline}"
N="${2:-0}"
case "$MODE" in baseline | loop | depth | junk) ;; *) echo "mode: baseline | loop N | depth N | junk N" >&2; exit 2 ;; esac
REPO="$(cd "$(dirname "$0")/.." && pwd)"
# Ports: a free one each unless RPC_PORT / WEB_PORT are set (so this can run
# next to another local node); a port that is set and busy is refused below.
free_port() { python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'; }
RPC_PORT="${RPC_PORT:-$(free_port)}"
WEB_PORT="${WEB_PORT:-$(free_port)}"
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
for k in payee coll victim attacker; do newkey "$k"; done
PAYEE="$(addr_of payee)" COLL="$(addr_of coll)" VICTIM="$(addr_of victim)" ATT="$(addr_of attacker)"
GPUB="$(pub_of coll)" PAYEE_GPUB="$(pub_of payee)"
EXP="$(($(date +%s) + 7200))"
PLANS=18 # 16 for junk, 1 for the victim's measured subscribe, 1 for depth payers

# ---- genesis: plans, collector key, and the attacker's addresses --------------
python3 - "$TMP" "$MODE" "$N" "$REALM" "$PAYEE" "$PAYEE_GPUB" "$GPUB" "$COLL" "$EXP" "$PLANS" "$VICTIM" "$ATT" <<'PY'
import base64, hashlib, json, os, secrets, sys
d, mode, n, realm, payee, payee_gpub, gpub, coll, exp, nplans, victim, att = sys.argv[1:]
n, nplans = int(n), int(nplans)
CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
def pm(v):
    g = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; c = 1
    for x in v:
        b = c >> 25; c = (c & 0x1ffffff) << 5 ^ x
        for i in range(5): c ^= g[i] if (b >> i) & 1 else 0
    return c
def tobits(data):
    acc = bits = 0; o = []
    for x in data:
        acc = (acc << 8) | x; bits += 8
        while bits >= 5: bits -= 5; o.append((acc >> bits) & 31)
    if bits: o.append((acc << (5 - bits)) & 31)
    return o
def bech(hrp, data):
    o = tobits(data); hx = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]
    p = pm(hx + o + [0] * 6) ^ 1
    return hrp + "1" + "".join(CH[x] for x in o + [(p >> 5 * (5 - i)) & 31 for i in range(6)])
def unbech(s):
    data = [CH.index(c) for c in s[s.rindex("1") + 1:]][:-6]
    acc = bits = 0; o = []
    for x in data:
        acc = (acc << 5) | x; bits += 5
        while bits >= 8: bits -= 8; o.append((acc >> bits) & 255)
    return bytes(o)
P = 2**256 - 2**32 - 977
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798, 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)
def mul(k):
    def dbl(X, Y, Z):
        if Y == 0: return (0, 0, 0)
        S = 4 * X * Y * Y % P; M = 3 * X * X % P; X2 = (M * M - 2 * S) % P
        return (X2, (M * (S - X2) - 8 * Y**4) % P, 2 * Y * Z % P)
    def add(A, B):
        if A[2] == 0: return B
        if B[2] == 0: return A
        U1 = A[0] * B[2]**2 % P; U2 = B[0] * A[2]**2 % P; S1 = A[1] * B[2]**3 % P; S2 = B[1] * A[2]**3 % P
        if U1 == U2: return dbl(*A) if S1 == S2 else (0, 0, 0)
        H = U2 - U1; R = S2 - S1
        X3 = (R * R - H**3 - 2 * U1 * H * H) % P
        return (X3, (R * (U1 * H * H - X3) - S1 * H**3) % P, H * A[2] * B[2] % P)
    R = (0, 0, 0); Q = (G[0], G[1], 1)
    while k:
        if k & 1: R = add(R, Q)
        Q = dbl(*Q); k >>= 1
    zi = pow(R[2], -1, P); x = R[0] * zi * zi % P; y = R[1] * zi**3 % P
    return bytes([2 + (y & 1)]) + x.to_bytes(32, "big")
def newpub():  # random key; only the public half is kept
    return mul(secrets.randbelow(2**256 - 2**32 - 10**9) + 1)
def addr_of(pub):
    return bech("g", hashlib.new("ripemd160", hashlib.sha256(pub).digest()).digest())
def rawpub(gp):  # gpub1... -> 33-byte key
    b = unbech(gp); return b[-33:]
def tx(caller, pub, fn, args):
    return {"tx": {"msg": [{"@type": "/vm.m_call", "caller": caller, "send": "", "max_deposit": "", "pkg_path": realm, "func": fn, "args": args}],
                   "fee": {"gas_wanted": "100000000", "gas_fee": "1ugnot"},
                   "signatures": [{"pub_key": {"@type": "/tm.PubKeySecp256k1", "value": base64.b64encode(pub).decode()}, "signature": ""}],
                   "memo": ""}}
ppub = rawpub(payee_gpub)
txs = [tx(payee, ppub, "Offer", ["Plan %d" % (i + 1), "1000000", "60"]) for i in range(nplans)]
txs.append(tx(payee, ppub, "SetCollectorKey", [gpub]))
bal = [payee + "=1000000000ugnot", victim + "=1000000000ugnot", att + "=100000000000ugnot"]
attackers = []
if mode in ("depth", "junk"):
    for i in range(n):
        pub = newpub(); a = addr_of(pub); attackers.append(a)
        bal.append(a + "=10000000ugnot")
        if mode == "depth":
            sess = bech("g", hashlib.sha256(b"depth session %d" % i).digest()[:20])
            txs.append(tx(a, pub, "Subscribe", [str(nplans), sess, exp]))
        else:  # one per address: the realm allows one active mandate per payer and session key
            txs.append(tx(a, pub, "Subscribe", [str(i % 16 + 1), coll, exp]))
open(d + "/txs.jsonl", "w").write("".join(json.dumps(t) + "\n" for t in txs))
open(d + "/balances.txt", "w").write("\n".join(bal) + "\n")
open(d + "/attackers.txt", "w").write("\n".join(attackers) + ("\n" if attackers else ""))
print("genesis: %d transactions, %d attacker addresses" % (len(txs), len(attackers)))
PY

DEPOSIT_ADDR="$(python3 - "$REALM" <<'PY'
import hashlib, sys
CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
def pm(v):
    g = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; c = 1
    for x in v:
        b = c >> 25; c = (c & 0x1ffffff) << 5 ^ x
        for i in range(5): c ^= g[i] if (b >> i) & 1 else 0
    return c
raw = hashlib.sha256(("pkgPath:" + sys.argv[1] + ".storageDeposit").encode()).digest()[:20]
acc = bits = 0; o = []
for x in raw:
    acc = (acc << 8) | x; bits += 8
    while bits >= 5: bits -= 5; o.append((acc >> bits) & 31)
if bits: o.append((acc << (5 - bits)) & 31)
p = pm([3, 0, 7] + o + [0] * 6) ^ 1
print("g1" + "".join(CH[x] for x in o + [(p >> 5 * (5 - i)) & 31 for i in range(6)]))
PY
)"

mkdir -p "$TMP/gnohome"
started=$(date +%s)
(cd "$REPO" && GNOHOME="$TMP/gnohome" exec gnodev local -chain-id dev -txs-file "$TMP/txs.jsonl" -balance-file "$TMP/balances.txt" \
	-node-rpc-listener "$RPC" -web-listener "127.0.0.1:$WEB_PORT" -no-watch -empty-blocks -max-gas 100000000000 >"$TMP/gnodev.log" 2>&1) &
GNODEV_PID=$!
for _ in $(seq 1800); do
	gnokey query vm/qeval -data "$REALM.Totals()" -remote "$RPC" -home "$KB" >/dev/null 2>&1 && break
	kill -0 "$GNODEV_PID" 2>/dev/null || fail "gnodev exited: $(tail -3 "$TMP/gnodev.log")"
	sleep 1
done
echo "node up after $(($(date +%s) - started)) s"
failed="$(grep -c 'unable to deliver tx' "$TMP/gnodev.log" || true)"
[ "$failed" = 0 ] || fail "$failed genesis transactions failed: $(grep -o 'unable to deliver tx err="[^"]*"' "$TMP/gnodev.log" | head -2)"

OUT="$TMP/out.txt"
tx() { local s="$1"; shift; printf '%s\n' "$PW" | gnokey maketx "$@" -broadcast -chainid dev -remote "$RPC" -home "$KB" -insecure-password-stdin "$s" >"$OUT" 2>&1 || true; grep -q '^OK!' "$OUT" || fail "$s $*: $(grep -E '^Data:' "$OUT" | head -2)"; }
gas() { sed -n 's/^GAS USED: *\([0-9]*\)$/\1/p' "$OUT"; }
delta() { local d; d="$(sed -n 's/^STORAGE DELTA: *\(-\{0,1\}[0-9]*\) bytes$/\1/p' "$OUT")"; echo "${d:-0}"; }
bal() { local d; d="$(gnokey query "bank/balances/$1" -remote "$RPC" -home "$KB" | sed -n 's/^data: "\([0-9]*\)ugnot"$/\1/p')"; echo "${d:-0}"; }
CALL=(-gas-fee 1000000ugnot -gas-wanted 100000000)
totals() { gnokey query vm/qeval -data "$REALM.Totals()" -remote "$RPC" -home "$KB" | sed -n '/^data:/,$p' | tr '\n' ' ' | sed 's/^data: //'; }
echo "Totals after genesis: $(totals)"

# attacker deposits so far: everything in the deposit pool minus the payee's own
DEP0="$(bal "$DEPOSIT_ADDR")"
PAYEE_SPENT=$((1000000000 - $(bal "$PAYEE")))
ATT_DEPOSITS=0
if [ "$MODE" = depth ] || [ "$MODE" = junk ]; then ATT_DEPOSITS=$((DEP0 - PAYEE_SPENT)); fi

if [ "$MODE" = loop ]; then
	printf '%s\n' "$PW" | gnokey maketx call -pkgpath "$REALM" -func Subscribe -args 1 -args "$COLL" -args "$EXP" -gas-fee 9000000ugnot -gas-wanted 9000000000 -broadcast=false -chainid dev -remote "$RPC" -home "$KB" -insecure-password-stdin attacker >"$TMP/tpl.json" 2>/dev/null
	done_pairs=0 GASSUM=0
	while [ "$done_pairs" -lt "$N" ]; do
		python3 - "$TMP" "$done_pairs" 50 "$ATT" "$REALM" <<'PY'
import hashlib, json, sys
d, start, pairs, att, realm = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], sys.argv[5]
CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
def pm(v):
    g = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; c = 1
    for x in v:
        b = c >> 25; c = (c & 0x1ffffff) << 5 ^ x
        for i in range(5): c ^= g[i] if (b >> i) & 1 else 0
    return c
def addr(seed):
    raw = hashlib.sha256(("loop session %d" % seed).encode()).digest()[:20]
    acc = n = 0; out = []
    for b in raw:
        acc = (acc << 8) | b; n += 8
        while n >= 5: n -= 5; out.append((acc >> n) & 31)
    if n: out.append((acc << (5 - n)) & 31)
    m = pm([3, 0, 7] + out + [0] * 6) ^ 1
    return "g1" + "".join(CH[x] for x in out + [(m >> 5 * (5 - i)) & 31 for i in range(6)])
s = open(d + "/tpl.json").read(); tx = json.loads(s[s.index("{"):])
msgs = []
for i in range(start, start + pairs):
    a = addr(i)
    msgs.append({"@type": "/vm.m_call", "caller": att, "send": "", "max_deposit": "", "pkg_path": realm, "func": "Subscribe", "args": ["17", a, tx["msg"][0]["args"][2]]})
    msgs.append({"@type": "/vm.m_call", "caller": att, "send": "", "max_deposit": "", "pkg_path": realm, "func": "Cancel", "args": [att, a]})
tx["msg"] = msgs; tx["signatures"] = None
json.dump(tx, open(d + "/loop.json", "w"))
PY
		read -r num seq <<<"$(gnokey query "auth/accounts/$ATT" -remote "$RPC" -home "$KB" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read().split("data:",1)[1]); b=d.get("BaseAccount",d); print(b["account_number"], b.get("sequence","0"))')"
		printf '%s\n' "$PW" | gnokey sign -tx-path "$TMP/loop.json" -chainid dev -account-number "$num" -account-sequence "$seq" -home "$KB" -insecure-password-stdin attacker >/dev/null 2>&1 || fail sign
		gnokey broadcast "$TMP/loop.json" -remote "$RPC" -home "$KB" >"$OUT" 2>&1 || true
		grep -q '^OK!' "$OUT" || fail "loop tx: $(grep -E '^Data:' "$OUT" | head -2)"
		ATT_DEPOSITS=$((ATT_DEPOSITS + $(delta) * 100))
		GASSUM=$((GASSUM + $(gas)))
		done_pairs=$((done_pairs + 50))
	done
	echo "loop: $done_pairs subscribe+cancel pairs by one address, gas $GASSUM"
fi

echo "attacker storage deposits: ${ATT_DEPOSITS} ugnot"

# ---- the victim -------------------------------------------------------------------
tx victim session create -pubkey "$GPUB" -allow-paths "vm/exec:$REALM" -spend-limit 1000000000ugnot -spend-period 60 -expires-at "$EXP" "${CALL[@]}"
tx victim call -pkgpath "$REALM" -func Subscribe -args 1 -args "$COLL" -args "$EXP" "${CALL[@]}"
SUB1=$(gas) SUB1D=$(delta)
tx coll call -pkgpath "$REALM" -func Pull -send 1000000ugnot -master "$VICTIM" -gas-fee 1000000ugnot -gas-wanted 100000000
PULL1=$(gas) PULL1D=$(delta)
FRESH="$(python3 -c 'import hashlib
CH="qpzry9x8gf2tvdw0s3jn54khce6mua7l"
def pm(v):
    g=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];c=1
    for x in v:
        b=c>>25;c=(c&0x1ffffff)<<5^x
        for i in range(5):c^=g[i] if (b>>i)&1 else 0
    return c
raw=hashlib.sha256(b"victim fresh session").digest()[:20]
acc=n=0;o=[]
for b in raw:
    acc=(acc<<8)|b;n+=8
    while n>=5:n-=5;o.append((acc>>n)&31)
if n:o.append((acc<<(5-n))&31)
m=pm([3,0,7]+o+[0]*6)^1
print("g1"+"".join(CH[x] for x in o+[(m>>5*(5-i))&31 for i in range(6)]))')"
tx victim call -pkgpath "$REALM" -func Subscribe -args 17 -args "$FRESH" -args "$EXP" "${CALL[@]}"
SUB2=$(gas)
tx victim call -pkgpath "$REALM" -func Cancel -args "$VICTIM" -args "$FRESH" "${CALL[@]}"
CAN=$(gas)
FRESH2="$(python3 -c 'import hashlib
CH="qpzry9x8gf2tvdw0s3jn54khce6mua7l"
def pm(v):
    g=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];c=1
    for x in v:
        b=c>>25;c=(c&0x1ffffff)<<5^x
        for i in range(5):c^=g[i] if (b>>i)&1 else 0
    return c
raw=hashlib.sha256(b"victim fresh session 2").digest()[:20]
acc=n=0;o=[]
for b in raw:
    acc=(acc<<8)|b;n+=8
    while n>=5:n-=5;o.append((acc>>n)&31)
if n:o.append((acc<<(5-n))&31)
m=pm([3,0,7]+o+[0]*6)^1
print("g1"+"".join(CH[x] for x in o+[(m>>5*(5-i))&31 for i in range(6)]))')"
tx victim call -pkgpath "$REALM" -func Subscribe -args 2 -args "$FRESH2" -args "$EXP" "${CALL[@]}"
SUB_P2=$(gas)
tx victim call -pkgpath "$REALM" -func Cancel -args "$VICTIM" -args "$FRESH2" "${CALL[@]}"
CAN_P2=$(gas)
tx victim call -pkgpath "$REALM" -func Subscribe -args 17 -args "$FRESH2" -args "$EXP" "${CALL[@]}"
SUB_P17B=$(gas)
echo "RESULT victim_subscribe_untouched_plan=$SUB_P2 victim_cancel_untouched_plan=$CAN_P2 victim_subscribe_plan17_again=$SUB_P17B"
sleep 61
tx coll call -pkgpath "$REALM" -func Pull -send 1000000ugnot -master "$VICTIM" -gas-fee 1000000ugnot -gas-wanted 100000000
PULL2=$(gas) PULL2D=$(delta)
[ "$PULL2D" = 0 ] || fail "later pull grew storage by $PULL2D bytes"

echo
echo "RESULT mode=$MODE n=$N attacker_deposits_ugnot=$ATT_DEPOSITS"
echo "RESULT victim_subscribe_first=$SUB1 (storage $SUB1D B) victim_pull_first=$PULL1 (storage $PULL1D B) victim_pull_later=$PULL2 victim_subscribe_returning=$SUB2 victim_cancel=$CAN"

if [ "$MODE" = junk ]; then
	echo
	echo "## collector with junk mandates on the victim payee's plans"
	for mc in 100 100000; do
		t0=$(date +%s%N)
		out="$(printf '%s\n' "$PW" | "$REPO/scripts/collect.sh" -home "$KB" -key coll -payee "$PAYEE" -remote "$RPC" -chainid dev -realm "$REALM" -state "$TMP/state.$mc" -max-checks "$mc" -dry-run -insecure-password-stdin)"
		t1=$(date +%s%N)
		echo "$out" | grep -E "plans,|checked" | sed 's/^/  /'
		echo "RESULT collector_dry_run max_checks=$mc seconds=$(((t1 - t0) / 1000000000))"
	done
	t0=$(date +%s%N)
	curl -s "http://127.0.0.1:$WEB_PORT/r/mandate_dev/mandate:plan/1" >"$TMP/plan.html"
	t1=$(date +%s%N)
	grep -q "paying supporter" "$TMP/plan.html" || fail "plan page did not render"
	echo "RESULT plan_page_ms=$(((t1 - t0) / 1000000)) paying_line=$(grep -o '[0-9]* paying supporter[s]*' "$TMP/plan.html" | head -1 | tr ' ' '_') unpaid_line=$(grep -o '[0-9]* mandates have not paid yet' "$TMP/plan.html" | head -1 | tr ' ' '_')"
fi
