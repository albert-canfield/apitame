/**
 * Regular expressions for `pattern` rules, matched in time linear in the length of the value.
 *
 * The pattern comes from the config, but the value comes from the agent. JavaScript's
 * backtracking engine can take exponential (`(a+)+$`) or polynomial (`\d+\d+$`) time on a
 * crafted value, and a rule that blocks the server for minutes is worse than no rule. So
 * patterns are parsed here, compiled to a small automaton and run as a Pike VM (as RE2 does):
 * every character of the value is read once, whatever the pattern.
 *
 * Supported: literals, `.`, `[...]` and `[^...]` with ranges, `\d \w \s \D \W \S`,
 * `\n \r \t \f \v \0 \xHH \uXXXX`, escaped punctuation, groups `(...)` and `(?:...)`,
 * alternation, `* + ?`, `{n}`, `{n,}`, `{n,m}` (a trailing `?` for lazy is accepted and changes
 * nothing, since only whether the whole value matches counts), and `^`/`$`. Backreferences,
 * lookaround, named groups, flags and `\b` are refused with a message.
 *
 * The whole value must match: the pattern behaves like `^(?:pattern)$`.
 */

export const MAX_PATTERN_LENGTH = 200;
/** Instructions in the compiled program. Counted repetition is expanded, so this bounds `(a{100}){100}`. */
const MAX_PROGRAM = 2_000;
const MAX_REPEAT = 1_000;

export class PatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatternError';
  }
}

type CharTest = (cp: number) => boolean;

type Node =
  | { type: 'char'; test: CharTest }
  | { type: 'seq'; items: Node[] }
  | { type: 'alt'; alts: Node[] }
  | { type: 'repeat'; node: Node; min: number; max: number }
  | { type: 'start' }
  | { type: 'end' };

type Inst =
  | { op: 'char'; test: CharTest }
  | { op: 'split'; x: number; y: number }
  | { op: 'jmp'; x: number }
  | { op: 'start' }
  | { op: 'end' }
  | { op: 'match' };

const cp = (s: string) => s.codePointAt(0)!;
const isDigit: CharTest = (c) => c >= 48 && c <= 57;
const isWord: CharTest = (c) =>
  isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
// The same set as JavaScript's \s.
const SPACES = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);
const isSpace: CharTest = (c) => SPACES.has(c) || (c >= 0x2000 && c <= 0x200a);
const isLineTerminator: CharTest = (c) => c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
const not =
  (t: CharTest): CharTest =>
  (c) =>
    !t(c);
const CLASS_ESCAPES: Record<string, CharTest> = {
  d: isDigit,
  D: not(isDigit),
  w: isWord,
  W: not(isWord),
  s: isSpace,
  S: not(isSpace),
};
const CONTROL_ESCAPES: Record<string, number> = { n: 0x0a, r: 0x0d, t: 0x09, f: 0x0c, v: 0x0b };
/** Characters that may be escaped with a backslash to stand for themselves. */
const ESCAPABLE = new Set('^$\\.*+?()[]{}|/-'.split(''));

class Parser {
  private pos = 0;
  private readonly chars: string[];

  constructor(source: string) {
    this.chars = Array.from(source);
  }

  parse(): Node {
    const node = this.alternation();
    if (this.pos < this.chars.length) {
      throw new PatternError(this.peek() === ')' ? 'unmatched ")"' : `unexpected "${this.peek()}"`);
    }
    return node;
  }

  private peek(offset = 0): string | undefined {
    return this.chars[this.pos + offset];
  }

  private next(): string {
    const c = this.chars[this.pos++];
    if (c === undefined) throw new PatternError('the pattern ends too early');
    return c;
  }

  private alternation(): Node {
    const alts = [this.sequence()];
    while (this.peek() === '|') {
      this.pos++;
      alts.push(this.sequence());
    }
    return alts.length === 1 ? alts[0]! : { type: 'alt', alts };
  }

  private sequence(): Node {
    const items: Node[] = [];
    while (this.pos < this.chars.length && this.peek() !== '|' && this.peek() !== ')') {
      const atom = this.atom();
      items.push(this.quantified(atom));
    }
    return items.length === 1 ? items[0]! : { type: 'seq', items };
  }

  private quantified(atom: Node): Node {
    const c = this.peek();
    let min: number;
    let max: number;
    if (c === '*') [min, max] = [0, Infinity];
    else if (c === '+') [min, max] = [1, Infinity];
    else if (c === '?') [min, max] = [0, 1];
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(this.chars.slice(this.pos, this.pos + 16).join(''));
      if (!m)
        throw new PatternError(
          '"{" must start a repetition such as {2,5}; write \\{ for the character',
        );
      min = Number(m[1]);
      max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
      if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT))
        throw new PatternError(`repetition counts go up to ${MAX_REPEAT}`);
      if (max < min) throw new PatternError(`{${min},${max}} has its numbers the wrong way round`);
      this.pos += m[0].length - 1;
    } else return atom;
    this.pos++;
    if (this.peek() === '?') this.pos++; // lazy: same result for a whole-value match
    if (atom.type === 'start' || atom.type === 'end')
      throw new PatternError('^ and $ cannot be repeated');
    if (['*', '+', '?', '{'].includes(this.peek() ?? ''))
      throw new PatternError('a quantifier cannot follow another one');
    return { type: 'repeat', node: atom, min, max };
  }

  private atom(): Node {
    const c = this.next();
    switch (c) {
      case '(':
        return this.group();
      case '[':
        return { type: 'char', test: this.charClass() };
      case '.':
        return { type: 'char', test: not(isLineTerminator) };
      case '^':
        return { type: 'start' };
      case '$':
        return { type: 'end' };
      case '\\':
        return { type: 'char', test: this.escape(false) };
      case '*':
      case '+':
      case '?':
        throw new PatternError(`"${c}" has nothing to repeat`);
      case '{':
        throw new PatternError('"{" has nothing to repeat; write \\{ for the character');
      case '}':
      case ']':
        throw new PatternError(`unmatched "${c}"; write \\${c} for the character`);
      default: {
        const code = cp(c);
        return { type: 'char', test: (x) => x === code };
      }
    }
  }

  private group(): Node {
    if (this.peek() === '?') {
      if (this.peek(1) !== ':') {
        const what =
          this.peek(1) === '=' || this.peek(1) === '!'
            ? 'lookahead'
            : this.peek(1) === '<' && (this.peek(2) === '=' || this.peek(2) === '!')
              ? 'lookbehind'
              : this.peek(1) === '<'
                ? 'named groups'
                : `"(?${this.peek(1) ?? ''}"`;
        throw new PatternError(`${what} is not supported`);
      }
      this.pos += 2;
    }
    const inner = this.alternation();
    if (this.peek() !== ')') throw new PatternError('missing ")"');
    this.pos++;
    // A group is an atom, so `(^)?` may be repeated even though a bare `^?` may not.
    return { type: 'seq', items: [inner] };
  }

  /** After a backslash. Returns a test for one character. */
  private escape(inClass: boolean): CharTest {
    const c = this.next();
    const cls = CLASS_ESCAPES[c];
    if (cls) return cls;
    const single = this.escapedCodePoint(c, inClass);
    return (x) => x === single;
  }

  private escapedCodePoint(c: string, inClass: boolean): number {
    if (c in CONTROL_ESCAPES) return CONTROL_ESCAPES[c]!;
    if (c === '0' && !isDigit(cp(this.peek() ?? 'x'))) return 0;
    if (c === 'x' || c === 'u') {
      const len = c === 'x' ? 2 : 4;
      const hex = this.chars.slice(this.pos, this.pos + len).join('');
      if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex))
        throw new PatternError(`\\${c} needs ${len} hexadecimal digits`);
      this.pos += len;
      return parseInt(hex, 16);
    }
    if (ESCAPABLE.has(c)) return cp(c);
    if (c === 'b' && inClass) return 0x08;
    if (/[1-9]/.test(c)) throw new PatternError('backreferences are not supported');
    if (c === 'b' || c === 'B')
      throw new PatternError('word boundaries (\\b, \\B) are not supported');
    throw new PatternError(`"\\${c}" is not supported`);
  }

  private charClass(): CharTest {
    let negate = false;
    if (this.peek() === '^') {
      negate = true;
      this.pos++;
    }
    const tests: CharTest[] = [];
    while (this.peek() !== ']') {
      if (this.peek() === undefined) throw new PatternError('missing "]"');
      const from = this.classAtom();
      if (this.peek() === '-' && this.peek(1) !== ']' && this.peek(1) !== undefined) {
        this.pos++;
        const to = this.classAtom();
        if (typeof from !== 'number' || typeof to !== 'number')
          throw new PatternError('a range like a-z needs single characters at both ends');
        if (to < from) throw new PatternError('a range has its ends the wrong way round');
        tests.push((x) => x >= from && x <= to);
      } else if (typeof from === 'number') tests.push((x) => x === from);
      else tests.push(from);
    }
    this.pos++;
    const any: CharTest = (x) => tests.some((t) => t(x));
    return negate ? not(any) : any;
  }

  /** One character (as a code point) or a class escape inside `[...]`. */
  private classAtom(): number | CharTest {
    const c = this.next();
    if (c !== '\\') {
      if (c === '[') throw new PatternError('write \\[ for "[" inside a character class');
      return cp(c);
    }
    const e = this.next();
    return CLASS_ESCAPES[e] ?? this.escapedCodePoint(e, true);
  }
}

class Compiler {
  readonly prog: Inst[] = [];

  private emit(inst: Inst): number {
    if (this.prog.length >= MAX_PROGRAM)
      throw new PatternError('the pattern is too complex (too many repetitions)');
    this.prog.push(inst);
    return this.prog.length - 1;
  }

  compile(node: Node): Inst[] {
    this.node(node);
    this.emit({ op: 'match' });
    return this.prog;
  }

  private node(n: Node): void {
    switch (n.type) {
      case 'char':
        this.emit({ op: 'char', test: n.test });
        return;
      case 'start':
      case 'end':
        this.emit({ op: n.type });
        return;
      case 'seq':
        for (const item of n.items) this.node(item);
        return;
      case 'alt': {
        const jumps: number[] = [];
        n.alts.forEach((alt, i) => {
          if (i < n.alts.length - 1) {
            const split = this.emit({ op: 'split', x: 0, y: 0 });
            (this.prog[split] as { x: number }).x = this.prog.length;
            this.node(alt);
            jumps.push(this.emit({ op: 'jmp', x: 0 }));
            (this.prog[split] as { y: number }).y = this.prog.length;
          } else this.node(alt);
        });
        for (const j of jumps) (this.prog[j] as { x: number }).x = this.prog.length;
        return;
      }
      case 'repeat': {
        for (let i = 0; i < n.min; i++) this.node(n.node);
        if (n.max === Infinity) {
          const split = this.emit({ op: 'split', x: 0, y: 0 });
          (this.prog[split] as { x: number }).x = this.prog.length;
          this.node(n.node);
          this.emit({ op: 'jmp', x: split });
          (this.prog[split] as { y: number }).y = this.prog.length;
          return;
        }
        const splits: number[] = [];
        for (let i = n.min; i < n.max; i++) {
          const split = this.emit({ op: 'split', x: 0, y: 0 });
          (this.prog[split] as { x: number }).x = this.prog.length;
          splits.push(split);
          this.node(n.node);
        }
        for (const s of splits) (this.prog[s] as { y: number }).y = this.prog.length;
        return;
      }
    }
  }
}

export interface SafePattern {
  readonly source: string;
  /** True when the whole value matches. Linear in the length of the value. */
  test(value: string): boolean;
}

/** Parse and compile a pattern. Throws {@link PatternError} with a readable message. */
export function compilePattern(source: string): SafePattern {
  if (source.length > MAX_PATTERN_LENGTH)
    throw new PatternError(`patterns are limited to ${MAX_PATTERN_LENGTH} characters`);
  const prog = new Compiler().compile(new Parser(source).parse());
  return { source, test: (value) => run(prog, value) };
}

/** Pike VM without captures: a set of program positions advanced one character at a time. */
function run(prog: Inst[], value: string): boolean {
  const chars = Array.from(value, cp);
  const seen = new Int32Array(prog.length).fill(-1);
  const stack: number[] = [];

  const add = (list: number[], start: number, pos: number) => {
    stack.push(start);
    while (stack.length > 0) {
      const pc = stack.pop()!;
      if (seen[pc] === pos) continue;
      seen[pc] = pos;
      const inst = prog[pc]!;
      switch (inst.op) {
        case 'jmp':
          stack.push(inst.x);
          break;
        case 'split':
          stack.push(inst.y, inst.x);
          break;
        case 'start':
          if (pos === 0) stack.push(pc + 1);
          break;
        case 'end':
          if (pos === chars.length) stack.push(pc + 1);
          break;
        default:
          list.push(pc);
      }
    }
  };

  let current: number[] = [];
  add(current, 0, 0);
  for (let i = 0; i < chars.length; i++) {
    if (current.length === 0) return false;
    const next: number[] = [];
    const c = chars[i]!;
    for (const pc of current) {
      const inst = prog[pc]!;
      if (inst.op === 'char' && inst.test(c)) add(next, pc + 1, i + 1);
    }
    current = next;
  }
  return current.some((pc) => prog[pc]!.op === 'match');
}
