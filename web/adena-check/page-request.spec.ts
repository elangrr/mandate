/**
 * @jest-environment node
 */
/**
 * Runs the Mandate Adena test page's real request through Adena v1.22.5's
 * own code: the injected-API validators, the popup parameter transport,
 * TransactionService.createDocument, the static session-admin fee path and
 * adena-module's documentToTx. Not part of Adena; lives in a scratch copy.
 *
 *   PAGE=<path to web/adena-test.html> yarn jest --ci src/mandate-check
 */
import { readFileSync } from 'fs';
import { TextDecoder, TextEncoder } from 'util';
import vm from 'vm';

import { Tx } from '@gnolang/tm2-js-client';
import { documentToTx, MsgCreateSession } from 'adena-module';
import type { Account } from 'adena-module';

import { decodeParameter, encodeParameter } from '@common/utils/client-utils';
import {
  validateDoContractRequest,
  validateTransactionMessageOfCreateSession,
  validateTransactionMessageOfRevokeSession,
} from '@common/validation/validation-message';
import { validateInjectionTransactionType } from '@common/validation/validation-transaction';
import { DEFAULT_GAS_FEE, DEFAULT_GAS_WANTED } from '@common/constants/tx.constant';
import {
  isStaticSessionAdminFeeDocument,
  makeStaticSessionAdminFeeSettings,
} from '@hooks/wallet/transaction-gas/session-admin-static-fee';
import { TransactionService } from '@services/transaction/transaction';
import type { GnoProvider } from '@common/provider/gno/gno-provider';
import type { WalletService } from '@services/index';

const html = readFileSync(process.env.PAGE as string, 'utf8');
const block = html.slice(html.indexOf('/* BUILDERS START'), html.indexOf('/* BUILDERS END */'));
const ctx: any = vm.createContext({ TextEncoder, TextDecoder, BigInt, Uint8Array });
vm.runInContext(block + '\nthis.M = MandateAdena;', ctx);
const M = ctx.M;
const plain = (x: unknown): any => JSON.parse(JSON.stringify(x));

const CREATOR = 'g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5';
const GPUB = 'gpub1pgfj7ard9eg82cjtv4u4xetrwqer2dntxyfzxz3pqfp0696ldln2nm7kd33zfpgypg6u0e7upl03hyeexa6mccn4ce8mkswg65c';
const ONYX_PRICE = { gas: 1000, amount: 1 };

const service = new TransactionService({} as WalletService, {
  getAccountInfo: jest.fn(async () => ({ accountNumber: '1917', sequence: '0' })),
} as unknown as GnoProvider);
const account = { id: 'a', type: 'PRIVATE_KEY', getAddress: jest.fn(async () => CREATOR) } as unknown as Account;

// What the extension does with a page's DoContract request, in order:
// executor validation, transport to the popup (encodeParameter /
// decodeParameter), background type check, then createDocument with
// requestData.data.gasWanted / gasFee, then the static fee for session-only
// documents, which the popup writes back into the document it signs.
async function signedFee(params: any) {
  expect(validateDoContractRequest(params)).toBe(true);
  for (const m of params.messages) {
    const ok = m.type === '/auth.m_create_session'
      ? validateTransactionMessageOfCreateSession(m)
      : validateTransactionMessageOfRevokeSession(m);
    expect(ok).toBe(true);
  }
  const injection = { type: 'DO_CONTRACT', status: 'request', key: 'k', data: { ...params, isVisibleResult: true } };
  const requestData = decodeParameter(encodeParameter(injection));
  expect(validateInjectionTransactionType(requestData)).toBeTruthy();
  const doc = await service.createDocument(
    account, 'onyx-1', requestData.data.messages, 'g',
    requestData.data.gasWanted, requestData.data.gasFee, requestData.data.memo,
  );
  expect(isStaticSessionAdminFeeDocument(doc)).toBe(true); // no simulation for this request
  const tiers = makeStaticSessionAdminFeeSettings(doc)!;
  const avg = tiers.find(t => t.settingType === 'AVERAGE')!.gasInfo;
  // The popup's updateTransactionData sets fee = currentGasFeeRawAmount,
  // gas = currentGasInfo.gasWanted, both from this static gasInfo.
  const signed = { ...doc, fee: { amount: [{ amount: String(avg.gasFee), denom: 'ugnot' }], gas: String(avg.gasWanted) } };
  const tx = Tx.decode(Tx.encode(documentToTx(signed)).finish());
  // every tier is the same: the user cannot change the fee in the popup
  for (const t of tiers) expect(t.gasInfo).toEqual(avg);
  return { gasWanted: Number(tx.fee!.gas_wanted), gasFee: tx.fee!.gas_fee, doc, tx };
}

describe('Mandate Adena test page request, through Adena v1.22.5 code', () => {
  const create = () => plain(M.buildCreateSession({
    creator: CREATOR, pub: M.parsePubKey(GPUB), expiresAt: 1795445375,
    allowPaths: ['vm/exec:gno.land/r/test/unused'], spendLimit: '1000ugnot', spendPeriod: '60',
  }));

  it('reproduces the owner run: without gas, Adena signs its fallback and Onyx refuses it', async () => {
    const r = await signedFee({ messages: [create()], memo: 'x' }); // the old page's request
    expect(r.gasWanted).toBe(DEFAULT_GAS_WANTED);
    expect(r.gasFee).toBe(`${DEFAULT_GAS_FEE}ugnot`);
    expect(r.gasWanted).toBe(2000000000);
    expect(r.gasFee).toBe('100000ugnot');
    expect(DEFAULT_GAS_FEE).toBeLessThan(M.minimumFee(r.gasWanted, ONYX_PRICE)); // 100,000 < 2,000,000
  });

  it('signs exactly the gas and fee the page now sends (create)', async () => {
    const params = plain(M.doContractParams([create()], 'create', { gasWanted: '5000000', gasFee: '10000' }));
    const r = await signedFee(params);
    expect(r.gasWanted).toBe(5000000);
    expect(r.gasFee).toBe('10000ugnot');
    expect(10000).toBeGreaterThanOrEqual(M.minimumFee(5000000, ONYX_PRICE));
    // and the message is intact in the signed transaction
    const any = r.tx.messages[0];
    expect(any.type_url).toBe('/auth.m_create_session');
    const m = MsgCreateSession.decode(any.value);
    expect(m.creator).toBe(CREATOR);
    expect(m.allow_paths).toEqual(['vm/exec:gno.land/r/test/unused']);
    expect(m.spend_limit).toBe('1000ugnot');
    expect(m.expires_at.toString()).toBe('1795445375');
    expect(m.spend_period.toString()).toBe('60');
    expect(Buffer.from(m.session_key!.value).toString('hex').slice(0, 4)).toBe('0a21');
  });

  it('signs exactly the gas and fee the page now sends (revoke)', async () => {
    const params = plain(M.doContractParams(
      [plain(M.buildRevokeSession({ creator: CREATOR, pub: M.parsePubKey(GPUB) }))], 'revoke',
      { gasWanted: 5000000, gasFee: 10000 },
    ));
    const r = await signedFee(params);
    expect(r.gasWanted).toBe(5000000);
    expect(r.gasFee).toBe('10000ugnot');
  });

  it('strings work too, but a zero falls back to the default', async () => {
    const r = await signedFee({ messages: [create()], memo: '', gasWanted: '5000000', gasFee: '10000' });
    expect(r.gasWanted).toBe(5000000);
    expect(r.gasFee).toBe('10000ugnot');
    const z = await signedFee({ messages: [create()], memo: '', gasWanted: 0, gasFee: 0 });
    expect(z.gasWanted).toBe(DEFAULT_GAS_WANTED);
  });
});
