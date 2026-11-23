#!/usr/bin/env bash
# Mandate: the whole flow with real signed transactions on a LOCAL gnodev
# chain (chain id "dev"), including everything `gno test` cannot reach:
# session keys, the chain's spend limit, revoke and expiry, and the transfer.
#
# Every step checks its result and the script stops with a non-zero exit at
# the first mismatch. It proves:
#    1. subscribe (also measured for a new payer and a returning payer with a
#       known key), then pull: payer down by amount + fee, payee up by exactly
#       the amount, realm balance zero; the Pulled event; storage delta of
#       the first and later pulls (later pulls must add nothing)
#    2. a second pull in the same period is refused (by the chain's spend
#       limit, and with a generous session by the realm's own period rule)
#    3. a wrong amount is refused
#    4. the session cannot send coins, call another realm, or call Offer,
#       Subscribe, Cancel or SetCollectorKey
#    5. a session whose allow list is wider than this realm is refused by Pull
#    6. the collector script lists what is due (dry run) and pulls it
#    7. chain-side expiry and realm-side expiry each stop pulls
#    8. a hostile payee can burn at most the spend limit per period as fees
#    9. revoke: the session can no longer sign; the realm still says active
#       (documented), the chain's session query says not found
#   10. the sub-path case: a session for this realm also covers a realm
#       deployed under its path, and Pull's exact check cannot stop that
#   11. the payee-pays-fees variant: one transaction signed by the payee
#       (first signer, pays the fee) and the session key; payer pays exactly
#       the amount
#   12. cancel by the payer ends the mandate; Pull is refused after it
#   13. the collector: 32 supporters with the pages' sessions (the 32nd
#       first payment included), sessions it must skip, a pull refused in
#       simulation (retried) and one included and failed (put off), the
#       state file and the run lock
#   14. leaving and coming back within a paid period is not charged twice
#   15. the chain's limits (30-day spend period) and a 30-day plan end to
#       end with the pages' exact commands
#
# How: gnodev runs the repository's realm plus two throwaway test realms
# (gno.land/r/mandate_dev/other and gno.land/r/mandate_dev/mandate/sub) from
# a temporary folder. Throwaway keys are created in a temporary keybase
# (gnokey -home <mktemp dir>), funded at genesis with -add-account, and
# deleted with everything else on exit. No mnemonic is printed or stored.
#
# Needs gnodev, gnokey (v1.8.0), python3, curl. Takes about 5 minutes
# because periods are real seconds (the realm's minimum period is 60 s).
#
#   scripts/local-flow.sh            # log on stdout; keep files with KEEP=1
#
# Safety: every gnokey command passes -remote 127.0.0.1:<port> and -home
# <temp keybase>; gnokey's own defaults (this machine's node on 26657, the
# default key folder) are never used. CHAIN_ID must be "dev".
set -euo pipefail

CHAIN_ID="${CHAIN_ID:-dev}"
if [ "$CHAIN_ID" != "dev" ]; then
	echo "refusing to run: this script is for the local gnodev chain (dev) only, not $CHAIN_ID" >&2
	exit 1
fi
REPO="$(cd "$(dirname "$0")/.." && pwd)"
# Ports: a free one each unless RPC_PORT / WEB_PORT are set (so this can run
# next to another local node); a port that is set and busy is refused below.
free_port() { python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'; }
RPC_PORT="${RPC_PORT:-$(free_port)}"
WEB_PORT="${WEB_PORT:-$(free_port)}"
RPC="127.0.0.1:$RPC_PORT"
REALM="gno.land/r/mandate_dev/mandate"
OTHER="gno.land/r/mandate_dev/other"
SUB="gno.land/r/mandate_dev/mandate/sub"
TMP="$(mktemp -d)"
KB="$TMP/kb"
PW="throwaway-local-only"
GNODEV_PID=""

cleanup() {
	local rc=$?
	if [ -n "$GNODEV_PID" ]; then
		kill "$GNODEV_PID" 2>/dev/null || true
		wait "$GNODEV_PID" 2>/dev/null || true
	fi
	if [ "${KEEP:-0}" = 1 ]; then
		rm -rf "$KB" # never keep keys
		echo "kept logs in $TMP (keybase deleted)"
	else
		rm -rf "$TMP"
	fi
	if [ $rc -eq 0 ]; then
		echo "cleanup done: node stopped, throwaway keys and files deleted"
	else
		echo "FAILED (exit $rc); node stopped, throwaway keys deleted" >&2
	fi
}
trap cleanup EXIT

for c in gnodev gnokey python3 curl; do
	command -v "$c" >/dev/null || { echo "$c not found on PATH" >&2; exit 1; }
done
if curl -s --max-time 1 "http://$RPC/status" >/dev/null 2>&1; then
	echo "port $RPC_PORT is busy; stop the other node first" >&2
	exit 1
fi

step() { printf '\n## %s\n' "$*"; }
fail() {
	echo "MISMATCH: $*" >&2
	exit 1
}
eq() { # eq <what> <expected> <actual>
	if [ "$2" != "$3" ]; then fail "$1: expected '$2', got '$3'"; fi
	echo "  ok: $1 = $3"
}

# ---- keys -------------------------------------------------------------------
newkey() {
	printf '%s\n%s\n' "$PW" "$PW" | gnokey add -home "$KB" -insecure-password-stdin -nobackup -quiet "$1" >/dev/null 2>&1 ||
		fail "could not create throwaway key $1"
}
addr_of() { gnokey list -home "$KB" | awk -v k="$1" '$2 == k { for (i = 1; i <= NF; i++) if ($i == "addr:") print $(i + 1) }'; }
pub_of() { gnokey list -home "$KB" | awk -v k="$1" '$2 == k { for (i = 1; i <= NF; i++) if ($i == "pub:") { p = $(i + 1); sub(/,$/, "", p); print p } }'; }

step "throwaway keys in a temporary keybase"
for k in payer payee stranger coll coll2 coll3 coll4 coll5; do newkey "$k"; done
# step 13: 32 supporters with the sessions the pages tell them to create, and
# four whose sessions the collector must skip or whose pull the chain refuses.
SUPPORTERS=() FUND=()
for i in $(seq 1 32) low wide revoked poor; do newkey "s$i"; SUPPORTERS+=("s$i"); done
newkey smax # step 15
FUND+=(-add-account "$(addr_of smax)=10000000ugnot")
for k in "${SUPPORTERS[@]}"; do
	if [ "$k" = spoor ]; then FUND+=(-add-account "$(addr_of "$k")=1000000ugnot"); else FUND+=(-add-account "$(addr_of "$k")=10000000ugnot"); fi
done
PAYER="$(addr_of payer)" PAYEE="$(addr_of payee)" STRANGER="$(addr_of stranger)"
COLL="$(addr_of coll)" COLL2="$(addr_of coll2)" COLL3="$(addr_of coll3)" COLL4="$(addr_of coll4)" COLL5="$(addr_of coll5)"
GPUB="$(pub_of coll)" GPUB2="$(pub_of coll2)" GPUB3="$(pub_of coll3)" GPUB4="$(pub_of coll4)" GPUB5="$(pub_of coll5)"
echo "  payer $PAYER, payee $PAYEE, collector keys $COLL $COLL2 $COLL3 $COLL4 $COLL5 (all held by the payee)"

# The realm's own address: first 20 bytes of sha256("pkgPath:" + path), bech32 "g".
pkg_addr() {
	python3 - "$1" <<'PY'
import hashlib, sys
CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
def polymod(v):
    g = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    c = 1
    for x in v:
        b = c >> 25
        c = (c & 0x1ffffff) << 5 ^ x
        for i in range(5):
            c ^= g[i] if (b >> i) & 1 else 0
    return c
def bits(data):
    acc, n, out = 0, 0, []
    for b in data:
        acc = (acc << 8) | b; n += 8
        while n >= 5:
            n -= 5; out.append((acc >> n) & 31)
    if n: out.append((acc << (5 - n)) & 31)
    return out
hrp = "g"
d = bits(hashlib.sha256(("pkgPath:" + sys.argv[1]).encode()).digest()[:20])
e = [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]
m = polymod(e + d + [0] * 6) ^ 1
print(hrp + "1" + "".join(CH[x] for x in d + [(m >> 5 * (5 - i)) & 31 for i in range(6)]))
PY
}
eq "address derivation check (spike realm)" g1m5xtkrxuwggnlll5m5heuzrvwhwpusj3m8f3ez "$(pkg_addr gno.land/r/g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5/mandate)"
REALM_ADDR="$(pkg_addr "$REALM")"
SUB_ADDR="$(pkg_addr "$SUB")"

# ---- node ---------------------------------------------------------------------
step "start gnodev (chain id dev) with the realm and two test realms"
mkdir -p "$TMP/extra/other" "$TMP/extra/sub" "$TMP/gnohome"
touch "$TMP/extra/gnowork.toml"
printf 'module = "%s"\ngno = "0.9"\n' "$OTHER" >"$TMP/extra/other/gnomod.toml"
printf 'module = "%s"\ngno = "0.9"\n' "$SUB" >"$TMP/extra/sub/gnomod.toml"
cat >"$TMP/extra/other/other.gno" <<'EOF'
// Package other is a throwaway realm for the local flow: it keeps any coins
// sent with Tip. A session scoped to the mandate realm must not reach it.
package other

import "chain/runtime/unsafe"

var got int64

func Tip(cur realm) { got += unsafe.OriginSend().AmountOf("ugnot") }

func Render(string) string { return "other" }
EOF
sed 's/^package other/package sub/; s/^\/\/ Package other/\/\/ Package sub/' "$TMP/extra/other/other.gno" >"$TMP/extra/sub/sub.gno"
(cd "$REPO" && GNOHOME="$TMP/gnohome" exec gnodev local -chain-id dev -extra-root "$TMP/extra" \
	-add-account "$PAYER=100000000ugnot" -add-account "$PAYEE=100000000ugnot" -add-account "$STRANGER=100000000ugnot" "${FUND[@]}" \
	-node-rpc-listener "$RPC" -web-listener "127.0.0.1:$WEB_PORT" -no-watch -empty-blocks >"$TMP/gnodev.log" 2>&1) &
GNODEV_PID=$!
for _ in $(seq 90); do
	if gnokey query vm/qeval -data "$REALM.Totals()" -remote "$RPC" -home "$KB" >/dev/null 2>&1; then break; fi
	kill -0 "$GNODEV_PID" 2>/dev/null || fail "gnodev exited: $(tail -5 "$TMP/gnodev.log")"
	sleep 1
done
status="$(curl -s "http://$RPC/status")"
eq "chain id" dev "$(printf '%s' "$status" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["node_info"]["network"])')"

# ---- helpers ------------------------------------------------------------------
bal() {
	local d
	d="$(gnokey query "bank/balances/$1" -remote "$RPC" -home "$KB" | sed -n 's/^data: "\([0-9]*\)ugnot"$/\1/p')"
	echo "${d:-0}"
}
qeval() { gnokey query vm/qeval -data "$1" -remote "$RPC" -home "$KB" | sed -n '/^data: /,$p' | sed 's/^data: //'; }
now() { date +%s; }

OUT="$TMP/out.txt"
# tx <signer> <maketx args...>: sign with the throwaway key and broadcast.
tx() {
	local signer="$1"
	shift
	if printf '%s\n' "$PW" | gnokey maketx "$@" -broadcast -chainid dev -remote "$RPC" -home "$KB" -insecure-password-stdin "$signer" >"$OUT" 2>&1; then
		return 0
	fi
	return 1
}
show() { grep -E '^(GAS USED|STORAGE DELTA|STORAGE FEE|TOTAL TX COST):' "$OUT" | sed 's/^/    /' || true; }
expect_ok() { # expect_ok <what> <tx args...>
	local what="$1"
	shift
	tx "$@" || true
	grep -q '^OK!' "$OUT" || fail "$what: expected success, got: $(grep -E '^Data:|panic:' "$OUT" | head -3 | tr '\n' ' ')"
	echo "  ok: $what"
	show
	realm_zero
}
expect_fail() { # expect_fail <what> <substring> <tx args...>
	local what="$1" want="$2"
	shift 2
	if tx "$@" && grep -q '^OK!' "$OUT"; then fail "$what: expected a refusal, but it succeeded"; fi
	grep -qF -- "$want" "$OUT" || fail "$what: expected '$want' in: $(grep -E '^Data:|panic:|Error' "$OUT" | head -3 | tr '\n' ' ')"
	echo "  ok: $what refused ($want)"
	grep -E '^GAS USED:' "$OUT" | sed 's/^/    /' || true
	realm_zero
}
realm_zero() { [ "$(bal "$REALM_ADDR")" = 0 ] || fail "the realm holds $(bal "$REALM_ADDR")ugnot"; }
gas_used() { sed -n 's/^GAS USED: *\([0-9]*\)$/\1/p' "$OUT"; }
storage_delta() { local d; d="$(sed -n 's/^STORAGE DELTA: *\(-\{0,1\}[0-9]*\) bytes$/\1/p' "$OUT")"; echo "${d:-0}"; }

CALL=(-gas-fee 100000ugnot -gas-wanted 60000000) # as the pages give it
PULLGAS=(-gas-fee 20000ugnot -gas-wanted 20000000)
pull() { # pull <session key> <amount> -> tx args for a Pull on behalf of the payer
	echo "call -pkgpath $REALM -func Pull -send ${2}ugnot -master $PAYER ${PULLGAS[*]}"
}
session_args() { # <gpub> <allow paths> <spend limit> <period> <expires-at>
	echo "session create -pubkey $1 -allow-paths $2 -spend-limit $3 -spend-period $4 -expires-at $5 ${CALL[*]}"
}

GAS_REPORT="$TMP/gas.txt"
: >"$GAS_REPORT"
note_gas() { echo "$1: gas $(gas_used), storage delta $(storage_delta) bytes" | tee -a "$GAS_REPORT" | sed 's/^/    /'; }

# ---- 1. plans, collector key, sessions, subscribe ---------------------------
step "1. payee publishes plans and a collector key"
expect_ok "Offer plan 1 (1 GNOT / 60 s)" payee call -pkgpath "$REALM" -func Offer -args "Supporter A" -args 1000000 -args 60 "${CALL[@]}"
note_gas "Offer"
expect_ok "Offer plan 2 (2 GNOT / 60 s)" payee call -pkgpath "$REALM" -func Offer -args "Supporter B" -args 2000000 -args 60 "${CALL[@]}"
expect_ok "Offer plan 3 (0.5 GNOT / 60 s)" payee call -pkgpath "$REALM" -func Offer -args "Supporter C" -args 500000 -args 60 "${CALL[@]}"
expect_ok "Offer plan 4 (0.5 GNOT / 60 s)" payee call -pkgpath "$REALM" -func Offer -args "Supporter D" -args 500000 -args 60 "${CALL[@]}"
expect_ok "SetCollectorKey" payee call -pkgpath "$REALM" -func SetCollectorKey -args "$GPUB" "${CALL[@]}"
note_gas "SetCollectorKey"
eq "collector address derived by the realm" "$COLL" "$(gnokey query vm/qrender -data "$REALM:payee/$PAYEE" -remote "$RPC" -home "$KB" | sed -n 's/^Collector key: `\(g1[a-z0-9]*\)`.*/\1/p')"

step "the payer creates sessions (own key) and subscribes"
T0="$(now)"
EXP="$((T0 + 1800))"
# coll: the normal case, spend limit = 1 GNOT + 0.1 GNOT fee allowance.
expect_ok "session for coll (1.1 GNOT / 60 s, exactly this realm)" payer $(session_args "$GPUB" "vm/exec:$REALM" 1100000ugnot 60 "$EXP")
note_gas "session create"
expect_ok "Subscribe plan 1 with coll" payer call -pkgpath "$REALM" -func Subscribe -args 1 -args "$COLL" -args "$EXP" "${CALL[@]}"
note_gas "Subscribe (new payer, new key)"
# coll2: a far too generous chain limit, so the realm's own rules show.
expect_ok "session for coll2 (50 GNOT / 60 s)" payer $(session_args "$GPUB2" "vm/exec:$REALM" 50000000ugnot 60 "$EXP")
expect_ok "Subscribe plan 2 with coll2" payer call -pkgpath "$REALM" -func Subscribe -args 2 -args "$COLL2" -args "$EXP" "${CALL[@]}"
note_gas "Subscribe (returning payer, new key)"
# coll3: the chain session expires soon, the realm terms do not.
EXP3="$((T0 + 100))"
expect_ok "session for coll3 (chain expiry in ~100 s)" payer $(session_args "$GPUB3" "vm/exec:$REALM" 600000ugnot 60 "$EXP3")
expect_ok "Subscribe plan 3 with coll3" payer call -pkgpath "$REALM" -func Subscribe -args 3 -args "$COLL3" -args "$EXP" "${CALL[@]}"
# coll4: the chain session runs on, the realm terms expire soon.
EXP4="$((T0 + 100))"
expect_ok "session for coll4 (chain expiry in 30 min)" payer $(session_args "$GPUB4" "vm/exec:$REALM" 600000ugnot 60 "$EXP")
expect_ok "Subscribe plan 4 with coll4, realm expiry in ~100 s" payer call -pkgpath "$REALM" -func Subscribe -args 4 -args "$COLL4" -args "$EXP4" "${CALL[@]}"
# coll5: scoped to the whole namespace, wider than this realm.
expect_ok "session for coll5 (vm/exec:gno.land/r/mandate_dev, too wide)" payer $(session_args "$GPUB5" "vm/exec:gno.land/r/mandate_dev" 5000000ugnot 60 "$EXP")
eq "HasMandate(payer, 1)" "(true bool)" "$(qeval "$REALM.HasMandate(address(\"$PAYER\"), 1)")"

step "1b. what subscribing costs a new payer and a returning payer whose key is already known"
expect_ok "stranger subscribes to plan 1 with coll (new payer, known key)" stranger call -pkgpath "$REALM" -func Subscribe -args 1 -args "$COLL" -args "$EXP" "${CALL[@]}"
note_gas "Subscribe (new payer, known key)"
expect_ok "stranger cancels it" stranger call -pkgpath "$REALM" -func Cancel -args "$STRANGER" -args "$COLL" "${CALL[@]}"
note_gas "Cancel (right after subscribing)"
expect_ok "stranger subscribes to plan 2 with coll (returning payer, known key)" stranger call -pkgpath "$REALM" -func Subscribe -args 2 -args "$COLL" -args "$EXP" "${CALL[@]}"
note_gas "Subscribe (returning payer, known key)"
expect_ok "stranger cancels it" stranger call -pkgpath "$REALM" -func Cancel -args "$STRANGER" -args "$COLL" "${CALL[@]}"

# ---- first pull -------------------------------------------------------------------
step "first pull: coll signs for the payer, exactly 1 GNOT"
p0="$(bal "$PAYER")" e0="$(bal "$PAYEE")"
expect_ok "Pull plan 1" coll $(pull coll 1000000)
note_gas "Pull (first)"
FIRST_DELTA="$(storage_delta)"
p1="$(bal "$PAYER")" e1="$(bal "$PAYEE")"
eq "payee gain" 1000000 "$((e1 - e0))"
eq "payer loss = amount + fee + storage" "$((1000000 + 20000 + FIRST_DELTA * 100))" "$((p0 - p1))"
eq "realm balance" 0 "$(bal "$REALM_ADDR")"
grep -q '"type":"Pulled"' "$OUT" || fail "no Pulled event"
python3 - "$OUT" "$PAYER" "$PAYEE" "$REALM_ADDR" <<'PY' || fail "Pulled event or transfers do not match"
import json, sys
out, payer, payee, realm = sys.argv[1:]
line = [l for l in open(out) if l.startswith("EVENTS:")][0]
ev = json.loads(line.split(":", 1)[1])
transfers = [(e.get("from"), e.get("to"), e["coins"][0]["amount"]) for e in ev if "coins" in e]
assert transfers == [(payer, realm, 1000000), (realm, payee, 1000000)], transfers
pulled = [e for e in ev if e.get("type") == "Pulled"][0]
attrs = {a["key"]: a["value"] for a in pulled["attrs"]}
assert attrs["payer"] == payer and attrs["payee"] == payee and attrs["amount"] == "1000000" and attrs["plan"] == "1", attrs
print("  ok: transfers payer->realm->payee of 1000000 and the Pulled event", attrs)
PY
T1="$(now)"

step "2. second pull in the same period"
p1="$(bal "$PAYER")"
expect_fail "second pull with the tight session (chain spend limit, before any charge)" "spend limit" coll $(pull coll 1000000)
eq "payer unchanged" "$p1" "$(bal "$PAYER")"
expect_ok "first pull of plan 2 (coll2)" coll2 $(pull coll2 2000000)
expect_fail "second pull of plan 2 with the generous session (realm period rule)" "mandate: too early" coll2 $(pull coll2 2000000)

expect_ok "first pull of plan 3 (coll3)" coll3 $(pull coll3 500000)
expect_ok "first pull of plan 4 (coll4)" coll4 $(pull coll4 500000)

step "4. the session cannot be used for anything else"
p="$(bal "$PAYER")"
expect_fail "bank send with coll2" "not permitted by session" coll2 send -to "$STRANGER" -send 1000000ugnot -master "$PAYER" "${PULLGAS[@]}"
expect_fail "call to another realm with coll2" "not permitted by session" coll2 call -pkgpath "$OTHER" -func Tip -send 1000000ugnot -master "$PAYER" "${PULLGAS[@]}"
eq "payer unchanged by chain-refused calls" "$p" "$(bal "$PAYER")"
expect_fail "Offer through the session" "cannot be called with a session key" coll2 call -pkgpath "$REALM" -func Offer -args x -args 1000000 -args 60 -master "$PAYER" "${PULLGAS[@]}"
expect_fail "Subscribe through the session" "cannot be called with a session key" coll2 call -pkgpath "$REALM" -func Subscribe -args 1 -args "$COLL5" -args "$EXP" -master "$PAYER" "${PULLGAS[@]}"
expect_fail "Cancel through the session" "cannot be called with a session key" coll2 call -pkgpath "$REALM" -func Cancel -args "$PAYER" -args "$COLL2" -master "$PAYER" "${PULLGAS[@]}"
expect_fail "SetCollectorKey through the session" "cannot be called with a session key" coll2 call -pkgpath "$REALM" -func SetCollectorKey -args "$GPUB5" -master "$PAYER" "${PULLGAS[@]}"
eq "HasMandate(payer, 2) still true" "(true bool)" "$(qeval "$REALM.HasMandate(address(\"$PAYER\"), 2)")"
if tx coll2 session create -pubkey "$GPUB5" -allow-paths '*' -expires-at 30m -master "$PAYER" "${CALL[@]}"; then fail "a session created a session"; fi
grep -q "cannot be used with session" "$OUT" || fail "unexpected: $(head -3 "$OUT")"
echo "  ok: a session cannot create a session (gnokey refuses; the chain always denies auth/* from sessions)"

step "5. a session wider than this realm is refused by Pull"
expect_fail "Pull with coll5 (scope vm/exec:gno.land/r/mandate_dev)" "the session must be scoped to exactly" coll5 $(pull coll5 1000000)
expect_ok "coll5 can call another realm in that namespace: why the payer page insists on the exact scope" coll5 call -pkgpath "$OTHER" -func Tip -send 100000ugnot -master "$PAYER" "${PULLGAS[@]}"

# ---- the next period ---------------------------------------------------------------
# The chain's own clock: the time of its latest block. It lags the wall
# clock by up to a block, so waits go by it, never by the local clock.
chain_time() {
	curl -s "http://$RPC/status" | python3 -c '
import json, sys, datetime
t = json.load(sys.stdin)["result"]["sync_info"]["latest_block_time"]
d, _, frac = t.rstrip("Z").partition(".")
print(int(datetime.datetime.fromisoformat(d).replace(tzinfo=datetime.timezone.utc).timestamp()))'
}
wait_until() { # wait until the latest block's time is at or after $1
	local t="$1" c
	c="$(chain_time)"
	[ "$c" -ge "$t" ] && return 0
	echo "  (waiting for the chain's block time to pass $t, now $c)"
	for _ in $(seq $((t - c + 120))); do
		sleep 1
		[ "$(chain_time)" -ge "$t" ] && return 0
	done
	fail "the chain's block time did not reach $t"
}
fee_of() { sed -n 's/^Pull fee: \([0-9]*\)ugnot .*/\1/p' <<<"$1"; }
step "6. next period: the collector script (dry run, then for real)"
wait_until "$((T1 + 62))"
if out="$("$REPO/scripts/collect.sh" -home "$KB" -key coll -payee "$PAYEE" -realm "$REALM" -chainid dev 2>&1)"; then fail "collector ran without -remote"; fi
grep -q "missing -remote" <<<"$out" || fail "unexpected: $out"
echo "  ok: the collector refuses to run without -remote"
if out="$("$REPO/scripts/collect.sh" -home "$KB" -key coll -payee "$PAYEE" -remote "$RPC" -realm "$REALM" -chainid onyx-1 2>&1)"; then fail "collector accepted onyx-1 with a local remote"; fi
echo "  ok: the collector refuses onyx-1 with a non-Onyx remote"
if out="$("$REPO/scripts/collect.sh" -home "$KB" -key coll -payee "$PAYEE" -remote "$RPC" -realm "$REALM" -chainid gnoland1 2>&1)"; then fail "collector accepted another chain id"; fi
echo "  ok: the collector refuses any other chain id"
# junk: a mandate for coll recorded by someone who never created a session
expect_ok "stranger records a junk mandate for coll on plan 3 (no session)" stranger call -pkgpath "$REALM" -func Subscribe -args 3 -args "$COLL" -args "$EXP" "${CALL[@]}"
out="$(printf '%s\n' "$PW" | "$REPO/scripts/collect.sh" -home "$KB" -key coll -payee "$PAYEE" -remote "$RPC" -chainid dev -realm "$REALM" -state "$TMP/collect.state" -dry-run -insecure-password-stdin)"
echo "$out" | sed 's/^/    /'
grep -q "would pull mandate 1: 1000000ugnot from $PAYER" <<<"$out" || fail "dry run does not list mandate 1 as due"
p="$(bal "$PAYER")" e="$(bal "$PAYEE")"
grep -q "skipping mandate [0-9]* ($STRANGER): no session for this key" <<<"$out" || fail "collector did not skip the junk mandate"
grep -q "would pull mandate" <<<"$(grep "$STRANGER" <<<"$out")" && fail "collector would pull the junk mandate"
[ -s "$TMP/collect.state" ] || fail "collector state file not written"
echo "  ok: the junk mandate was checked on chain (no session) and skipped; state kept in a file"
STATE_LINES_BEFORE="$(wc -l <"$TMP/collect.state")"
out="$(printf '%s\n' "$PW" | "$REPO/scripts/collect.sh" -home "$KB" -key coll -payee "$PAYEE" -remote "$RPC" -chainid dev -realm "$REALM" -state "$TMP/collect.state" -insecure-password-stdin)"
echo "$out" | sed 's/^/    /'
grep -q "pulling mandate 1" <<<"$out" || fail "collector did not pull mandate 1"
SECOND_DELTA="$(sed -n 's/^ *STORAGE DELTA: *\(-\{0,1\}[0-9]*\) bytes$/\1/p' <<<"$out")"
SECOND_DELTA="${SECOND_DELTA:-0}"
eq "payee gain from the collector's pull" 1000000 "$(($(bal "$PAYEE") - e))"
eq "payer loss (amount + the collector's fee, no storage)" "$((1000000 + $(fee_of "$out")))" "$((p - $(bal "$PAYER")))"
eq "storage delta of the second pull of a mandate" 0 "$SECOND_DELTA"
echo "first pull storage delta: $FIRST_DELTA bytes; second pull: $SECOND_DELTA bytes" >>"$GAS_REPORT"
realm_zero
T2="$(now)"

step "3. wrong amounts (generous session, new period, so the realm's amount check is what refuses)"
expect_fail "3 GNOT instead of 2" "mandate: send exactly 2000000ugnot" coll2 $(pull coll2 3000000)
expect_fail "1 GNOT instead of 2" "mandate: send exactly 2000000ugnot" coll2 $(pull coll2 1000000)
expect_fail "no coins" "mandate: send exactly 2000000ugnot" coll2 call -pkgpath "$REALM" -func Pull -master "$PAYER" "${PULLGAS[@]}"
expect_ok "correct second pull of plan 2" coll2 $(pull coll2 2000000)
note_gas "Pull (later)"
eq "storage delta of a later pull" 0 "$(storage_delta)"

step "10. sub-path: a session for this realm also covers $SUB"
p="$(bal "$PAYER")"
expect_ok "coll2 calls $SUB.Tip with 1 GNOT of the payer's coins" coll2 call -pkgpath "$SUB" -func Tip -send 1000000ugnot -master "$PAYER" "${PULLGAS[@]}"
eq "payer lost 1 GNOT + fee + storage outside the mandate's rules" "$((1020000 + $(storage_delta) * 100))" "$((p - $(bal "$PAYER")))"
eq "the sub-realm kept it" 1000000 "$(bal "$SUB_ADDR")"
echo "  => Pull's exact allow-list check cannot help here: Pull is never called. What protects payers is that"
echo "     nothing is ever deployed under the realm's path (stated in the realm doc, README and design.md)."

step "9. revoke"
expect_ok "payer revokes coll2's session" payer session revoke -pubkey "$GPUB2" "${CALL[@]}"
p="$(bal "$PAYER")"
wait_until "$((T2 + 62))"
if tx coll2 $(pull coll2 2000000) && grep -q '^OK!' "$OUT"; then fail "pull after revoke succeeded"; fi
echo "  ok: pull after revoke refused: $(grep -E '^Data:' "$OUT" | head -1)"
eq "payer unchanged" "$p" "$(bal "$PAYER")"
eq "HasMandate(payer, 2) is still true: the realm cannot see a revoke" "(true bool)" "$(qeval "$REALM.HasMandate(address(\"$PAYER\"), 2)")"
if gnokey query "auth/accounts/$PAYER/session/$COLL2" -remote "$RPC" -home "$KB" >"$OUT" 2>&1; then fail "session query still finds the revoked session"; fi
grep -q SessionNotFound "$OUT" || fail "unexpected: $(head -3 "$OUT")"
echo "  ok: auth/accounts/<payer>/session/<coll2> says SessionNotFound: the check an off-chain service must add"

step "7. expiry"
wait_until "$((T0 + 105))"
expect_fail "coll3: chain session expired" "session expired" coll3 $(pull coll3 500000)
expect_fail "coll4: realm terms expired" "mandate: expired" coll4 $(pull coll4 500000)
eq "HasMandate(payer, 4)" "(false bool)" "$(qeval "$REALM.HasMandate(address(\"$PAYER\"), 4)")"

step "8. hostile payee: burn the allowance as fees"
wait_until "$((T2 + 62))"
p="$(bal "$PAYER")" e="$(bal "$PAYEE")"
# A doomed Pull (no coins) with a fee equal to the whole spend limit, simulation skipped.
tx coll call -pkgpath "$REALM" -func Pull -master "$PAYER" -gas-fee 1100000ugnot -gas-wanted 8000000 -simulate skip || true
grep -q "mandate: send exactly" "$OUT" || fail "unexpected: $(grep -E '^Data:' "$OUT" | head -2)"
burn=$((p - $(bal "$PAYER")))
eq "payer paid the whole spend limit as a fee, and not one ugnot more" 1100000 "$burn"
eq "payee gained nothing" "$e" "$(bal "$PAYEE")"
p="$(bal "$PAYER")"
if tx coll call -pkgpath "$REALM" -func Pull -master "$PAYER" -gas-fee 1000ugnot -gas-wanted 8000000 -simulate skip && grep -q '^OK!' "$OUT"; then fail "second burn succeeded"; fi
eq "a further fee in the same period is refused before any charge" "$p" "$(bal "$PAYER")"
expect_fail "and so is the honest pull for this period" "spend limit" coll $(pull coll 1000000)
realm_zero
T3="$(now)"

step "11. payee pays the fees: one transaction, two signers"
wait_until "$((T3 + 62))"
# The burn's failed tx did not change the mandate, so plan 1 is due again.
p="$(bal "$PAYER")" e="$(bal "$PAYEE")"
printf '%s\n' "$PW" | gnokey maketx call -pkgpath "$OTHER" -func Tip -gas-fee 300000ugnot -gas-wanted 20000000 -broadcast=false -chainid dev -remote "$RPC" -home "$KB" -insecure-password-stdin payee >"$TMP/m1.json" 2>/dev/null
printf '%s\n' "$PW" | gnokey maketx call -pkgpath "$REALM" -func Pull -send 1000000ugnot -master "$PAYER" -gas-fee 300000ugnot -gas-wanted 20000000 -broadcast=false -chainid dev -remote "$RPC" -home "$KB" -insecure-password-stdin coll >"$TMP/m2.json" 2>/dev/null
python3 - "$TMP" <<'PY'
import json, sys
d = sys.argv[1]
def load(p):
    s = open(p).read()
    return json.loads(s[s.index("{"):])
a, b = load(d + "/m1.json"), load(d + "/m2.json")
tx = a
tx["msg"] = a["msg"] + b["msg"]
tx["signatures"] = None
json.dump(tx, open(d + "/multi.json", "w"))
PY
acct() { # prints "<account_number> <sequence>" from an auth/accounts query, at any nesting depth
	python3 -c '
import json, sys
def find(d):
    if isinstance(d, dict):
        if "account_number" in d:
            return d
        for v in d.values():
            r = find(v)
            if r:
                return r
d = find(json.loads(sys.stdin.read().split("data:", 1)[1]))
print(d["account_number"], d.get("sequence", "0"))'
}
read -r PE_NUM PE_SEQ <<<"$(gnokey query "auth/accounts/$PAYEE" -remote "$RPC" -home "$KB" | acct)"
read -r S_NUM S_SEQ <<<"$(gnokey query "auth/accounts/$PAYER/session/$COLL" -remote "$RPC" -home "$KB" | acct)"
echo "  payee account $PE_NUM/$PE_SEQ, session account $S_NUM/$S_SEQ"
printf '%s\n' "$PW" | gnokey sign -tx-path "$TMP/multi.json" -chainid dev -account-number "$PE_NUM" -account-sequence "$PE_SEQ" -output-document "$TMP/sig1.json" -home "$KB" -insecure-password-stdin payee >/dev/null 2>&1 || fail "payee could not sign"
printf '%s\n' "$PW" | gnokey sign -tx-path "$TMP/multi.json" -chainid dev -account-number "$S_NUM" -account-sequence "$S_SEQ" -session -output-document "$TMP/sig2.json" -home "$KB" -insecure-password-stdin coll >/dev/null 2>&1 || fail "session key could not sign"
python3 - "$TMP" <<'PY'
import json, sys
d = sys.argv[1]
tx = json.load(open(d + "/multi.json"))
sigs = [json.load(open(d + "/sig%d.json" % i)) for i in (1, 2)]
tx["signatures"] = sigs
json.dump(tx, open(d + "/multi.json", "w"))
PY
gnokey broadcast "$TMP/multi.json" -remote "$RPC" -home "$KB" >"$OUT" 2>&1 || true
grep -q '^OK!' "$OUT" || fail "two-signer tx failed: $(grep -E '^Data:' "$OUT" | head -2)"
show
eq "payer paid exactly the amount (no fee, no storage)" 1000000 "$((p - $(bal "$PAYER")))"
eq "payee got the amount minus the fee it paid" "$((1000000 - 300000 - $(storage_delta) * 100))" "$(($(bal "$PAYEE") - e))"
realm_zero

step "12. cancel by the payer"
wait_until "$(($(now) + 62))"
expect_ok "payer cancels plan 1's mandate (own key)" payer call -pkgpath "$REALM" -func Cancel -args "$PAYER" -args "$COLL" "${CALL[@]}"
note_gas "Cancel"
expect_fail "pull after cancel" "no active mandate" coll $(pull coll 1000000)
eq "HasMandate(payer, 1)" "(false bool)" "$(qeval "$REALM.HasMandate(address(\"$PAYER\"), 1)")"

step "13. the collector: 32 supporters with the pages' sessions, and the sessions it must skip"
# The pages tell a supporter to create the session with spend limit = price +
# FeeAllowance, spend period = the plan's period, scope = exactly the realm.
ALLOW="$(qeval "$REALM.FeeAllowance" | sed -n 's/^(\([0-9]*\) int64)$/\1/p')"
[[ "$ALLOW" =~ ^[0-9]+$ ]] || fail "could not read FeeAllowance"
expect_ok "Offer plan 5 (1 GNOT / 60 s)" payee call -pkgpath "$REALM" -func Offer -args "Supporter E" -args 1000000 -args 60 "${CALL[@]}"
EXP13="$(($(now) + 1800))"
for k in "${SUPPORTERS[@]}"; do
	a="$(addr_of "$k")" scope="vm/exec:$REALM" limit="$((1000000 + ALLOW))ugnot"
	case "$k" in
	slow) limit="1010000ugnot" ;;          # below price + fee + storage bound
	swide) scope="vm/exec:gno.land/r/mandate_dev" ;; # wider than the realm
	esac
	tx "$k" $(session_args "$GPUB" "$scope" "$limit" 60 "$EXP13") || true
	grep -q '^OK!' "$OUT" || fail "session for $k: $(grep -E '^Data:' "$OUT" | head -1)"
	tx "$k" call -pkgpath "$REALM" -func Subscribe -args 5 -args "$COLL" -args "$EXP13" "${CALL[@]}" || true
	grep -q '^OK!' "$OUT" || fail "Subscribe for $k: $(grep -E '^Data:' "$OUT" | head -1)"
done
echo "  ok: ${#SUPPORTERS[@]} supporters subscribed to plan 5 with sessions for coll"
expect_ok "srevoked revokes its session" srevoked session revoke -pubkey "$GPUB" "${CALL[@]}"
for f in "$TMP"/collect.state.*; do [ -e "$f" ] && [ "$f" != "$TMP/collect.state.lock" ] && fail "a temporary state file was left: $f"; done
echo "999999 1 1" >>"$TMP/collect.state" # a mandate that no longer exists: must be pruned
set +e
out="$(printf '%s\n' "$PW" | "$REPO/scripts/collect.sh" -home "$KB" -key coll -payee "$PAYEE" -remote "$RPC" -chainid dev -realm "$REALM" -state "$TMP/collect.state" -max-checks 100 -insecure-password-stdin 2>&1)"
rc=$?
set -e
echo "$out" | sed 's/^/    /'
eq "collector exit status (a revoked session, a refused pull and junk are not errors)" 0 "$rc"
for k in $(seq 1 32); do
	pt="$(qeval "$REALM.PaidThrough(address(\"$(addr_of "s$k")\"), 5)" | sed -n 's/^(\([0-9]*\) int64)$/\1/p')"
	[ "${pt:-0}" -gt "$(now)" ] || fail "supporter s$k (position $k) was not paid: PaidThrough=$pt"
done
echo "  ok: all 32 first payments went through, the 32nd included (PaidThrough > now for each)"
grep -q "skipping mandate [0-9]* ($(addr_of slow)): the session's spend limit is below" <<<"$out" || fail "low spend limit not skipped"
grep -q "skipping mandate [0-9]* ($(addr_of swide)): the session is not scoped to exactly" <<<"$out" || fail "wide session not skipped"
grep -q "skipping mandate [0-9]* ($(addr_of srevoked)): no session for this key" <<<"$out" || fail "revoked session not skipped"
grep -q "refused on the payer's side (not sent, nothing charged: tried again on the next run)" <<<"$out" || fail "the poor supporter's pull was not reported as refused in simulation"
grep -q "done: 33 pulled or tried, 1 refused on the payer's side, 0 failed, 0 put off to the next period" <<<"$out" || fail "unexpected collector summary"
echo "  ok: low limit, wide scope and revoked sessions skipped with their reason; the poor supporter's pull refused in simulation, nothing charged"
collect13() { # extra collector args; sets out and rc
	set +e
	out="$(printf '%s\n' "$PW" | "$REPO/scripts/collect.sh" -home "$KB" -key coll -payee "$PAYEE" -remote "$RPC" -chainid dev -realm "$REALM" -state "$TMP/collect.state" -insecure-password-stdin "$@" 2>&1)"
	rc=$?
	set -e
	echo "$out" | sed 's/^/    /'
}
p="$(bal "$(addr_of spoor)")"
collect13
eq "second run exit status" 0 "$rc"
grep -q "done: 1 pulled or tried, 1 refused on the payer's side, 0 failed, 0 put off to the next period" <<<"$out" || fail "a pull refused in simulation was not tried again on the next run"
eq "the poor supporter paid nothing for two refusals in simulation" "$p" "$(bal "$(addr_of spoor)")"
echo "  ok: a pull that never reached a block is tried again on the next run, at no cost"
collect13 -simulate skip
eq "third run (no simulation) exit status" 0 "$rc"
grep -q "refused on the payer's side (included in a block and failed, the fee was charged: not tried again before the next period)" <<<"$out" || fail "the included failure was not recognised"
POORFEE="$(fee_of "$out")"
eq "the poor supporter paid one fee" "$POORFEE" "$((p - $(bal "$(addr_of spoor)")))"
collect13
grep -q "1 waiting after a refused pull" <<<"$out" || fail "an included failure was retried in the same period"
eq "and nothing more on the next run" "$POORFEE" "$((p - $(bal "$(addr_of spoor)")))"
echo "  ok: a pull included in a block that failed is put off to the next period: the payer paid one fee, not one per run"
grep -q '^999999 ' "$TMP/collect.state" && fail "state file kept a mandate that is no longer listed"
for f in "$TMP"/collect.state.*; do [ -e "$f" ] && [ "$f" != "$TMP/collect.state.lock" ] && fail "a temporary state file was left: $f"; done
out="$(flock "$TMP/collect.state.lock" -c "printf '%s\n' '$PW' | '$REPO/scripts/collect.sh' -home '$KB' -key coll -payee '$PAYEE' -remote '$RPC' -chainid dev -realm '$REALM' -state '$TMP/collect.state' -insecure-password-stdin -dry-run" 2>&1)" || true
grep -q "holds $TMP/collect.state.lock; nothing done" <<<"$out" || fail "a run started while another holds the lock went ahead: $out"
echo "  ok: a second run while another holds the lock does nothing"
echo "  ok: state file pruned to listed mandates ($(wc -l <"$TMP/collect.state") lines), no temporary file left"
eq "realm balance" 0 "$(bal "$REALM_ADDR")"

step "14. leaving and coming back within a paid period is not charged twice"
S1="$(addr_of s1)" S2="$(addr_of s2)"
pt_of() { qeval "$REALM.PaidThrough(address(\"$1\"), 5)" | sed -n 's/^(\([0-9]*\) int64)$/\1/p'; }
PT1="$(pt_of "$S1")" PT2="$(pt_of "$S2")"
[ "${PT1:-0}" -gt "$(now)" ] && [ "${PT2:-0}" -gt "$(now)" ] || fail "s1 and s2 are not paid ahead ($PT1, $PT2)"
# s1 comes back with a session for another key: the chain's spend window for
# it is fresh, so only the realm's carried-over time stops a second charge.
expect_ok "s1 cancels its paid mandate" s1 call -pkgpath "$REALM" -func Cancel -args "$S1" -args "$COLL" "${CALL[@]}"
eq "PaidThrough kept after the cancel" "$PT1" "$(pt_of "$S1")"
expect_ok "s1 gives a fresh session to coll2 (1.1 GNOT / 60 s)" s1 $(session_args "$GPUB2" "vm/exec:$REALM" 1100000ugnot 60 "$EXP13")
expect_ok "s1 subscribes again, with coll2" s1 call -pkgpath "$REALM" -func Subscribe -args 5 -args "$COLL2" -args "$EXP13" "${CALL[@]}"
note_gas "Subscribe (returning payer, paid time carried over)"
md="$(gnokey query vm/qrender -data "$REALM:payer/$S1" -remote "$RPC" -home "$KB")"
grep -q "your current period is already paid" <<<"$md" || fail "payer page does not say the period is paid"
p="$(bal "$S1")"
expect_fail "an immediate pull with the fresh session (the chain would allow it)" "mandate: too early" coll2 call -pkgpath "$REALM" -func Pull -send 1000000ugnot -master "$S1" "${PULLGAS[@]}"
eq "s1 paid nothing for it (refused in simulation)" "$p" "$(bal "$S1")"
# s2 comes back with the same key; the collector must wait.
expect_ok "s2 cancels its paid mandate" s2 call -pkgpath "$REALM" -func Cancel -args "$S2" -args "$COLL" "${CALL[@]}"
expect_ok "s2 subscribes again, same key" s2 call -pkgpath "$REALM" -func Subscribe -args 5 -args "$COLL" -args "$EXP13" "${CALL[@]}"
p2="$(bal "$S2")"
collect13
grep -q "pulling mandate [0-9]*: 1000000ugnot from $S2" <<<"$out" && fail "the collector pulled s2 inside its paid period"
echo "  ok: the collector waits for s2's paid period to end"
wait_until "$((PT1 > PT2 ? PT1 + 1 : PT2 + 1))"
expect_ok "s1's first pull of the new mandate, when the paid period has ended" coll2 call -pkgpath "$REALM" -func Pull -send 1000000ugnot -master "$S1" "${PULLGAS[@]}"
CARRY_DELTA="$(storage_delta)"
note_gas "Pull (first, after carried-over time)"
eq "s1 paid exactly one price and one fee, plus that pull's storage" "$((1000000 + 20000 + CARRY_DELTA * 100))" "$((p - $(bal "$S1")))"
[ "$CARRY_DELTA" -le 100 ] || fail "that first pull added more than 100 B"
collect13
grep -q "pulling mandate [0-9]*: 1000000ugnot from $S2" <<<"$out" || fail "the collector did not pull s2 when its paid period ended"
eq "s2 paid exactly one price and one fee, plus that pull's storage" "$((1000000 + $(fee_of "$out") + $(awk -v a="$S2" '$0 ~ "from " a {f=1; next} f && /STORAGE DELTA/ {print $3; exit}' <<<"$out") * 100))" "$((p2 - $(bal "$S2")))"
eq "realm balance" 0 "$(bal "$REALM_ADDR")"

step "15. the chain's limits, and a 30-day plan end to end with the pages' exact commands"
SMAX="$(addr_of smax)"
expect_fail "a session with a spend period one second over 30 days (the chain's limit)" "spend_period exceeds maximum" smax $(session_args "$GPUB3" "vm/exec:$REALM" 1100000ugnot 2592001 "$EXP13")
expect_ok "a session with a spend period of exactly 30 days" smax $(session_args "$GPUB3" "vm/exec:$REALM" 1100000ugnot 2592000 "$EXP13")
expect_fail "a plan one second over 30 days" "period is above the maximum" payee call -pkgpath "$REALM" -func Offer -args "Too long" -args 1000000 -args 2592001 "${CALL[@]}"
expect_ok "a plan of exactly 30 days (MaxPeriod)" payee call -pkgpath "$REALM" -func Offer -args "Supporter F" -args 1000000 -args 2592000 "${CALL[@]}"
MAXPLAN="$(qeval "$REALM.Totals()" | head -1 | sed -n 's/^(\([0-9]*\) int)$/\1/p')"
[[ "$MAXPLAN" =~ ^[0-9]+$ ]] || fail "could not read the new plan's id"
# The page's commands, exactly as printed, pointed at this local chain.
localize() { sed -e "s| -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 | -chainid dev -remote $RPC |" -e "s| $2\$| -home $KB -insecure-password-stdin $1|"; }
run_page_cmd() { # <what> <key> <placeholder> <command line from a page>
	local what="$1" key="$2" ph="$3" cmd
	cmd="$(printf '%s\n' "$4" | localize "$key" "$ph")"
	grep -q -- "-chainid dev -remote $RPC" <<<"$cmd" || fail "$what: the page's command does not have the expected network flags: $4"
	echo "  running the page's command: ${4:0:120}..."
	printf '%s\n' "$PW" | eval "$cmd" >"$OUT" 2>&1 || true
	grep -q '^OK!' "$OUT" || fail "$what: the page's exact command was refused: $(grep -E '^Data:' "$OUT" | head -2)"
	echo "  ok: $what"
}
plan_page="$(gnokey query vm/qrender -data "$REALM:plan/$MAXPLAN" -remote "$RPC" -home "$KB")"
grep -q "every 30 days" <<<"$plan_page" || fail "the plan page does not say every 30 days"
run_page_cmd "session create from the plan page (spend period 2592000, expiry one year)" smax YOUR_KEY "$(grep -m1 '^gnokey maketx session create' <<<"$plan_page")"
run_page_cmd "Subscribe from the plan page" smax YOUR_KEY "$(grep -m1 -- '-func Subscribe' <<<"$plan_page")"
help_page="$(gnokey query vm/qrender -data "$REALM:help" -remote "$RPC" -home "$KB")"
pullcmd="$(grep -m1 -- '-func Pull ' <<<"$help_page" | sed "s/AMOUNTugnot/1000000ugnot/; s/SUPPORTER_ADDRESS/$SMAX/")"
run_page_cmd "Pull with the help page's command (today's minimum fee)" coll COLLECTOR_KEY "$pullcmd"
PTMAX="$(qeval "$REALM.PaidThrough(address(\"$SMAX\"), $MAXPLAN)" | sed -n 's/^(\([0-9]*\) int64)$/\1/p')"
CT="$(chain_time)"
[ "${PTMAX:-0}" -gt $((CT + 2592000 - 120)) ] && [ "$PTMAX" -le $((CT + 2592000)) ] || fail "PaidThrough $PTMAX is not 30 days after the pull (chain time $CT)"
echo "  ok: paid through $PTMAX, 30 days after the pull"
payer_page="$(gnokey query vm/qrender -data "$REALM:payer/$SMAX" -remote "$RPC" -home "$KB")"
run_page_cmd "revoke from the payer page" smax YOUR_KEY "$(grep -m1 '^gnokey maketx session revoke -pubkey '"$GPUB" <<<"$payer_page")"
run_page_cmd "Cancel from the payer page" smax YOUR_KEY "$(grep -m1 -- "-func Cancel -args $SMAX -args $COLL" <<<"$payer_page")"
eq "realm balance" 0 "$(bal "$REALM_ADDR")"

step "pages in gnoweb"
page="$(curl -s "http://127.0.0.1:$WEB_PORT/r/mandate_dev/mandate:plan/1")"
grep -q "Supporter A" <<<"$page" || fail "plan page does not render"
md="$(gnokey query vm/qrender -data "$REALM:payer/$PAYER" -remote "$RPC" -home "$KB")"
grep -q "Status here: \*\*cancelled\*\*" <<<"$md" || fail "payer page does not show the cancelled mandate"
grep -q "Status here: \*\*active\*\*" <<<"$md" || fail "payer page does not show active mandates"
echo "  ok: plan and payer pages render"

step "totals and gas"
qeval "$REALM.Totals()" | tr '\n' ' ' | sed 's/^/  Totals: /'
echo
sed 's/^/  /' "$GAS_REPORT"
eq "realm balance at the end" 0 "$(bal "$REALM_ADDR")"
echo
echo "ALL CHECKS PASSED"
