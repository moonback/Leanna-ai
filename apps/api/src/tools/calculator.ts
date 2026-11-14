/**
 * Safe arithmetic evaluator for the `math.calculate` tool: numbers, + - * / % ^,
 * parentheses and unary minus. A recursive-descent parser, never `eval`.
 */
export class CalcError extends Error {}

export function calculate(expression: string): number {
  const src = expression.replace(/\s+/g, '').replace(/,/g, '.');
  if (!src || src.length > 200) throw new CalcError('Expression vide ou trop longue');
  let pos = 0;
  let depth = 0;

  const peek = () => src[pos];
  const eat = (c: string) => (src[pos] === c ? (pos++, true) : false);

  function number(): number {
    const m = /^\d+(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(src.slice(pos));
    if (!m) throw new CalcError(`Nombre attendu à la position ${pos + 1}`);
    pos += m[0].length;
    return Number(m[0]);
  }
  function primary(): number {
    if (eat('(')) {
      if (++depth > 50) throw new CalcError('Trop de parenthèses imbriquées');
      const v = sum();
      if (!eat(')')) throw new CalcError('Parenthèse fermante manquante');
      depth--;
      return v;
    }
    if (eat('-')) return -primary();
    if (eat('+')) return primary();
    return number();
  }
  function power(): number {
    const base = primary();
    return eat('^') ? base ** unary() : base; // right-associative
  }
  function unary(): number {
    if (eat('-')) return -unary();
    return power();
  }
  function product(): number {
    let v = unary();
    for (;;) {
      if (eat('*')) v *= unary();
      else if (eat('/')) {
        const d = unary();
        if (d === 0) throw new CalcError('Division par zéro');
        v /= d;
      } else if (eat('%')) {
        const d = unary();
        if (d === 0) throw new CalcError('Division par zéro');
        v %= d;
      } else return v;
    }
  }
  function sum(): number {
    let v = product();
    for (;;) {
      if (eat('+')) v += product();
      else if (eat('-')) v -= product();
      else return v;
    }
  }

  const result = sum();
  if (pos !== src.length) throw new CalcError(`Caractère inattendu « ${peek()} »`);
  if (!Number.isFinite(result)) throw new CalcError('Résultat non fini');
  return result;
}
