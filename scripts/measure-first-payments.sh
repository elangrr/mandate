#!/usr/bin/env bash
# Mandate: the first payment of every supporter of one plan, in order, with
# real session-signed Pulls on a LOCAL gnodev chain (chain id "dev").
#
#   scripts/measure-first-payments.sh [N] [allowance ugnot]   # default 64, the pages' allowance
#   SIMULATE=skip scripts/measure-first-payments.sh ...      # broadcast without gnokey's simulation
#
# One plan (1 GNOT every 60 s). N payers, each with a session exactly as the
# pages tell supporters to create it (spend limit = price + allowance, spend
# period = the plan's period, scope = exactly the realm) and a mandate, are
# loaded as genesis transactions (gnodev applies them without signatures, so
# only their public keys are generated, never their private halves). Then the
# collector key, a real throwaway key, pulls each payer's first payment in
# order, as scripts/collect.sh would. For each position the script prints the
# result, gas, storage delta and what the payer lost, and fails unless every
# first payment went through within the storage bound (100 B).
#
# Safety: chain id "dev" only; every gnokey call passes -remote 127.0.0.1:<port>
# and -home <temp keybase>; everything is deleted on exit.
set -euo pipefail

CHAIN_ID="${CHAIN_ID:-dev}"
[ "$CHAIN_ID" = dev ] || { echo "refusing to run: local gnodev chain (dev) only, not $CHAIN_ID" >&2; exit 1; }
N="${1:-64}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
REALM="gno.land/r/mandate_dev/mandate"
ALLOWANCE="${2:-$(sed -n 's/^\tFeeAllowance int64 = \([0-9_]*\)$/\1/p' "$REPO/r/mandate/mandate.gno" | tr -d _)}"
[[ "$ALLOWANCE" =~ ^[0-9]+$ ]] || { echo "could not read FeeAllowance" >&2; exit 1; }
free_port() { python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'; }
RPC_PORT="${RPC_PORT:-$(free_port)}"
WEB_PORT="${WEB_PORT:-$(free_port)}"
RPC="127.0.0.1:$RPC_PORT"
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

for k in payee coll; do printf '%s\n%s\n' "$PW" "$PW" | gnokey add -home "$KB" -insecure-password-stdin -nobackup -quiet "$k" >/dev/null 2>&1; done
field() { gnokey list -home "$KB" | awk -v k="$1" -v f="$2" '$2 == k { for (i = 1; i <= NF; i++) if ($i == f) { p = $(i + 1); sub(/,$/, "", p); print p } }'; }
PAYEE="$(field payee addr:)" COLL="$(field coll addr:)" GPUB="$(field coll pub:)" PAYEE_GPUB="$(field payee pub:)"
PRICE=1000000
SPEND=$((PRICE + ALLOWANCE))
EXP="$(($(date +%s) + 7200))"
echo "plan: 1 GNOT every 60 s; sessions: spend limit ${SPEND}ugnot per 60 s (price + ${ALLOWANCE} allowance); $N payers"

python3 - "$TMP" "$N" "$REALM" "$PAYEE" "$PAYEE_GPUB" "$GPUB" "$COLL" "$EXP" "$SPEND" <<'PY'
import base64, hashlib, json, secrets, sys
d, n, realm, payee, payee_gpub, gpub, coll, exp, spend = sys.argv[1:]
n = int(n)
CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
def pm(v):
    g = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; c = 1
    for x in v:
        b = c >> 25; c = (c & 0x1ffffff) << 5 ^ x
        for i in range(5): c ^= g[i] if (b >> i) & 1 else 0
    return c
def bech(hrp, data):
    acc = bits = 0; o = []
    for x in data:
        acc = (acc << 8) | x; bits += 8
        while bits >= 5: bits -= 5; o.append((acc >> bits) & 31)
    if bits: o.append((acc << (5 - bits)) & 31)
    hx = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]
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
def addr_of(pub): return bech("g", hashlib.new("ripemd160", hashlib.sha256(pub).digest()).digest())
sess_pub = unbech(gpub)[-33:]
def tx(caller, pub, msgs):
    return {"tx": {"msg": msgs, "fee": {"gas_wanted": "100000000", "gas_fee": "1ugnot"},
                   "signatures": [{"pub_key": {"@type": "/tm.PubKeySecp256k1", "value": base64.b64encode(pub).decode()}, "signature": ""}], "memo": ""}}
def call(caller, fn, args): return {"@type": "/vm.m_call", "caller": caller, "send": "", "max_deposit": "", "pkg_path": realm, "func": fn, "args": args}
ppub = unbech(payee_gpub)[-33:]
txs = [tx(payee, ppub, [call(payee, "Offer", ["First payments", "1000000", "60"])]), tx(payee, ppub, [call(payee, "SetCollectorKey", [gpub])])]
bal = [payee + "=1000000000ugnot"]
payers = []
for i in range(n):
    pub = mul(secrets.randbelow(2**255) + 1); a = addr_of(pub); payers.append(a)
    bal.append(a + "=100000000ugnot")
    txs.append(tx(a, pub, [
        {"@type": "/auth.m_create_session", "creator": a, "session_key": {"@type": "/tm.PubKeySecp256k1", "value": base64.b64encode(sess_pub).decode()},
         "expires_at": exp, "allow_paths": ["vm/exec:" + realm], "spend_limit": spend + "ugnot", "spend_period": "60"},
        call(a, "Subscribe", ["1", coll, exp])]))
open(d + "/txs.jsonl", "w").write("".join(json.dumps(t) + "\n" for t in txs))
open(d + "/balances.txt", "w").write("\n".join(bal) + "\n")
open(d + "/payers.txt", "w").write("\n".join(payers) + "\n")
PY

mkdir -p "$TMP/gnohome"
(cd "$REPO" && GNOHOME="$TMP/gnohome" exec gnodev local -chain-id dev -txs-file "$TMP/txs.jsonl" -balance-file "$TMP/balances.txt" \
	-node-rpc-listener "$RPC" -web-listener "127.0.0.1:$WEB_PORT" -no-watch -empty-blocks >"$TMP/gnodev.log" 2>&1) &
GNODEV_PID=$!
for _ in $(seq 600); do
	gnokey query vm/qeval -data "$REALM.Totals()" -remote "$RPC" -home "$KB" >/dev/null 2>&1 && break
	kill -0 "$GNODEV_PID" 2>/dev/null || fail "gnodev exited: $(tail -3 "$TMP/gnodev.log")"
	sleep 1
done
failed="$(grep -c 'unable to deliver tx' "$TMP/gnodev.log" || true)"
[ "$failed" = 0 ] || fail "$failed genesis transactions failed: $(grep -o 'unable to deliver tx err="[^"]*"' "$TMP/gnodev.log" | head -2)"
echo "genesis: $N sessions and mandates loaded"

bal() { local d; d="$(gnokey query "bank/balances/$1" -remote "$RPC" -home "$KB" | sed -n 's/^data: "\([0-9]*\)ugnot"$/\1/p')"; echo "${d:-0}"; }
OUT="$TMP/out.txt"
printf '%-5s %-8s %-11s %-9s %-12s %s\n' "pos" "result" "gas" "storage" "payer lost" "error"
pos=0 okc=0 failc=0 maxdelta=0
while read -r payer; do
	pos=$((pos + 1))
	b0="$(bal "$payer")"
	printf '%s\n' "$PW" | gnokey maketx call -pkgpath "$REALM" -func Pull -send "${PRICE}ugnot" -master "$payer" \
		-gas-fee 20000ugnot -gas-wanted 20000000 -simulate "${SIMULATE:-test}" -broadcast -chainid dev -remote "$RPC" -home "$KB" -insecure-password-stdin coll >"$OUT" 2>&1 || true
	lost=$((b0 - $(bal "$payer")))
	gas="$(sed -n 's/^GAS USED: *\([0-9]*\)$/\1/p' "$OUT")"
	delta="$(sed -n 's/^STORAGE DELTA: *\(-\{0,1\}[0-9]*\) bytes$/\1/p' "$OUT")"
	if grep -q '^OK!' "$OUT"; then
		res=ok okc=$((okc + 1)) err=""
		[ "${delta:-0}" -gt "$maxdelta" ] && maxdelta="${delta:-0}"
	else
		res=FAILED failc=$((failc + 1))
		err="$(grep -oE 'session spend limit[^,]*|not allowed[^,]*|Data: [^ ]+[^\n]{0,80}' "$OUT" | head -1)"
	fi
	printf '%-5s %-8s %-11s %-9s %-12s %s\n' "$pos" "$res" "${gas:-0}" "${delta:-0}" "$lost" "$err"
done <"$TMP/payers.txt"
echo
echo "RESULT n=$N allowance=$ALLOWANCE ok=$okc failed=$failc max_first_pull_storage=${maxdelta}B"
# The bound the collector and the fee allowance are sized for (scripts/collect.sh STORAGE_BOUND).
BOUND=100
[ "$failc" = 0 ] || fail "$failc first payments were refused"
[ "$maxdelta" -le "$BOUND" ] || fail "a first pull added ${maxdelta} B, above the ${BOUND} B bound"
echo "ok: every first payment went through and none added more than ${BOUND} B"
