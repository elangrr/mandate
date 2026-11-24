import { describe, expect, it } from "vitest";
import { ripemd160, sha256 } from "./hash";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const utf8 = (s: string) => new TextEncoder().encode(s);

describe("hashes", () => {
  it("RIPEMD-160 matches the paper's test vectors", () => {
    expect(hex(ripemd160(utf8("")))).toBe("9c1185a5c5e9fc54612808977ee8f548b2258d31");
    expect(hex(ripemd160(utf8("abc")))).toBe("8eb208f7e05d987a9b044a8e98c6b087f15a0bfc");
    expect(hex(ripemd160(utf8("message digest")))).toBe("5d0689ef49d2fae572b881b123a85ffa21595f36");
    expect(hex(ripemd160(utf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))).toBe("12a053384a9c0c88e405a06c27dcf49ada62eb2b");
    expect(hex(ripemd160(utf8("1234567890".repeat(8))))).toBe("9b752e45573d4b39f4dbd3323cab82bf63326bfb");
  });
  it("SHA-256 is the browser's", async () => {
    expect(hex(await sha256(utf8("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
