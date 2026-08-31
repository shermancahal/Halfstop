/*
 * A small evaluator for the subset of the GL expression language this app
 * writes, so a style expression can be asked what it answers for a feature.
 *
 * Every shield bug this project has had was a wrong answer for a particular
 * road, and none of them were visible in the expression's shape: a match with
 * the right arms in the right order still draws Virginia's marker in West
 * Virginia if the input it matches on is the viewport rather than the road.
 * Structural assertions - "the expression mentions st-WV" - pass on exactly
 * that bug, which is why they were not enough.
 *
 * The real evaluator lives in @mapbox/mapbox-gl-style-spec, which is a
 * dev-only dependency and so unavailable in the sandbox where these tests are
 * written and run. This covers the operators the style actually uses and
 * throws on anything else, so an expression that grows past it fails loudly
 * rather than being silently half-checked.
 */

const isExpr = (value) => Array.isArray(value) && typeof value[0] === 'string';

/**
 * @param expression a GL expression, or a literal value
 * @param feature `{ properties }` — what `['get', ...]` reads
 * @param scope bound `let` variables, used internally
 */
export function evaluate(expression, feature = {}, scope = {}) {
  if (!isExpr(expression)) return expression;
  const [op, ...args] = expression;
  const go = (value) => evaluate(value, feature, scope);
  const properties = feature.properties || feature || {};

  switch (op) {
    case 'literal':
      return args[0];
    case 'get': {
      const value = properties[go(args[0])];
      return value === undefined ? null : value;
    }
    case 'has':
      return properties[go(args[0])] !== undefined;
    case 'var':
      if (!(args[0] in scope)) throw new Error(`unbound var ${args[0]}`);
      return scope[args[0]];
    case 'let': {
      const bound = { ...scope };
      let i = 0;
      for (; i + 1 < args.length; i += 2) bound[args[i]] = evaluate(args[i + 1], feature, bound);
      return evaluate(args[i], feature, bound);
    }
    case 'coalesce': {
      for (const arg of args) {
        const value = go(arg);
        if (value !== null && value !== undefined) return value;
      }
      return null;
    }
    case 'case': {
      for (let i = 0; i + 1 < args.length; i += 2) if (go(args[i])) return go(args[i + 1]);
      return go(args[args.length - 1]);
    }
    case 'match': {
      const input = go(args[0]);
      for (let i = 1; i + 1 < args.length; i += 2) {
        const label = args[i];
        const values = Array.isArray(label) ? label : [label];
        if (values.some((one) => one === input)) return go(args[i + 1]);
      }
      return go(args[args.length - 1]);
    }
    case 'slice': {
      const input = go(args[0]);
      const from = go(args[1]);
      const to = args.length > 2 ? go(args[2]) : undefined;
      return String(input).slice(from, to);
    }
    case 'concat':
      return args.map((arg) => String(go(arg))).join('');
    case 'to-string':
      return String(go(args[0]));
    case 'to-number':
      return Number(go(args[0]));
    case 'length': {
      const input = go(args[0]);
      return Array.isArray(input) ? input.length : String(input).length;
    }
    case 'max':
      return Math.max(...args.map((arg) => Number(go(arg))));
    case 'min':
      return Math.min(...args.map((arg) => Number(go(arg))));
    case '==':
      return go(args[0]) === go(args[1]);
    case '!=':
      return go(args[0]) !== go(args[1]);
    case '>':
      return go(args[0]) > go(args[1]);
    case '>=':
      return go(args[0]) >= go(args[1]);
    case '<':
      return go(args[0]) < go(args[1]);
    case '<=':
      return go(args[0]) <= go(args[1]);
    case 'all':
      return args.every((arg) => Boolean(go(arg)));
    case 'any':
      return args.some((arg) => Boolean(go(arg)));
    case '!':
      return !go(args[0]);
    default:
      // Loudly, because a silent `undefined` here would make every assertion
      // written against it pass for the wrong reason.
      throw new Error(`expression helper does not implement "${op}"`);
  }
}
