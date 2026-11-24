import { describe, expect, it } from "vitest";
import { titleFor } from "./App";

const A = "g1lkf7akafx3xdq6ds4c8rknj5ha95wufhrgrd0k";
const B = "g1x8lsaulnsenyr9h85s6z785hh6c58wrxwf3fv9";
const q = (s: string) => new URLSearchParams(s);

describe("the tab title says what the page shows", () => {
  it("plan numbers: the page's own check", () => {
    expect(titleFor("/plan/1")).toBe("Plan #1 · Mandate");
    expect(titleFor("/plan/007")).toBe("Plan #7 · Mandate");
    for (const bad of ["0", "00", "abc", "-1", "1.5", "12345678901234567890"]) expect(titleFor(`/plan/${bad}`)).toBe("No such plan · Mandate");
  });
  it("creator addresses: a malformed one is said to be one, not a missing page", () => {
    expect(titleFor(`/creator/${B}`)).toBe("Creator g1x8lsau…3fv9 · Mandate");
    expect(titleFor("/creator/g1bad")).toBe("Creator: not an address · Mandate");
    expect(titleFor(`/creator/${B.replace("x8", "b8")}`)).toBe("Creator: not an address · Mandate"); // "b" is not in an address
    expect(titleFor("/creator")).toBe("Creator · Mandate");
  });
  it("mandates: 'My' only for the connected wallet's own address", () => {
    expect(titleFor("/mine", q(""), null)).toBe("My mandates · Mandate");
    expect(titleFor("/mine", q(""), A)).toBe("My mandates · Mandate");
    expect(titleFor("/mine", q(`a=${A}`), A)).toBe("My mandates · Mandate");
    expect(titleFor("/mine", q(`a=${A}`), null)).toBe("Mandates of g1lkf7ak…rd0k · Mandate");
    expect(titleFor("/mine", q(`a=${A}`), B)).toBe("Mandates of g1lkf7ak…rd0k · Mandate");
    expect(titleFor("/mine", q("a=g1notanaddress"), B)).toBe("Mandates: not an address · Mandate");
  });
  it("everything else", () => {
    expect(titleFor("/plans", q("page=99"))).toBe("All plans · Mandate");
    expect(titleFor("/nope")).toBe("Page not found · Mandate");
  });
});
