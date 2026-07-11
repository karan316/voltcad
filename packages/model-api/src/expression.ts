/**
 * Dimension expression parser + evaluator.
 *
 * Every dimensional input in VoltCAD is an expression string ("wall_t * 2 + 1mm"),
 * not a raw number — this is what lets the AI (and users) edit models by
 * changing named parameters. Implemented as a tiny recursive-descent parser;
 * NO eval()/Function() is ever used (untrusted documents must be safe to open).
 *
 * Unit model (deliberately simple and predictable):
 *   - Canonical length unit is millimeters; canonical angle unit is degrees.
 *   - A unit suffix is a pure multiplier: 2cm → 20, 1in → 25.4, 90deg → 90.
 *   - Features convert degrees → radians at the kernel boundary.
 */

export type Expression = string | number;

const UNIT_FACTORS: Record<string, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
  deg: 1,
  rad: 180 / Math.PI,
};

/** Pure functions available inside expressions. Trig operates in degrees. */
const FUNCTIONS: Record<string, (...xs: number[]) => number> = {
  sin: (x) => Math.sin((x * Math.PI) / 180),
  cos: (x) => Math.cos((x * Math.PI) / 180),
  tan: (x) => Math.tan((x * Math.PI) / 180),
  sqrt: Math.sqrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  min: Math.min,
  max: Math.max,
};

export class ExpressionError extends Error {
  constructor(
    message: string,
    readonly expression: string,
  ) {
    super(`${message} in "${expression}"`);
    this.name = "ExpressionError";
  }
}

type Token =
  | { t: "num"; v: number }
  | { t: "ident"; v: string }
  | { t: "op"; v: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    if (c >= "0" && c <= "9") {
      // number literal, optionally followed by a unit suffix (applied inline
      // so "2cm" tokenizes as a single number 20)
      let j = i;
      while (j < src.length && /[\d.]/.test(src[j]!)) j++;
      let value = Number(src.slice(i, j));
      if (Number.isNaN(value)) throw new ExpressionError(`Invalid number`, src);
      let k = j;
      while (k < src.length && /[a-z]/.test(src[k]!)) k++;
      const unit = src.slice(j, k);
      if (unit) {
        const factor = UNIT_FACTORS[unit];
        if (factor === undefined) throw new ExpressionError(`Unknown unit "${unit}"`, src);
        value *= factor;
        j = k;
      }
      tokens.push({ t: "num", v: value });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      tokens.push({ t: "ident", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/%^(),".includes(c)) {
      tokens.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new ExpressionError(`Unexpected character "${c}"`, src);
  }
  return tokens;
}

/**
 * Evaluate an expression against a parameter table.
 * Parameters may themselves be expressions; they are resolved recursively with
 * cycle detection ("a = b + 1, b = a" fails cleanly instead of looping).
 */
export function evaluateExpression(
  expr: Expression,
  parameters: Readonly<Record<string, Expression>> = {},
  _resolving: Set<string> = new Set(),
): number {
  if (typeof expr === "number") return expr;
  const src = expr.trim();
  if (src === "") throw new ExpressionError("Empty expression", src);
  const tokens = tokenize(src);
  let pos = 0;

  const peek = () => tokens[pos];
  const eatOp = (v: string): boolean => {
    const tk = tokens[pos];
    if (tk?.t === "op" && tk.v === v) {
      pos++;
      return true;
    }
    return false;
  };

  // precedence climbing: additive > multiplicative > unary > power > primary
  function parseExpr(): number {
    let left = parseTerm();
    for (;;) {
      if (eatOp("+")) left += parseTerm();
      else if (eatOp("-")) left -= parseTerm();
      else return left;
    }
  }
  function parseTerm(): number {
    let left = parseUnary();
    for (;;) {
      if (eatOp("*")) left *= parseUnary();
      else if (eatOp("/")) {
        const d = parseUnary();
        if (d === 0) throw new ExpressionError("Division by zero", src);
        left /= d;
      } else if (eatOp("%")) left %= parseUnary();
      else return left;
    }
  }
  function parseUnary(): number {
    if (eatOp("-")) return -parseUnary();
    if (eatOp("+")) return parseUnary();
    return parsePower();
  }
  function parsePower(): number {
    const base = parsePrimary();
    if (eatOp("^")) return base ** parseUnary(); // right-associative
    return base;
  }
  function parsePrimary(): number {
    const tk = peek();
    if (!tk) throw new ExpressionError("Unexpected end of expression", src);
    if (tk.t === "num") {
      pos++;
      return tk.v;
    }
    if (tk.t === "op" && tk.v === "(") {
      pos++;
      const v = parseExpr();
      if (!eatOp(")")) throw new ExpressionError("Missing )", src);
      return v;
    }
    if (tk.t === "ident") {
      pos++;
      if (eatOp("(")) {
        // function call
        const fn = FUNCTIONS[tk.v];
        if (!fn) throw new ExpressionError(`Unknown function "${tk.v}"`, src);
        const args: number[] = [];
        if (!eatOp(")")) {
          do args.push(parseExpr());
          while (eatOp(","));
          if (!eatOp(")")) throw new ExpressionError("Missing )", src);
        }
        return fn(...args);
      }
      // parameter reference with cycle detection
      const param = parameters[tk.v];
      if (param === undefined) throw new ExpressionError(`Unknown parameter "${tk.v}"`, src);
      if (_resolving.has(tk.v))
        throw new ExpressionError(`Circular parameter reference "${tk.v}"`, src);
      _resolving.add(tk.v);
      const value = evaluateExpression(param, parameters, _resolving);
      _resolving.delete(tk.v);
      return value;
    }
    throw new ExpressionError(`Unexpected token "${(tk as { v: unknown }).v}"`, src);
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new ExpressionError("Unexpected trailing input", src);
  if (!Number.isFinite(result)) throw new ExpressionError("Result is not finite", src);
  return result;
}
