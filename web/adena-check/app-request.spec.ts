/**
 * @jest-environment node
 */
/**
 * Runs every request the Mandate web app sends (web/adena-check/
 * app-requests.json, generated and checked by web/app/src/lib/tx.test.ts)
 * through Adena v1.22.5's own code: the injected-API validators, the popup
 * parameter transport, TransactionService.createDocument, the static
 * session-admin fee path and adena-module's documentToTx. Not part of Adena;
 * lives in a scratch copy of it.
 *
 *   REQUESTS=<path to app-requests.json> yarn jest --ci src/mandate-check
 */
import { readFileSync } from 'fs';

import { Tx } from '@gnolang/tm2-js-client';
import { MsgCall } from '@gnolang/gno-js-client';
import { documentToTx, MsgCreateSession } from 'adena-module';
import type { Account } from 'adena-module';

import { decodeParameter, encodeParameter } from '@common/utils/client-utils';
import {
  validateDoContractRequest,
  validateTransactionMessageOfCreateSession,
  validateTransactionMessageOfRevokeSession,
  validateTransactionMessageOfVmCall,
} from '@common/validation/validation-message';
import { validateInjectionTransactionType } from '@common/validation/validation-transaction';
import {
  isStaticSessionAdminFeeDocument,
  makeStaticSessionAdminFeeSettings,
} from '@hooks/wallet/transaction-gas/session-admin-static-fee';
import { TransactionService } from '@services/transaction/transaction';
import type { GnoProvider } from '@common/provider/gno/gno-provider';
import type { WalletService } from '@services/index';

const R = JSON.parse(readFileSync(process.env.REQUESTS as string, 'utf8'));
const SUPPORTER = 'g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5';
const service = new TransactionService({} as WalletService, {
  getAccountInfo: jest.fn(async () => ({ accountNumber: '7', sequence: '0' })),
} as unknown as GnoProvider);
const accountOf = (address: string) => ({ id: 'a', type: 'PRIVATE_KEY', getAddress: jest.fn(async () => address) }) as unknown as Account;

/** What Adena does with a DoContract request up to the document it signs or simulates. */
async function throughAdena(params: any, signer: string = SUPPORTER) {
  expect(validateDoContractRequest(params)).toBe(true);
  for (const m of params.messages) {
    const ok =
      m.type === '/auth.m_create_session' ? validateTransactionMessageOfCreateSession(m)
        : m.type === '/auth.m_revoke_session' ? validateTransactionMessageOfRevokeSession(m)
          : validateTransactionMessageOfVmCall(m);
    expect(ok).toBe(true);
  }
  const injection = { type: 'DO_CONTRACT', status: 'request', key: 'k', data: { ...params, isVisibleResult: true } };
  const requestData = decodeParameter(encodeParameter(injection));
  expect(validateInjectionTransactionType(requestData)).toBeTruthy();
  // the popup broadcasts with broadcast_tx_commit only when this is exactly true
  // (pages/popup/wallet/approve-transaction-main/index.tsx: requestData?.data?.commit === true)
  expect(requestData.data.commit).toBe(true);
  const doc = await service.createDocument(
    accountOf(signer), 'onyx-1', requestData.data.messages, 'g',
    requestData.data.gasWanted, requestData.data.gasFee, requestData.data.memo,
  );
  const tx = Tx.decode(Tx.encode(documentToTx(doc)).finish());
  return { doc, tx };
}

describe('the Mandate web app requests, through Adena v1.22.5 code', () => {
  for (const name of ['subscribeStep1', 'stopStep1']) {
    it(`${name}: session-only, so Adena signs exactly the page's gas and fee`, async () => {
      const p = R[name];
      const { doc } = await throughAdena(p);
      expect(isStaticSessionAdminFeeDocument(doc)).toBe(true);
      const tiers = makeStaticSessionAdminFeeSettings(doc)!;
      for (const t of tiers) expect(t.gasInfo).toEqual({ ...tiers[0].gasInfo });
      expect(Number(tiers[0].gasInfo.gasWanted)).toBe(p.gasWanted);
      expect(Number(tiers[0].gasInfo.gasFee)).toBe(p.gasFee);
    });
  }

  for (const name of ['subscribeStep2', 'stopStep2', 'subscribeOneApproval', 'stopOneApproval', 'publishPlan', 'publishCollectorKey']) {
    it(`${name}: has a realm call, so Adena simulates it; the page's gas only seeds the document`, async () => {
      const p = R[name];
      const { doc, tx } = await throughAdena(p);
      expect(isStaticSessionAdminFeeDocument(doc)).toBe(false);
      expect(String(doc.fee.gas)).toBe(String(p.gasWanted)); // the simulation starts from sane values, not 2,000,000,000
      expect(tx.messages.length).toBe(p.messages.length);
    });
  }

  it('a creator\'s requests survive encoding intact: Offer(title, amount, period) and SetCollectorKey(gpub)', async () => {
    const CREATOR = 'g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj';
    const { tx: o } = await throughAdena(R.publishPlan, CREATOR);
    const offer = MsgCall.decode(o.messages[0].value);
    expect(offer.caller).toBe(CREATOR);
    expect(offer.func).toBe('Offer');
    expect(offer.pkg_path).toBe('gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate');
    expect(offer.args).toEqual(["Support Fluxen's work", '1000000', '2592000']);
    expect(offer.send).toBe('');
    const { tx: k } = await throughAdena(R.publishCollectorKey, CREATOR);
    const key = MsgCall.decode(k.messages[0].value);
    expect(key.func).toBe('SetCollectorKey');
    expect(key.args).toEqual(['gpub1pgfj7ard9eg82cjtv4u4xetrwqer2dntxyfzxz3pqfp0696ldln2nm7kd33zfpgypg6u0e7upl03hyeexa6mccn4ce8mkswg65c']);
  });

  it('the messages survive encoding intact', async () => {
    const { tx } = await throughAdena(R.subscribeOneApproval);
    const s = MsgCreateSession.decode(tx.messages[0].value);
    expect(s.creator).toBe(SUPPORTER);
    expect(s.spend_limit).toBe('1100000ugnot');
    expect(s.spend_period.toString()).toBe('2592000');
    expect(s.allow_paths).toEqual(['vm/exec:gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate']);
    const c = MsgCall.decode(tx.messages[1].value);
    expect(c.func).toBe('Subscribe');
    expect(c.pkg_path).toBe('gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate');
    expect(c.args).toEqual(['1', 'g1psdsf789f4xw3qrpjue54g2h28syd09yfkrxdh', '1826000000']);
    const { tx: t2 } = await throughAdena(R.stopStep2);
    const cancel = MsgCall.decode(t2.messages[0].value);
    expect(cancel.func).toBe('Cancel');
    expect(cancel.args).toEqual([SUPPORTER, 'g1psdsf789f4xw3qrpjue54g2h28syd09yfkrxdh']);
  });
});
