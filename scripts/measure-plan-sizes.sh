#!/usr/bin/env bash
# Mandate: gas and storage at the list boundaries and at large plan sizes,
# with real signed transactions on a LOCAL gnodev chain (chain id "dev").
#
#   scripts/measure-plan-sizes.sh SIZE [LIVE] [PLANS]
#
# SIZE mandates on plan 1 are loaded as genesis transactions (one payer each;
# public keys only), the first of them with a real session for the collector
# key. Then, live and signed:
#   - LIVE new payers (default 36) subscribe to plan 1 one after another
#     (on the first chunk boundary and on the super-chunk boundary, the
#     subscriber is a payer who already holds 15 active mandates), so
#     the plan's list grows from SIZE to SIZE+LIVE: pick SIZE just below a
#     multiple of 1024 to cross a chunk boundary (every 32) and a
#     super-chunk boundary (at 1024k+32);
#   - the collector pulls the first payer's first payment (its entry is in
#     the oldest chunk);
#   - a probe realm (gno.land/r/mandate_probe/probe, local only, not under
#     the mandate realm's path) calls the free reads inside a transaction, so
#     their gas is measured on the same store: Render of the home page,
#     :plans, the plan page, the payee page, Plans, PlansOf, SupportersOf,
#     CollectorScan, and a no-op call for the probe's own overhead;
#   - the payee publishes one more plan after PLANS (default 1) plans, to
#     measure Offer as a payee's plan list grows.
#
# Safety: chain id "dev" only; every gnokey call passes -remote 127.0.0.1:<port>
# and -home <temp keybase>; everything is deleted on exit.
set -euo pipefail

CHAIN_ID="${CHAIN_ID:-dev}"
[ "$CHAIN_ID" = dev ] || { echo "refusing to run: local gnodev chain (dev) only, not $CHAIN_ID" >&2; exit 1; }
SIZE="${1:?usage: $0 SIZE [LIVE] [PLANS]}"
LIVE="${2:-36}"
PLANS="${3:-1}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
REALM="gno.land/r/mandate_dev/mandate"
PROBE="gno.land/r/mandate_probe/probe"
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

newkey() { printf '%s\n%s\n' "$PW" "$PW" | gnokey add -home "$KB" -insecure-password-stdin -nobackup -quiet "$1" >/dev/null 2>&1; }
field() { gnokey list -home "$KB" | awk -v k="$1" -v f="$2" '$2 == k { for (i = 1; i <= NF; i++) if ($i == f) { p = $(i + 1); sub(/,$/, "", p); print p } }'; }
for k in payee coll prober h1 h2; do newkey "$k"; done
for i in $(seq 1 "$LIVE"); do newkey "l$i"; done
PAYEE="$(field payee addr:)" COLL="$(field coll addr:)" GPUB="$(field coll pub:)" PAYEE_GPUB="$(field payee pub:)" PROBER="$(field prober addr:)"
# h1 and h2 already hold 15 active mandates each (genesis), so their Subscribe
# on plan 1 is the 16th: the most a payer record can hold. h1 subscribes on
# the first chunk boundary the walk crosses, h2 on the super-chunk boundary.
H1="$(field h1 addr:)" H1PUB="$(field h1 pub:)" H2="$(field h2 addr:)" H2PUB="$(field h2 pub:)"
EXP="$(($(date +%s) + 7200))"
LIVEADDRS=""
for i in $(seq 1 "$LIVE"); do LIVEADDRS="$LIVEADDRS $(field "l$i" addr:)"; done

# probe realm
mkdir -p "$TMP/extra/probe" "$TMP/gnohome"
touch "$TMP/extra/gnowork.toml"
printf 'module = "%s"\ngno = "0.9"\n' "$PROBE" >"$TMP/extra/probe/gnomod.toml"
cat >"$TMP/extra/probe/probe.gno" <<'EOF'
// Package probe calls Mandate's free reads inside a transaction so that a
// local test can measure their gas. Local only.
package probe

import "gno.land/r/mandate_dev/mandate"

var sink int

func Noop(cur realm)                     { sink++ }
func Render(cur realm, path string)      { sink += len(mandate.Render(path)) }
func Plans(cur realm)                    { sink += len(mandate.Plans(1)) }
func PlansOf(cur realm, payee address)   { sink += len(mandate.PlansOf(payee, 1)) }
func Supporters(cur realm, plan uint64)  { sink += len(mandate.SupportersOf(plan, 1)) }
func Scan(cur realm, plan uint64, s address) { sink += len(mandate.CollectorScan(plan, s, 0)) }
EOF

python3 - "$TMP" "$SIZE" "$PLANS" "$REALM" "$PAYEE" "$PAYEE_GPUB" "$GPUB" "$COLL" "$EXP" "$PROBER" "$H1:$H1PUB" "$H2:$H2PUB" $LIVEADDRS <<'PY'
import base64, hashlib, json, secrets, sys
d, size, nplans, realm, payee, payee_gpub, gpub, coll, exp, prober = sys.argv[1:11]
heavy = [x.split(":") for x in sys.argv[11:13]]
live = sys.argv[13:]
size, nplans = int(size), int(nplans)
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
def tx(pub, msgs):
    return {"tx": {"msg": msgs, "fee": {"gas_wanted": "100000000", "gas_fee": "1ugnot"},
                   "signatures": [{"pub_key": {"@type": "/tm.PubKeySecp256k1", "value": base64.b64encode(pub).decode()}, "signature": ""}], "memo": ""}}
def call(caller, fn, args): return {"@type": "/vm.m_call", "caller": caller, "send": "", "max_deposit": "", "pkg_path": realm, "func": fn, "args": args}
ppub = unbech(payee_gpub)[-33:]; spub = unbech(gpub)[-33:]
txs = [tx(ppub, [call(payee, "Offer", ["Plan %d" % (i + 1), "1000000", "60"])]) for i in range(nplans)]
txs.append(tx(ppub, [call(payee, "SetCollectorKey", [gpub])]))
bal = [payee + "=1000000000ugnot", prober + "=1000000000ugnot"] + [a + "=100000000ugnot" for a in live]
# 15 more plans; h1 and h2 each hold an active mandate on every one of them
# (each with its own session address, as the realm requires).
first_extra = nplans + 1
for i in range(15):
    txs.append(tx(ppub, [call(payee, "Offer", ["Extra %d" % i, "1000000", "60"])]))
for a, gp in heavy:
    hpub = unbech(gp)[-33:]
    bal.append(a + "=100000000ugnot")
    for i in range(15):
        sess = bech("g", secrets.token_bytes(20))
        txs.append(tx(hpub, [call(a, "Subscribe", [str(first_extra + i), sess, exp])]))
first = None
for i in range(size):
    pub = mul(secrets.randbelow(2**255) + 1); a = addr_of(pub)
    bal.append(a + "=10000000ugnot")
    msgs = [call(a, "Subscribe", ["1", coll, exp])]
    if i == 0:
        first = a
        msgs.insert(0, {"@type": "/auth.m_create_session", "creator": a, "session_key": {"@type": "/tm.PubKeySecp256k1", "value": base64.b64encode(spub).decode()},
                        "expires_at": exp, "allow_paths": ["vm/exec:" + realm], "spend_limit": "1100000ugnot", "spend_period": "60"})
    txs.append(tx(pub, msgs))
open(d + "/txs.jsonl", "w").write("".join(json.dumps(t) + "\n" for t in txs))
open(d + "/balances.txt", "w").write("\n".join(bal) + "\n")
open(d + "/first.txt", "w").write(first or "")
PY
FIRST="$(cat "$TMP/first.txt")"

started=$(date +%s)
(cd "$REPO" && GNOHOME="$TMP/gnohome" exec gnodev local -chain-id dev -extra-root "$TMP/extra" -txs-file "$TMP/txs.jsonl" -balance-file "$TMP/balances.txt" \
	-node-rpc-listener "$RPC" -web-listener "127.0.0.1:$WEB_PORT" -no-watch -empty-blocks -max-gas 100000000000 >"$TMP/gnodev.log" 2>&1) &
GNODEV_PID=$!
for _ in $(seq 3600); do
	gnokey query vm/qeval -data "$REALM.Totals()" -remote "$RPC" -home "$KB" >/dev/null 2>&1 && break
	kill -0 "$GNODEV_PID" 2>/dev/null || fail "gnodev exited: $(tail -3 "$TMP/gnodev.log")"
	sleep 1
done
failed="$(grep -c 'unable to deliver tx' "$TMP/gnodev.log" || true)"
[ "$failed" = 0 ] || fail "$failed genesis transactions failed: $(grep -o 'unable to deliver tx err="[^"]*"' "$TMP/gnodev.log" | head -2)"
echo "genesis: plan 1 with $SIZE mandates, $PLANS plans; node up after $(($(date +%s) - started)) s"

OUT="$TMP/out.txt"
CHUNK_N=-1 SUPER_N=-1
for n in $(seq "$SIZE" $((SIZE + LIVE - 1))); do
	if [ $(((n + 1) % 1024)) = 32 ] && [ "$SUPER_N" = -1 ]; then SUPER_N=$n
	elif [ $(((n + 1) % 32)) = 0 ] && [ "$CHUNK_N" = -1 ]; then CHUNK_N=$n; fi
done
tx() { local s="$1"; shift; printf '%s\n' "$PW" | gnokey maketx "$@" -broadcast -chainid dev -remote "$RPC" -home "$KB" -insecure-password-stdin "$s" >"$OUT" 2>&1 || true; grep -q '^OK!' "$OUT" || fail "$s $*: $(grep -E '^Data:' "$OUT" | head -2)"; }
gas() { sed -n 's/^GAS USED: *\([0-9]*\)$/\1/p' "$OUT"; }
delta() { local d; d="$(sed -n 's/^STORAGE DELTA: *\(-\{0,1\}[0-9]*\) bytes$/\1/p' "$OUT")"; echo "${d:-0}"; }
CALL=(-gas-fee 1000000ugnot -gas-wanted 100000000)

echo
echo "Subscribe as the list grows (N = entries before this one):"
n=$SIZE
for i in $(seq 1 "$LIVE"); do
	who="l$i" tag=""
	[ $(((n + 1) % 32)) = 0 ] && tag=" (chunk created)"
	[ $(((n + 1) % 1024)) = 32 ] && tag=" (chunk and super-chunk created)"
	[ "$n" = "$CHUNK_N" ] && who=h1 tag="$tag (payer with 15 active mandates)"
	[ "$n" = "$SUPER_N" ] && who=h2 tag="$tag (payer with 15 active mandates)"
	tx "$who" call -pkgpath "$REALM" -func Subscribe -args 1 -args "$COLL" -args "$EXP" "${CALL[@]}"
	echo "RESULT subscribe N=$n gas=$(gas) storage=$(delta)B$tag"
	n=$((n + 1))
done

tx coll call -pkgpath "$REALM" -func Pull -send 1000000ugnot -master "$FIRST" -gas-fee 20000ugnot -gas-wanted 20000000
echo "RESULT pull first-payment of the oldest entry (list of $n) gas=$(gas) storage=$(delta)B"

echo
echo "Free reads, measured inside a probe transaction (subtract the no-op):"
# 3,000,000,000 gas is the node's cap for a free query (DefaultQueryMaxGas): a
# read that runs out of it here would fail as a query too.
probe() {
	local what="$1"; shift
	printf '%s\n' "$PW" | gnokey maketx call -pkgpath "$PROBE" -func "$@" -gas-fee 3000000ugnot -gas-wanted 3000000000 -broadcast -chainid dev -remote "$RPC" -home "$KB" -insecure-password-stdin prober >"$OUT" 2>&1 || true
	if grep -q '^OK!' "$OUT"; then echo "RESULT read $what gas=$(gas)"; else echo "RESULT read $what FAILED $(grep -E '^Data:' "$OUT" | head -1)"; fi
}
probe "noop (probe overhead)" Noop
probe "Render home" Render -args ""
probe "Render :plans" Render -args "plans"
probe "Render plan page" Render -args "plan/1"
probe "Render payee page" Render -args "payee/$PAYEE"
probe "Plans(1)" Plans
probe "PlansOf(payee,1)" PlansOf -args "$PAYEE"
probe "SupportersOf(1,1)" Supporters -args 1
probe "CollectorScan(1,key,0)" Scan -args 1 -args "$COLL"

tx payee call -pkgpath "$REALM" -func Offer -args "One more" -args 1000000 -args 60 "${CALL[@]}"
echo "RESULT offer after $PLANS plans gas=$(gas) storage=$(delta)B"
