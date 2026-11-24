# Deploying Mandate to Onyx

For the owner. One command publishes the realm; everything else here is checking and first use. Every command
targets the Onyx test network only (`onyx-1`, `https://rpc.onyx.testnets.gno.land:443`, test GNOT).

- Deploy address and namespace: `g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8` (key `questmaster-deploy`)
- Realm: `gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate`
- Code: branch `onyx` (the reviewed commit f0bbdc7 with the namespace set; see "What is uploaded")

Use only the keybase that holds the deploy key. **Never use, list or touch any other key or key folder** (such as
the default gnokey home `~/.config/gno`). Every command below passes `-home "$HOME/.gno-questmaster"`, the keybase
that holds `questmaster-deploy`, and an explicit `-remote`, because gnokey's defaults point at a local node. Nothing
in this kit reads that keybase: only the commands you run do.

**The one rule that never expires:** nothing may ever be deployed under `gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate/`.
A supporter's session for the realm also allows every path under it (the chain matches scopes by prefix), so a
package there could take supporters' money.

## What leaves the wallet

Measured and read on 2026-11-23. Onyx today: gas price 1 ugnot per 1,000 gas, storage 100 ugnot per byte,
code submission policy "inert" (packages are parked until an approver enables them).

| Step | Gas | Fee set below | Storage deposit | When |
|---|---|---|---|---|
| Deploy (addpkg) | about 240 million: 1,250 gas per byte of the 188,485 bytes uploaded, charged at submit, plus the transaction itself | 1 GNOT for 400,000,000 gas wanted | about 8.45 GNOT (84,476 bytes, measured on a local chain), capped by `-max-deposit 30000000ugnot` | fee now; deposit when the package is enabled |
| Publish the example plan (first use) | under 10 million | 0.1 GNOT | about 0.62 GNOT (6,173 bytes) | now |
| Publish the collector key (first use) | under 10 million | 0.1 GNOT | about 0.02 GNOT (194 bytes) | now |

The deploy address holds about 293 GNOT, far more than the 10 GNOT the deploy needs. The gas fee you set is charged
in full, whatever gas is used.

## 1. Deploy (the one command)

From the repository root, on the branch `onyx`:

```sh
gnokey maketx addpkg -home "$HOME/.gno-questmaster" \
  -pkgpath "gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate" -pkgdir ./r/mandate \
  -max-deposit 30000000ugnot -gas-fee 1000000ugnot -gas-wanted 400000000 \
  -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 questmaster-deploy
```

It asks for the key's password, then prints `OK!`, the gas used and a `TX HASH`. Keep the hash.

Optional, before it: the same command with `-simulate only` added signs and simulates without sending anything and
prints the gas it needs. (Onyx does not simulate a package upload without a signature, so only you can do this.)

## 2. Check that it is there, and whether it is still parked

```sh
gnokey query -home "$HOME/.gno-questmaster" vm/qpkgmeta_json \
  -data "gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate" -remote https://rpc.onyx.testnets.gno.land:443
```

- Parked, waiting for approval: `{"path":"…/mandate","status":"inert",…,"reason":"waiting for a package approver to enable it","pending":true}`
- Enabled: `{"path":"…/mandate","status":"live",…}`
- Not there: `{"path":"…/mandate","status":"absent"}`

The approver's verdict: https://gpas.onyx.testnets.gno.land/?path=gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate
(`pending` = in the queue, wait; `approved` = enabled; `rejected` with a reason = it will not be enabled, see "If
something is wrong"; `gave_up` or `blocked` = ask in the Gno.land Discord).

Plan for waiting: QuestMaster's realm, submitted from this address, was still parked ("inert") on 2026-11-23,
hours after its submission, while its escrow package was enabled quickly.

## 3. Ask for activation (only if it stays parked)

Post in the Gno.land Discord (the testnet or builders channel):

> Hi! I submitted `gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate` to Onyx (tx `<TX HASH>`) for the
> Gnome Tavern hackathon. gpas shows it as `<status>`. It imports only live packages (p/nt/avl/v0,
> p/nt/markdown/sanitize/v0; tests use p/nt/uassert/v0 and p/nt/testutils/v0). Could an approver enable it?
> Thank you!

## 4. Check that what is on chain is what was reviewed

```sh
scripts/verify-deploy.sh
```

It reads the package's files back from Onyx with free queries (no key) and compares each with `r/mandate`. Every
line must say `same`, and the last line `OK: the package on chain is identical`. The chain adds the creator to
`gnomod.toml`; that addition is ignored. `docs/deploy-checksums.txt` lists the sha256 of every uploaded file.

## 5. Look at it

Open https://onyx.testnets.gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate (it works once the package
is live): the home page shows "No plan has been paid for…", the help page shows the realm's real path in every
command, and the footer shows `source code: github.com/elangrr/mandate` (the link works once that repository is
public).

## 6. First use: one example plan under the Fluxen name

Once the realm is live. These publish a plan from `questmaster-deploy` and give it a collector key.

**a. Make a collector key** (a new key, only for collecting; it never needs coins):

```sh
gnokey add -home "$HOME/.gno-questmaster" mandate-collector
gnokey list -home "$HOME/.gno-questmaster"
```

Note the `pub: gpub1…` value shown for `mandate-collector`. **Never send coins to its address**, not even 1 ugnot:
an address that has received coins is an account, and the chain then refuses every new session for that key, so
nobody new could subscribe (supporters pay every fee; the collector key needs none).

**b. Publish the plan** (1 GNOT every 30 days; about 0.62 GNOT deposit plus the 0.1 GNOT fee):

```sh
gnokey maketx call -home "$HOME/.gno-questmaster" \
  -pkgpath "gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate" -func Offer \
  -args "Support Fluxen's work" -args 1000000 -args 2592000 \
  -gas-fee 100000ugnot -gas-wanted 60000000 \
  -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 questmaster-deploy
```

**c. Publish the collector key** (replace `GPUB_OF_MANDATE_COLLECTOR` with the `gpub1…` from step a; about 0.02 GNOT
deposit plus the 0.1 GNOT fee):

```sh
gnokey maketx call -home "$HOME/.gno-questmaster" \
  -pkgpath "gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate" -func SetCollectorKey \
  -args GPUB_OF_MANDATE_COLLECTOR \
  -gas-fee 100000ugnot -gas-wanted 60000000 \
  -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 questmaster-deploy
```

The plan page (`…/mandate:plan/1`) now shows the commands a supporter runs.

**d. Collect** (whenever payments are due; at least once a period, every 10 minutes is fine):

```sh
scripts/collect.sh -home "$HOME/.gno-questmaster" -key mandate-collector \
  -payee g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8 \
  -remote https://rpc.onyx.testnets.gno.land:443 -chainid onyx-1 \
  -realm gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate
```

It asks for the collector key's password once, then pulls what is due. Add `-dry-run` to only list.

## If something is wrong after deploying

A package can never be changed or replaced at the same path, and a parked one should not be submitted again. Fix the
code, run all tests and `scripts/local-flow.sh`, and deploy to a new path
(`gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate/v2` is NOT allowed: it is under the realm's path; use
`gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate2` instead). Mandates on the old realm keep working until
they expire or are cancelled.

## What is uploaded

`-pkgdir ./r/mandate` uploads every file in that folder: the code (`escape.gno`, `mandate.gno`, `reads.gno`,
`render.gno`, `store.gno`), `gnomod.toml`, the tests (`mandate_test.gno`, `render_test.gno`, `store_test.gno`) and the
two filetests in `filetests/`, as QuestMaster did. The tests are not stored as part of the realm's state (the
deposit is the same 84,476 bytes with or without them, measured) and only add gas at submit; uploading them keeps
the on-chain source identical to what was reviewed, tests included.

The branch `onyx` is commit f0bbdc7 with `scripts/set-namespace.sh g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8`
applied. Running that script on a clean export of f0bbdc7 gives byte-identical files (checked; checksums in
`docs/deploy-checksums.txt`).
