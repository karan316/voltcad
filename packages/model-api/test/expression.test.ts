import { describe, expect, it } from "vitest";
import { ExpressionError, evaluateExpression } from "../src/expression.ts";

describe("evaluateExpression", () => {
  it("evaluates plain numbers and arithmetic", () => {
    expect(evaluateExpression(5)).toBe(5);
    expect(evaluateExpression("1 + 2 * 3")).toBe(7);
    expect(evaluateExpression("(1 + 2) * 3")).toBe(9);
    expect(evaluateExpression("2 ^ 3 ^ 2")).toBe(512); // right-assoc
    expect(evaluateExpression("-4 + 10")).toBe(6);
    expect(evaluateExpression("10 % 3")).toBe(1);
  });

  it("applies unit multipliers to mm", () => {
    expect(evaluateExpression("2cm")).toBe(20);
    expect(evaluateExpression("1in")).toBeCloseTo(25.4);
    expect(evaluateExpression("1m + 1mm")).toBe(1001);
    expect(evaluateExpression("90deg")).toBe(90);
  });

  it("resolves parameters recursively with cycle detection", () => {
    const params = { wall_t: "2.5", double: "wall_t * 2" };
    expect(evaluateExpression("double + 1", params)).toBe(6);
    expect(() => evaluateExpression("a", { a: "b", b: "a" })).toThrow(ExpressionError);
  });

  it("supports functions (trig in degrees)", () => {
    expect(evaluateExpression("sin(90)")).toBeCloseTo(1);
    expect(evaluateExpression("max(1, 2, 3)")).toBe(3);
    expect(evaluateExpression("sqrt(2) ^ 2")).toBeCloseTo(2);
  });

  it("rejects malformed input safely (no eval)", () => {
    expect(() => evaluateExpression("")).toThrow(ExpressionError);
    expect(() => evaluateExpression("1 +")).toThrow(ExpressionError);
    expect(() => evaluateExpression("nope")).toThrow(ExpressionError);
    expect(() => evaluateExpression("1 / 0")).toThrow(ExpressionError);
    expect(() => evaluateExpression("2zz")).toThrow(ExpressionError);
    expect(() => evaluateExpression("process(1)")).toThrow(ExpressionError);
  });
});
