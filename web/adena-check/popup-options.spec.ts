/**
 * @jest-environment node
 */
/**
 * How the Mandate web app calls DoContract, through Adena v1.22.5's own
 * injected API (src/inject.ts): the second argument { isVisibleResult: false }
 * reaches the approval popup, so the popup sends the transaction's real reply
 * itself and closes (approve-transaction-main/index.tsx: the RESULT effect
 * calls onClickCloseResult when isVisibleResult is false), instead of waiting
 * on its result screen, where closing the window would reach the page as
 * TRANSACTION_REJECTED although the transaction went out. Not part of Adena;
 * lives in a scratch copy of it.
 *
 *   REQUESTS=<path to app-requests.json> yarn jest --ci src/mandate-check/popup-options.spec.ts
 */
import { readFileSync } from 'fs';

import { decodeParameter, encodeParameter } from '@common/utils/client-utils';

const R = JSON.parse(readFileSync(process.env.REQUESTS as string, 'utf8'));

/** The popup's own test (approve-transaction-main/index.tsx:270-272). */
const popupShowsResult = (requestData: any): boolean => requestData?.data?.isVisibleResult !== false;

describe('the web app\'s DoContract call, through Adena v1.22.5\'s injected API', () => {
  const posted: any[] = [];
  beforeAll(() => {
    // the page side of a browser, enough for inject.ts (jsdom's typed arrays trip a crypto import, so node plus a small window)
    (globalThis as any).window = {
      location: { origin: 'https://example.test', protocol: 'https:', hostname: 'example.test' },
      postMessage: (m: any) => posted.push(m),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../inject');
  });

  async function call(params: any, options?: any): Promise<any> {
    posted.length = 0;
    void (window as any).adena.DoContract(params, options); // the reply never comes here; only the request matters
    await new Promise((r) => setTimeout(r, 0));
    expect(posted).toHaveLength(1);
    // the content script relays the message to the background, which opens the popup with it
    return decodeParameter(encodeParameter(posted[0]));
  }

  for (const name of Object.keys(R)) {
    it(`${name}: { isVisibleResult: false } reaches the popup with commit: true, so it replies with the real result and closes`, async () => {
      const requestData = await call(R[name], { isVisibleResult: false });
      expect(requestData.type).toBe('DO_CONTRACT');
      expect(requestData.data.isVisibleResult).toBe(false);
      expect(requestData.data.commit).toBe(true);
      expect(requestData.data.messages).toEqual(R[name].messages);
      expect(popupShowsResult(requestData)).toBe(false);
    });
  }

  it('without the option (what the page sent before) the popup keeps its result screen open', async () => {
    const requestData = await call(R.subscribeStep1);
    expect(popupShowsResult(requestData)).toBe(true);
  });
});
