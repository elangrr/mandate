// Whether the realm is live, read once per load (and again on retry). Pages
// that read the realm wait for it; while the realm is parked they show the
// calm "waiting for approval" state instead of errors or empty tables.
import { createContext, useContext, type ReactNode } from "react";
import { read, type PackageStatus } from "../lib/rpc";
import { useAsync, type Async } from "./hooks";

type Live = Async<PackageStatus> & { reload: () => void };

const Ctx = createContext<Live | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const [s, reload] = useAsync(() => read.status(), []);
  return <Ctx.Provider value={{ ...s, reload }}>{children}</Ctx.Provider>;
}

export function useLive(): Live {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLive outside LiveProvider");
  return v;
}
