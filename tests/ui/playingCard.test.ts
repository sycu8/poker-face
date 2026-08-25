import { describe, expect, it } from "vitest";
import { cardAriaLabel } from "../../src/features/table/PlayingCard";

describe("cardAriaLabel", () => {
  it("names known ranks and suits", () => {
    expect(cardAriaLabel("Ah")).toBe("Ace of hearts");
    expect(cardAriaLabel("Td")).toBe("Ten of diamonds");
    expect(cardAriaLabel("Kc")).toBe("King of clubs");
    expect(cardAriaLabel("Qs")).toBe("Queen of spades");
    expect(cardAriaLabel("2h")).toBe("Two of hearts");
  });

  it("labels hidden and unknown codes", () => {
    expect(cardAriaLabel("?")).toBe("Hidden card");
    expect(cardAriaLabel("Xx")).toBe("Xx");
  });
});
