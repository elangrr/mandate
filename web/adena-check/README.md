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
