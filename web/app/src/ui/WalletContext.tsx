import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { config } from "../config";
import { account, connect, getAdena, switchNetwork, WalletError, type Account, type Adena } from "../lib/wallet";

interface WalletState {
  installed: boolean;
  address: string | null;
  chainId: string | null;
  onRightNetwork: boolean;
  busy: boolean;
  error: string | null;
  connect(): Promise<void>;
  switchNetwork(): Promise<void>;
  disconnect(): void;
}

const Ctx = createContext<WalletState | null>(null);

// Adena's On() has no way to remove a listener: register once per wallet object, for the life of the page,
// and pass the events to whichever provider is mounted now (none: they are dropped).
const hooked = new WeakSet<object>();
let onWalletChange: (() => void) | null = null;

function hookOnce(a: Adena) {
  if (!a.On || hooked.has(a)) return;
  hooked.add(a);
  const relay = () => onWalletChange?.();
  a.On("changedAccount", relay);
  a.On("changedNetwork", relay);
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [installed, setInstalled] = useState(() => getAdena() !== null);
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Adena injects itself after page load; look again briefly.
  useEffect(() => {
    if (installed) return;
    const t = setInterval(() => getAdena() && setInstalled(true), 500);
    const stop = setTimeout(() => clearInterval(t), 5000);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
  }, [installed]);

  // Only the newest request to Adena may set the account: an older GetAccount() reply that arrives late is dropped,
  // and so is any reply that arrives after the person disconnected.
  const seq = useRef(0);
  const connected = useRef(false);
  const ask = useCallback(async (f: () => Promise<Account>, dropOnError = false): Promise<void> => {
    const my = ++seq.current;
    let acc: Account;
    try {
      acc = await f();
    } catch (e) {
      if (dropOnError && my === seq.current) {
        connected.current = false;
        setAddress(null);
        setChainId(null);
      }
      throw e;
    }
    if (my !== seq.current) return;
    connected.current = true;
    setAddress(acc.address);
    setChainId(acc.chainId);
  }, []);
  const refresh = useCallback(() => ask(account), [ask]);

  useEffect(() => {
    const a = getAdena();
    if (!a) return;
    hookOnce(a);
    // an account or network change matters only while this site is connected: never connect it again behind the person's back
    onWalletChange = () => {
      if (connected.current) void ask(account, true).catch(() => undefined); // locked or disconnected in Adena: shown as not connected
    };
    return () => {
      onWalletChange = null;
    };
  }, [installed, ask]);

  const run = useCallback(async (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(e instanceof WalletError ? e.message : "Something went wrong with the wallet.");
    } finally {
      setBusy(false);
    }
  }, []);

  const value = useMemo<WalletState>(
    () => ({
      installed,
      address,
      chainId,
      onRightNetwork: chainId === config.chainId,
      busy,
      error,
      connect: () => run(() => ask(connect)),
      switchNetwork: () =>
        run(async () => {
          await switchNetwork();
          await refresh();
        }),
      disconnect: () => {
        seq.current++; // a reply on its way no longer counts
        connected.current = false;
        setAddress(null);
        setChainId(null);
        setError(null);
      },
    }),
    [installed, address, chainId, busy, error, run, refresh, ask],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}
