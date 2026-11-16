import { describe, expect, it } from "vitest";
import { duration, pricePerM, tokens, usd } from "@/lib/shared/format";

describe("formatting", () => {
  it("shows money without scientific notation at any scale", () => {
    expect(usd(0)).toBe("$0");
    expect(usd(12.5)).toBe("$12.50");
    expect(usd(250)).toBe("$250");
    expect(usd(0.0153)).toBe("$0.0153");
    expect(usd(0.00096)).toBe("$0.00096");
    expect(usd(6.6e-7)).toBe("$0.00000066");
    expect(usd(1.24e-5)).toBe("$0.000012");
    expect(usd(null)).toBe("—");
  });

  it("shows per-token prices per million tokens", () => {
    expect(pricePerM(0.000001)).toBe("$1.00");
    expect(pricePerM(0.0000001)).toBe("$0.100");
    expect(pricePerM(2.9e-8)).toBe("$0.029");
    expect(pricePerM(1e-9)).toBe("$0.0010");
    expect(pricePerM(0)).toBe("free");
    expect(pricePerM(-1)).toBe("varies");
    expect(pricePerM(null)).toBe("—");
  });

  it("abbreviates tokens and durations", () => {
    expect(tokens(950)).toBe("950");
    expect(tokens(1726)).toBe("1.7K");
    expect(tokens(131072)).toBe("131K");
    expect(tokens(1_050_000)).toBe("1.05M");
    expect(duration(471)).toBe("471ms");
    expect(duration(1420)).toBe("1.42s");
    expect(duration(75_000)).toBe("1m 15s");
  });
});
