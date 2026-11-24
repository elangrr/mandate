// The two Node APIs tx.test.ts uses (vitest runs it under Node). The app has
// no @types/node, on purpose: nothing in the browser bundle may use Node.
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
  export function writeFileSync(path: string | URL, data: string): void;
}
declare const process: { env: Record<string, string | undefined> };
