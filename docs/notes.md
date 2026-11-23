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
- **The chain's limits on a session** (gno fc79041f4, the commit Onyx runs), all checked by `MsgCreateSession`'s handler (`tm2/pkg/sdk/auth/handler.go:41-110`):
  - at most 16 sessions per account (`MaxSessionsPerAccount`, `tm2/pkg/std/account.go:303`; handler.go:72-80, "too many sessions"), and one session per (account, key) ("session key already exists", handler.go:68). Since all of a creator's plans are collected by one key, a supporter can hold one plan of each creator at a time;
  - spend period at most 30 days (`MaxSpendPeriod` = 2,592,000 s, account.go:314; handler.go:82, "spend_period exceeds maximum"). Mandate's `MaxPeriod` is exactly this since M1.6. Shown on a local chain by `scripts/local-flow.sh` step 15: 2,592,000 accepted, 2,592,001 refused;
  - expiry in (block time, block time + 4 × 365 days] (`MaxSessionDuration`, account.go:310; handler.go:48-58); 0 means none. The pages print one year;
  - at most 8 allow paths, none empty or ending in "/" (`MaxAllowPathsPerSession`, account.go:304; handler.go:86-101). The pages print exactly one, `vm/exec:<realm>`;
  - a spend limit of valid coins (`ValidateBasic`, `tm2/pkg/sdk/auth/msgs.go:52`). The pages print `<n>ugnot`;
  - the session key's address must not be an existing account (handler.go:63-65). Receiving any coin creates the account for good (`ensureAccount`, `tm2/pkg/sdk/bank/keeper.go:238-244`, called at :437), so one 1 ugnot send to a published collector key blocks every new session for it; existing sessions keep working (the ante looks them up by payer and key, `tm2/pkg/sdk/auth/ante.go:168-178`). Shown on a local chain by `scripts/local-flow.sh` step 16.
- A realm can read balances during `Render` (`banker.NewReadonlyBanker`): flow 16 shows the plan page reacting to the collector key's balance in a `vm/qrender` query.
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
- Fields that go from zero to non-zero grow an object (amino omits zero values); after that, rewriting the same fields adds nothing. That is why only the first Pull of a mandate adds storage (a few dozen bytes; measured bound in docs/design.md).
- Gas used by any call of this realm starts at about 2.4M (a refused call through the session guard), mostly loading the realm.

- Fees: the chain charges the whole gas fee the signer sets, whatever gas is used, and accepts it when fee ÷ gas wanted ≥ the block gas price and the node's minimum (`EnsureSufficientMempoolFees`, `tm2/pkg/sdk/auth/ante.go:548-600`). `gnokey query auth/gasprice` on Onyx answered `{"gas": "1000", "price": "1ugnot"}` (read-only, 2026-11-23); the chain raises it when blocks are full. Its storage price is fixed by a parameter: 100 ugnot per byte (`gnokey query params/vm:p:storage_price`, read-only, 2026-11-23).
- Gas for store access (`tm2/pkg/store/types/gas.go:405-420`, charged in `tm2/pkg/store/cache/store.go:139-192`): only the flat costs are multiplied by the store's expected depth, which is the bit length of the number of keys (`expectedDepth100`, `tm2/pkg/store/iavl/store.go:45`); the per-byte costs are not. A read costs 59,000 × depth plus 17 per byte; a write costs 59,000 × depth (it reads the path) plus 24,000 × depth plus 14 per byte; amino adds 3 per byte each way. So gas is mostly per object touched, and a chain with more keys (Onyx) charges more per object than a fresh local chain.
- Measured storage per entry (filetest realm ops): avl insert about 2.2 KB (two nodes with heap items); a map entry about 200–400 bytes; a pointer appended to a slice about 200 bytes; a struct behind a pointer adds a heap item of about 350 bytes. `make([]T, 0, n)` stores all n slots, empty or not.
- Appending to a slice rewrites its whole backing array object (gas grows with its length); Mandate keeps long lists in chunks for that reason.
- **Pointers to shared objects are dear to rewrite** (measured on a local chain with a probe realm, M1.3): saving an array that holds pointers to objects referenced from more than one place ("escaped" objects, such as a Mandate held by its payer's record and by a plan's list) costs about 0.37M gas per such pointer. Appending one pointer to an array of 31 cost 13.4M gas; to an array of 0, 2.7M. The same array of values (no pointers) costs only its bytes. Mandate's plan lists therefore store values (payer address and mandate id).
- **Storage refunds go to the signer of the transaction that frees the bytes**, not to whoever paid for them, at the realm's average price: deposit × released ÷ realm storage (`gno.land/pkg/sdk/vm/keeper.go:2561-2598`; with no restricted denoms, as on Onyx, the refund is paid in GNOT to the caller).
- **Queries have a gas cap of 3,000,000,000** (`DefaultQueryMaxGas`, `gno.land/pkg/sdk/vm/keeper.go:55`). Mandate's reads are bounded per call (at most 200 mandates looked up, 1,000 list entries walked) and return a cursor; measured worst cases are in docs/design.md.
- **Measuring with many accounts:** gnodev applies genesis transactions (`-txs-file`) through the normal handlers without checking signatures, so thousands of accounts can act given only their public keys, with balances from `-balance-file` (`scripts/measure-shared.sh`).

## Adena (onbloc/adena-wallet e71fa1b, v1.22.5)

- The injected API is `window.adena` with `AddEstablish(name)`, `GetAccount()`, `GetNetwork()`, `SwitchNetwork(chainId)`, `AddNetwork({chainId, chainName, rpcUrl})`, `DoContract({messages, memo})` (`packages/adena-extension/src/inject.ts`). `DoContract` takes no gas fields; the wallet estimates.
- `DoContract` accepts `/auth.m_create_session`, `/auth.m_revoke_session` and `/auth.m_revoke_all_sessions` (`inject/executor/executor.ts:378-392`), validated by `common/validation/validation-message.ts:134-190`.
- The extension encodes them in `packages/adena-module/src/utils/messages.ts` (`encodeMessageValue`): `session_key` is an `Any` whose `value` may be base64 of the protobuf `PubKeySecp256k1{key}` (`0a 21 <33 bytes>`); `expires_at` and `spend_period` may be decimal strings; `spend_limit` is a coin string such as `1000ugnot`. Its own test `messages.spec.ts` "round trips JSON-safe create session messages" uses that shape, which `web/adena-test.html` builds.
- First real-browser run (Firefox add-on 1.22.5, the store's version, Nov 2026):
  - Adena accepted a page's `/auth.m_create_session` request, showed its approval, signed and broadcast it.
  - The chain refused it with `InsufficientFeeError`: Gas-Wanted 2,000,000,000, Gas-Fee 100,000ugnot.
  - The cause and the fix are below.
- **Confirmed on Onyx with the fix** (2026-11-23, Firefox, Adena 1.22.5): `DoContract` with `/auth.m_create_session` and gasWanted 5,000,000 / gasFee 10,000 returned TRANSACTION_SUCCESS, and a read-only sessions query showed the session with exactly the requested spend limit, period, allow path and expiry. `/auth.m_revoke_session` with the same gas also succeeded, and the sessions query then returned none. Transactions: create d353b2dcd83279fb23e76eb33556deaade25a22e3cfc9a7a72e94d767035cc3b, revoke ff3f0a74a829d15a2b5c50153673fca01100e3daa9c776f1165b95bd4b1fef66 (Onyx).

### What a page must send so Adena signs a session transaction with sane gas

Checked in Adena v1.22.5. Its relevant code is identical to e71fa1b, and the static fee dates from the first session release, v1.20.0 (#853).

1. **Adena never estimates gas for a request made only of session messages** (`/auth.m_create_session`, `/auth.m_revoke_session`, `/auth.m_revoke_all_sessions`).
   - The approval popup sees such a document as a "static session-admin fee" document (`hooks/wallet/transaction-gas/session-admin-static-fee.ts`, used by `hooks/wallet/use-network-fee.ts`).
   - It skips simulation and signs exactly the fee in the document.
   - It offers three fee tiers, but all three are copies of that fee, and the gas adjustment applies only to simulated tiers. **The user cannot fix a bad fee in the popup.**
2. **The fee in the document comes from the request.**
   - The popup calls `createDocument(account, chainId, messages, prefix, requestData.data.gasWanted, requestData.data.gasFee, memo)` (`pages/popup/wallet/approve-transaction-main/index.tsx`).
   - `createDocument` (`services/transaction/transaction.ts`) writes `fee.gas = (gasWanted || DEFAULT_GAS_WANTED)` and `fee.amount = (gasFee || DEFAULT_GAS_FEE) ugnot`. The defaults are 2,000,000,000 gas and 100,000 ugnot (`common/constants/tx.constant.ts`).
   - No chain with a gas price accepts that: at Onyx's 1 ugnot per 1,000 gas, 2,000,000,000 gas needs 2,000,000 ugnot.
3. **So the page must send `gasWanted` and `gasFee` in the `DoContract` parameters**, next to `messages` and `memo`: `adena.DoContract({ messages, memo, gasWanted: 5000000, gasFee: 10000 })`.
   - Both are whole numbers: `gasWanted` in gas units, `gasFee` in ugnot.
   - They reach the popup unchanged: JSON in the popup URL, no validation strips them. Numeric strings also work, because the code calls `.toString()`.
   - **0 or a missing value silently becomes the default**, so the page must never send 0.
4. **The chain accepts the fee when gasFee ÷ gasWanted ≥ the current gas price** (`EnsureSufficientMempoolFees`, `tm2/pkg/sdk/auth/ante.go:548`). The whole fee is charged, whatever gas is used.
   - The page reads the price first, read-only: `auth/gasprice` on Onyx returns `{"gas":"1000","price":"1ugnot"}`.
   - It refuses to send a fee below the minimum.
5. **Measured gas** (read-only `.app/simulate` on Onyx, no signature, no broadcast; 2026-11-23):
   - MsgCreateSession used **1,358,215 gas**, the same as on a local chain.
   - The page's default of 5,000,000 gas wanted for 10,000 ugnot (0.01 GNOT) is 3.7x the gas and 2x today's minimum price.
   - Revoke used 0.93M gas locally. It cannot be simulated without an existing session, and the same default covers it.
6. **The same applies to the Mandate web app's one-popup subscribe**: create session plus a `/vm.m_call` Subscribe in one request.
   - A `/vm.m_call` in the request means the document is not session-only. Per the source, Adena then simulates it and its popup replaces the request's gas with its estimate tiers (`updateTransactionData`); the request's values only seed the simulation document.
   - That combination is not yet tested in a browser. The app should still send explicit `gasWanted` and `gasFee` sized for both messages (Subscribe uses up to about 12M gas), so the document Adena simulates starts from sane values rather than its 2,000,000,000 default. What the popup does when that simulation fails is not checked yet.
7. **Proof without a public transaction:** `web/adena-check/page-request.spec.ts` runs the page's request through Adena v1.22.5's own code and asserts the gas and fee it would sign.
