# Checking the page's request against Adena's own code

`page-request.spec.ts` runs the request that `web/adena-test.html` sends through the code of the Adena wallet itself, version 1.22.5 (the version the Firefox add-on store ships in November 2026). It covers:

- the injected API's validators;
- the transport to the approval popup;
- `TransactionService.createDocument`;
- the static session fee path;
- `documentToTx` encoding.

It then asserts the gas and fee that Adena would sign. It also reproduces the failure seen on Onyx: without explicit gas, Adena signs its fallback of 2,000,000,000 gas for 100,000 ugnot.

It is not run by this repository's tests, because it needs an Adena checkout:

```
git clone https://github.com/onbloc/adena-wallet && cd adena-wallet && git checkout v1.22.5
YARN_ENABLE_SCRIPTS=false corepack yarn install --mode=skip-build
mkdir packages/adena-extension/src/mandate-check
cp <this repo>/web/adena-check/page-request.spec.ts packages/adena-extension/src/mandate-check/
cd packages/adena-extension
PAGE=<this repo>/web/adena-test.html corepack yarn jest --ci src/mandate-check
```

## The web app's requests

`app-request.spec.ts` does the same for every request the web app (`web/app`) sends: the first and second approval of subscribing, the first and second approval of stopping, and the one-approval form of each. The requests themselves are in `app-requests.json`, which `web/app/src/lib/tx.test.ts` builds with the app's own builders and compares on every unit test run (`UPDATE_ADENA_REQUESTS=1 npm test` rewrites it after a deliberate change).

The spec checks:

- every request passes Adena's validators and the popup transport;
- a request with only a permission message (create or revoke) is signed with exactly the page's gas and fee (5,000,000 gas), never Adena's fallback;
- a request with a realm call is simulated by Adena, starting from the page's non-zero gas;
- the encoded messages decode back to the same permission terms, realm path, function and arguments.

```
cp <this repo>/web/adena-check/app-request.spec.ts packages/adena-extension/src/mandate-check/
REQUESTS=<this repo>/web/adena-check/app-requests.json corepack yarn jest --ci src/mandate-check/app-request.spec.ts
```

Last run (v1.22.5): 7 of 7 passed.

## How the web app calls DoContract

`popup-options.spec.ts` loads Adena's own injected API (`src/inject.ts`) and calls `window.adena.DoContract(request, { isVisibleResult: false })` the way the web app does, for every request in `app-requests.json`. It checks that the request reaching the approval popup carries `isVisibleResult: false` and `commit: true`, so the popup's own test (`requestData?.data?.isVisibleResult !== false`) turns its result screen off. The popup then sends the transaction's real reply and closes itself once the block is in, instead of waiting on a result screen where closing the window would reach the page as TRANSACTION_REJECTED although the transaction went out. Closing the window while Adena still waits for the block is still reported as TRANSACTION_REJECTED, so the page always reads the chain before saying that nothing happened.

```
cp <this repo>/web/adena-check/popup-options.spec.ts packages/adena-extension/src/mandate-check/
REQUESTS=<this repo>/web/adena-check/app-requests.json corepack yarn jest --ci src/mandate-check/popup-options.spec.ts
```

Last run (v1.22.5): 7 of 7 passed (and `app-request.spec.ts` 7 of 7).
