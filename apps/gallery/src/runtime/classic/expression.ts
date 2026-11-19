import type { ClassicValue } from '#runtime/classic/parameter-types.js';

/** Only the literal/arithmetic Customizer fast path; other expressions go to the actual engine. */
export const parseCustomizerValue = (
  source: string,
  environment: Readonly<Record<string, ClassicValue>>,
): ClassicValue | undefined => {
  let index = 0;
  const whitespace = (): void => {
    while (/\s/u.test(source[index] ?? '')) {
      index += 1;
    }
  };
  const string = (): string | undefined => {
    const start = index;
    index += 1;
    while (index < source.length) {
      const character = source[index];
      index += 1;
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        try {
          const value: unknown = JSON.parse(source.slice(start, index));
          return typeof value === 'string' ? value : undefined;
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  };
  const atom = (): ClassicValue | undefined => {
    const token = /^(?:[$_a-z][\w$]*|(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?)/iu.exec(source.slice(index))?.[0];
    if (!token) {
      return undefined;
    }
    index += token.length;
    if (token === 'true' || token === 'false') {
      return token === 'true';
    }
    const numeric = Number(token);
    return Number.isFinite(numeric) ? numeric : environment[token];
  };
  const array = (): number[] | undefined => {
    index += 1;
    const values: number[] = [];
    while (index < source.length) {
      whitespace();
      if (source[index] === ']') {
        index += 1;
        return values;
      }
      const value = expression();
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return undefined;
      }
      values.push(value);
      whitespace();
      if (source[index] === ',') {
        index += 1;
      } else if (source[index] !== ']') {
        return undefined;
      }
    }
    return undefined;
  };
  const factor = (): ClassicValue | undefined => {
    whitespace();
    const character = source[index];
    if (character === '+' || character === '-') {
      index += 1;
      const value = factor();
      return typeof value === 'number' ? (character === '-' ? -value : value) : undefined;
    }
    if (character === '(') {
      index += 1;
      const value = expression();
      whitespace();
      if (source[index] !== ')') {
        return undefined;
      }
      index += 1;
      return value;
    }
    if (character === '[') {
      return array();
    }
    return character === '"' ? string() : atom();
  };
  const term = (): ClassicValue | undefined => {
    let left = factor();
    for (;;) {
      whitespace();
      const operator = source[index];
      if (operator !== '*' && operator !== '/') {
        return left;
      }
      index += 1;
      const right = factor();
      if (typeof left !== 'number' || typeof right !== 'number') {
        return undefined;
      }
      left = operator === '*' ? left * right : left / right;
      if (!Number.isFinite(left)) {
        return undefined;
      }
    }
  };
  const expression = (): ClassicValue | undefined => {
    let left = term();
    for (;;) {
      whitespace();
      const operator = source[index];
      if (operator !== '+' && operator !== '-') {
        return left;
      }
      index += 1;
      const right = term();
      if (typeof left !== 'number' || typeof right !== 'number') {
        return undefined;
      }
      left = operator === '+' ? left + right : left - right;
    }
  };
  const value = expression();
  whitespace();
  return index === source.length ? value : undefined;
};
