import { describe, expect, it } from 'vitest';
import { compilePattern, MAX_PATTERN_LENGTH, PatternError } from '../../src/safety/pattern.js';

const matches = (pattern: string, value: string) => compilePattern(pattern).test(value);

describe('pattern rules: matching', () => {
  it.each([
    // [pattern, value, whole value matches]
    ['^(web|api)$', 'web', true],
    ['^(web|api)$', 'api', true],
    ['^(web|api)$', 'webapi', false],
    ['^(web|api)$', 'www', false],
    ['web|api', 'api', true],
    ['web|api', 'web-api', false],
    ['abc', 'xabcx', false],
    ['a.c', 'abc', true],
    ['a.c', 'a\nc', false],
    ['[a-z]+', 'hello', true],
    ['[a-z]+', 'Hello', false],
    ['[^0-9]+', 'abc', true],
    ['[^0-9]+', 'a1c', false],
    ['[-a]+', '-a-', true],
    ['[a-]+', 'a-', true],
    ['[]', '', false],
    ['[^]', 'x', true],
    ['\\d{3}-\\d{4}', '555-1234', true],
    ['\\d{3}-\\d{4}', '5555-1234', false],
    ['\\w+', 'snake_case9', true],
    ['\\w+', 'kebab-case', false],
    ['\\s*x\\s*', '  x\t', true],
    ['\\D\\W\\S', 'a-b', true],
    ['\\D', '5', false],
    ['[\\d.]+', '12.50', true],
    ['\\.', '.', true],
    ['\\.', 'a', false],
    ['a\\+b', 'a+b', true],
    ['\\$\\{x\\}', '${x}', true],
    ['\\x41\\u00e9', 'Aé', true],
    ['\\n', '\n', true],
    ['a?b', 'b', true],
    ['a?b', 'aab', false],
    ['a*', '', true],
    ['a+', '', false],
    ['a{2}', 'aa', true],
    ['a{2}', 'aaa', false],
    ['a{2,}', 'aaaaa', true],
    ['a{2,}', 'a', false],
    ['a{1,3}', 'aaa', true],
    ['a{1,3}', 'aaaa', false],
    ['a+?', 'aaa', true],
    ['(?:ab)+', 'ababab', true],
    ['(?:ab)+', 'ababa', false],
    ['(a|ab)(c|bcd)', 'abcd', true],
    ['^a|b$', 'a', true],
    ['^a|b$', 'ab', false],
    ['(^)?a($){1,2}', 'a', true],
    ['a^b', 'ab', false],
    ['a$b', 'ab', false],
    ['(a$|b)c', 'ac', false],
    ['(a$|b)c', 'bc', true],
    ['(a*)*', 'aaa', true],
    ['héllo.', 'héllo😀', true],
    ['[😀-😂]', '😁', true],
  ])('%s against %j: %s', (pattern, value, expected) => {
    expect(matches(pattern, value)).toBe(expected);
  });

  it('runs in linear time on patterns that make backtracking engines hang', () => {
    const long = 'a'.repeat(50_000);
    const started = Date.now();
    // Exponential with backtracking: (a+)+b. Polynomial: \d+\d+\d+x and .*.*.*=.
    expect(matches('(a+)+b', `${long}!`)).toBe(false);
    expect(matches('(a|aa)*c', long)).toBe(false);
    expect(matches('\\d+\\d+\\d+x', '1'.repeat(50_000))).toBe(false);
    expect(matches('.*.*.*=.*', long)).toBe(false);
    expect(matches('(a+)+', long)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('pattern rules: agree with JavaScript', () => {
  // A small seeded generator: random patterns from the supported syntax, random short values,
  // compared with RegExp(`^(?:pattern)$`, 'u').
  let seed = 2026;
  const rnd = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  const pick = <T>(items: T[]) => items[rnd(items.length)]!;
  const atoms = [
    ...['a', 'b', '.', '\\d', '\\w', '\\s', '\\D', '\\W', '\\S', '[ab]', '[^a]', '[a-c]'],
    ...['[\\d.]', '\\.', '-', '1', ' ', '[-a]', '\\x61', 'é', '😀', '[😀a]', '[\\s\\S]'],
    ...['\\u00e9', '\\n', '^', '$', '[\\b]', '[\\]]', '\\/', '()', '(?:)', '[^\\W]'],
  ];
  const quantifiers = ['', '', '', '*', '+', '?', '{2}', '{1,2}', '{0,}', '*?', '{0}', '??'];
  const gen = (depth: number): string => {
    let out = '';
    for (let i = 0, n = 1 + rnd(3); i < n; i++) {
      const group =
        depth > 0 && rnd(4) === 0
          ? `(${rnd(2) ? '?:' : ''}${gen(depth - 1)}${rnd(2) ? `|${gen(depth - 1)}` : ''})`
          : undefined;
      const atom = group ?? pick(atoms);
      // A bare ^ or $ cannot be repeated, in JavaScript either.
      out += atom + (atom === '^' || atom === '$' ? '' : pick(quantifiers));
    }
    return out;
  };
  const alphabet = ['a', 'b', '1', '.', ' ', '\n', '-', 'é', '😀', '\u2028', ']', '\b', '/'];

  it('on thousands of random patterns and values', () => {
    let compared = 0;
    for (let i = 0; i < 3_000; i++) {
      const pattern = gen(2);
      if (pattern.length > 200) continue;
      const ours = compilePattern(pattern);
      const js = new RegExp(`^(?:${pattern})$`, 'u');
      for (let j = 0; j < 8; j++) {
        const value = Array.from({ length: rnd(6) }, () => pick(alphabet)).join('');
        expect(ours.test(value), `${pattern} against ${JSON.stringify(value)}`).toBe(
          js.test(value),
        );
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(20_000);
  });
});

describe('pattern rules: refused patterns', () => {
  it.each([
    ['(a)\\1', /backreferences are not supported/],
    ['(?=a)a', /lookahead is not supported/],
    ['(?!a)b', /lookahead is not supported/],
    ['(?<=a)b', /lookbehind is not supported/],
    ['(?<name>a)', /named groups is not supported/],
    ['(?i)a', /"\(\?i" is not supported/],
    ['\\bword\\b', /word boundaries/],
    ['\\k<x>', /"\\k" is not supported/],
    ['\\p{L}', /"\\p" is not supported/],
    ['\\x4', /\\x needs 2 hexadecimal digits/],
    ['(ab', /missing "\)"/],
    ['ab)', /unmatched "\)"/],
    ['[ab', /missing "\]"/],
    ['ab]', /unmatched "\]"/],
    ['*a', /nothing to repeat/],
    ['a**', /cannot follow another/],
    ['a{3,1}', /wrong way round/],
    ['a{2000}', /up to 1000/],
    ['a{', /"\{" must start a repetition/],
    ['{', /nothing to repeat/],
    ['[z-a]', /wrong way round/],
    ['[\\d-z]', /single characters at both ends/],
    ['^*', /cannot be repeated/],
    ['a\\', /ends too early/],
    ['(a{100}){100}', /too complex/],
  ])('%s', (pattern, message) => {
    expect(() => compilePattern(pattern)).toThrow(PatternError);
    expect(() => compilePattern(pattern)).toThrow(message);
  });

  it(`refuses patterns longer than ${MAX_PATTERN_LENGTH} characters`, () => {
    expect(() => compilePattern('a'.repeat(MAX_PATTERN_LENGTH))).not.toThrow();
    expect(() => compilePattern('a'.repeat(MAX_PATTERN_LENGTH + 1))).toThrow(/limited to 200/);
  });
});
