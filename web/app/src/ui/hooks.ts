import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/** Current hash route, e.g. "/plan/3" for "#/plan/3". */
function getRoute(): string {
  const h = window.location.hash.replace(/^#/, "");
  return h === "" ? "/" : h;
}

export function useRoute(): string {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("hashchange", cb);
      return () => window.removeEventListener("hashchange", cb);
    },
    getRoute,
    () => "/",
  );
}

export function go(route: string): void {
  window.location.hash = route;
}

export type Async<T> = { status: "loading" } | { status: "error"; error: Error } | { status: "ready"; value: T };

const sameDeps = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

/**
 * Runs load() when deps or refresh change; reload() runs it again (e.g. after a transaction).
 * New deps (another address, another page) show "loading" at once, never the value read for the old ones.
 * A reload or a change in `refresh` reads again in place: the value shown stays until the new one arrives.
 */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[], refresh: unknown[] = []): [Async<T>, () => void] {
  const [state, setState] = useState<{ deps: unknown[]; value: Async<T> }>({ deps, value: { status: "loading" } });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    setState((s) => (sameDeps(s.deps, deps) && s.value.status === "ready" ? s : { deps, value: { status: "loading" } }));
    load().then(
      (value) => my === seq.current && setState({ deps, value: { status: "ready", value } }),
      (error: Error) => my === seq.current && setState({ deps, value: { status: "error", error } }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, ...refresh, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  // in the render right after the deps change (before the effect runs), the old value is not shown either
  return [sameDeps(state.deps, deps) ? state.value : { status: "loading" }, reload];
}

export type Theme = "light" | "dark" | "system";

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const t = localStorage.getItem("mandate-theme");
      return t === "light" || t === "dark" ? t : "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      if (theme === "system") localStorage.removeItem("mandate-theme");
      else localStorage.setItem("mandate-theme", theme);
    } catch {
      /* private mode: the choice just isn't remembered */
    }
  }, [theme]);
  return [theme, setTheme];
}

/** The current hash route split into path and query. */
export function parseRoute(route: string): { path: string; query: URLSearchParams } {
  const i = route.indexOf("?");
  return i < 0 ? { path: route, query: new URLSearchParams() } : { path: route.slice(0, i), query: new URLSearchParams(route.slice(i + 1)) };
}
