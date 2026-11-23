# Verified Gno facts

Each fact was checked in the source of gno v1.8.0 (commit fc79041f4, `github.com/gnolang/gno`), on a local chain, or with a read-only query to Onyx, in November 2026. Paths are relative to the gno repository unless they start with `r/`, `scripts/` or `web/`.

## Network

- Onyx (`onyx-1`) runs v1.8.0-rc.1 at commit fc79041f4 since height 1,203,400 (2026-11-17): `misc/deployments/onyx.gno.land/UPGRADES.md` on branch `chain/mainnet`. That is the commit this repository is tested with.
- The packages Mandate imports are live on Onyx: `vm/qpkgmeta_json` answers `"status":"live"` for `gno.land/p/nt/avl/v0`, `gno.land/p/nt/markdown/sanitize/v0`, `gno.land/p/nt/uassert/v0` and `gno.land/p/nt/testutils/v0`.
- The Onyx RPC answers `abci_query` over GET with `Access-Control-Allow-Origin: *`; for an account without sessions, `auth/accounts/<addr>/sessions` returns `Data: "bnVsbA=="` (base64 of `null`).

## Sessions

- A realm sees a session through `runtime.GetSessionInfo() (pubKeyAddr address, expiresAt int64, allowPaths []string, isSession bool)`: `gnovm/stdlibs/chain/runtime/native.gno:13-35`. When the signer is a session, `unsafe.OriginCaller()` is the master account (the payer).
- A session's scope entry `vm/exec:<path>` matches the path itself and every path under it: `path == e.Path || strings.HasPrefix(path, e.Path+"/")`, `gno.land/pkg/gnoland/app.go:1755`. Shown on a real chain by `scripts/local-flow.sh` step 10.
- Sessions can never sign `auth/*` messages (create or revoke sessions) or `vm/add_package`: `sessionAlwaysDenied`, `gno.land/pkg/gnoland/app.go:1687-1690`. gnokey also refuses `-master` with `session create/revoke/revokeall` (`tm2/pkg/crypto/keys/client/session_commands_test.go:386`).
- At most 16 sessions per account (`MaxSessionsPerAccount`, `tm2/pkg/std/account.go:303`); a session lasts at most about 4 years (`MaxSessionDuration`, line 310).
- Spend limit: gas fee, coins sent and storage deposits count against it (`tm2/pkg/sdk/auth/spend.go`, `gno.land/pkg/sdk/vm/keeper.go:2628-2636`); refunds do not give budget back. The window resets at the first spend at or after `reset + period` (`DeductSessionSpend`, spend.go). A transaction whose fee plus sends would exceed what is left is refused before any fee is charged (`CheckSessionSpend`, `tm2/pkg/sdk/auth/ante.go:185-201`). The fee is taken from the first signer, always the master (ante.go:204).
- A revoked session: gnokey cannot even build the transaction ("cannot decode empty bytes"); a signed one is refused as "unknown session" (ante.go:171). An expired one: "session expired: expires_at=..., block_time=..." (ante.go:176).
- Two signers in one transaction (payee first, paying the fee; then the session key): sign each with `gnokey sign -output-document` (the session key with `-session`, which adds `session_addr`), using the payee's account number and sequence and the session account's own number and sequence (`auth/accounts/<payer>/session/<key>`), put the signatures in signer order and `gnokey broadcast`. Signing in place fails because gnokey validates after each signature. Done in `scripts/local-flow.sh` step 11.
- `chain.PubKeyAddress(bech32PubKey string) (address, error)` derives an address from a `gpub1...` key (`gnovm/stdlibs/chain/address.gno:112`); it is in fc79041f4, so on Onyx.
- A `gpub1...` key is bech32 of the protobuf `Any{type_url: "/tm.PubKeySecp256k1", value: PubKeySecp256k1{key: <33 bytes>}}`; the address is bech32 `g` of RIPEMD-160(SHA-256(33-byte key)) (`tm2/pkg/crypto/secp256k1/secp256k1.go:122-130`). Checked against gnokey in `web/adena-test.test.mjs`.

## gnokey (v1.8.0)

- `gnokey maketx` broadcasts by default (`-broadcast` defaults to true, `tm2/pkg/crypto/keys/client/maketx.go:99`); `-broadcast=false` prints the unsigned transaction.
- Its default `-remote` is `127.0.0.1:26657` and its default `-home` is the user's key folder: every command in this repository passes both explicitly.
- `gnokey add -insecure-password-stdin -nobackup -quiet <name>` creates a key without printing the mnemonic.
- `session create` takes `-expires-at` as a unix time (or a duration such as `30m`), `-spend-period` in seconds.

## Testing

- `gno test` cannot sign with a session key, so `GetSessionInfo` always reports "not a session" there.
- Realm tests are `func TestX(cur realm, t *testing.T)`; `testing.SetRealm` changes only the frame that calls it, so it is called inline right before each `F(cross(cur))`.
- A panic does not revert realm state under `gno test`; on chain the transaction reverts. The tests therefore snapshot all state before every refused call and compare after it.
- `testing.SkipHeights(n)` moves the block time by 5·n seconds (`gnovm/tests/stdlibs/testing/context_testing.gno:105-110`).
- A filetest directive with empty content (for example a bare `// Events:`) is skipped, so it matches anything (`gnovm/pkg/test/filetest.go:591`). Put a placeholder line under it and run `gno test -update-golden-tests` to record it.
- gnodev makes no empty blocks by default, so queries see the time of the last transaction's block; `scripts/local-flow.sh` runs it with `-empty-blocks` so "is it due?" answers match the clock, as on a real chain.

## Storage and gas

- Each insert into a `p/nt/avl/v0` tree writes two nodes of about 1 KB each including their heap items (measured with a filetest's `// Realm:` ops). At 100 ugnot per byte, that is about 0.2 GNOT per insert. Gas for a tree operation grows with the tree's depth, about 1M gas per level loaded.
- Fields that go from zero to non-zero grow an object (amino omits zero values); after that, rewriting the same fields adds nothing. That is why only the first Pull of a mandate adds storage (22 bytes).
- Gas used by any call of this realm starts at about 2.4M (a refused call through the session guard), mostly loading the realm.

## Adena (onbloc/adena-wallet e71fa1b, v1.22.5)

- The injected API is `window.adena` with `AddEstablish(name)`, `GetAccount()`, `GetNetwork()`, `SwitchNetwork(chainId)`, `AddNetwork({chainId, chainName, rpcUrl})`, `DoContract({messages, memo})` (`packages/adena-extension/src/inject.ts`). `DoContract` takes no gas fields; the wallet estimates.
- `DoContract` accepts `/auth.m_create_session`, `/auth.m_revoke_session` and `/auth.m_revoke_all_sessions` (`inject/executor/executor.ts:378-392`), validated by `common/validation/validation-message.ts:134-190`.
- The extension encodes them in `packages/adena-module/src/utils/messages.ts` (`encodeMessageValue`): `session_key` is an `Any` whose `value` may be base64 of the protobuf `PubKeySecp256k1{key}` (`0a 21 <33 bytes>`); `expires_at` and `spend_period` may be decimal strings; `spend_limit` is a coin string such as `1000ugnot`. Its own test `messages.spec.ts` "round trips JSON-safe create session messages" uses that shape, which `web/adena-test.html` builds.
- Not yet tried in a real browser with the store build; that is what `web/adena-test.html` is for.
