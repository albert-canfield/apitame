export type Dialect = 'postgres' | 'sqlite' | 'mysql' | 'duckdb';

export type TokenType =
  | 'word'
  | 'quoted'
  | 'string'
  | 'number'
  | 'param'
  | 'named'
  | 'semicolon'
  | 'lparen'
  | 'rparen'
  | 'dot'
  | 'op';

export interface Token {
  type: TokenType;
  /** Raw text. For `named` tokens this is the parameter name without the colon. */
  value: string;
  start: number;
  end: number;
}

export class LexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LexError';
  }
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_CHAR = /[A-Za-z0-9_$\u0080-￿]/;

/**
 * A small SQL tokenizer that follows the real quoting rules of each
 * database (not a regex). It exists so the guard does not depend only on the
 * parser: if the parser and the database disagree about where a string or a
 * comment ends, this lexer sides with the database.
 *
 * - standard strings: '' escapes only (Postgres runs with standard_conforming_strings=on,
 *   which apitame enforces per transaction)
 * - Postgres E'' strings: backslash escapes
 * - Postgres dollar quoting: $tag$ ... $tag$
 * - Postgres block comments nest; SQLite block comments do not
 * - SQLite [identifiers] and `identifiers`
 * - MySQL: backslash escapes in '' and "" strings (both are strings), `identifiers`,
 *   # comments, "--" comments only when followed by whitespace, and /*! ... *\/
 *   executable comments refused outright because MySQL runs their content
 * - DuckDB: PostgreSQL's rules (nested comments, E'' strings, dollar quoting, a plain
 *   backslash in standard strings), without U&'' strings, with ? and $name parameters,
 *   and with `a:b` (list slices, prefix aliases) read as an operator, not a parameter
 */
export function tokenize(sql: string, dialect: Dialect): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  const duck = dialect === 'duckdb';
  // DuckDB's parser is derived from PostgreSQL's and reads quotes and comments the same way.
  const pg = dialect === 'postgres' || duck;
  const my = dialect === 'mysql';
  const lite = dialect === 'sqlite';

  const readQuoted = (quote: string, start: number, backslash: boolean): number => {
    let j = start + 1;
    for (;;) {
      if (j >= n)
        throw new LexError(
          `Unterminated ${quote === "'" ? 'string' : 'quoted identifier'} at position ${start}`,
        );
      const c = sql[j];
      if (backslash && c === '\\') {
        j += 2;
        continue;
      }
      if (c === quote) {
        if (sql[j + 1] === quote) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
  };

  while (i < n) {
    const c = sql[i] as string;
    const next = sql[i + 1];

    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // MySQL only treats "--" as a comment when whitespace (or the end) follows it.
    // PostgreSQL and DuckDB end it at a carriage return too ("SELECT 1 --\r; DELETE ..." is
    // two statements there); SQLite and MySQL only at a newline.
    if (c === '-' && next === '-' && (!my || i + 2 >= n || sql.charCodeAt(i + 2) <= 32)) {
      while (i < n && sql[i] !== '\n' && !(pg && sql[i] === '\r')) i++;
      continue;
    }
    if (my && c === '#') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      // MySQL runs the contents of /*! ... */ and reads optimizer hints from /*+ ... */.
      if (my && (sql[i + 2] === '!' || sql[i + 2] === '+')) {
        throw new LexError(
          'MySQL executable comments and optimizer hints (/*! ... */, /*+ ... */) are not allowed.',
        );
      }
      let depth = 1;
      let j = i + 2;
      while (depth > 0) {
        if (j >= n) throw new LexError(`Unterminated comment at position ${i}`);
        if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
        } else if (pg && sql[j] === '/' && sql[j + 1] === '*') {
          depth++;
          j += 2;
        } else j++;
      }
      i = j;
      continue;
    }
    if (c === "'") {
      const end = readQuoted("'", i, my);
      tokens.push({ type: 'string', value: sql.slice(i, end), start: i, end });
      i = end;
      continue;
    }
    if (pg && (c === 'E' || c === 'e') && next === "'") {
      const end = readQuoted("'", i + 1, true);
      tokens.push({ type: 'string', value: sql.slice(i, end), start: i, end });
      i = end;
      continue;
    }
    if (
      dialect === 'postgres' &&
      (c === 'U' || c === 'u') &&
      next === '&' &&
      (sql[i + 2] === "'" || sql[i + 2] === '"')
    ) {
      const q = sql[i + 2] as string;
      const end = readQuoted(q, i + 2, false);
      tokens.push({
        type: q === "'" ? 'string' : 'quoted',
        value: sql.slice(i, end),
        start: i,
        end,
      });
      i = end;
      continue;
    }
    if (my && c === '"') {
      // Without ANSI_QUOTES (the default), MySQL reads double quotes as a string.
      const end = readQuoted('"', i, true);
      tokens.push({ type: 'string', value: sql.slice(i, end), start: i, end });
      i = end;
      continue;
    }
    if (c === '"') {
      const end = readQuoted('"', i, false);
      tokens.push({
        type: 'quoted',
        value: sql.slice(i + 1, end - 1).replace(/""/g, '"'),
        start: i,
        end,
      });
      i = end;
      continue;
    }
    if (lite && c === '[') {
      const end = sql.indexOf(']', i + 1);
      if (end < 0) throw new LexError(`Unterminated [identifier] at position ${i}`);
      tokens.push({ type: 'quoted', value: sql.slice(i + 1, end), start: i, end: end + 1 });
      i = end + 1;
      continue;
    }
    if (!pg && c === '`') {
      // SQLite and MySQL identifiers.
      const end = readQuoted('`', i, false);
      tokens.push({
        type: 'quoted',
        value: sql.slice(i + 1, end - 1).replace(/``/g, '`'),
        start: i,
        end,
      });
      i = end;
      continue;
    }
    if (c === '$' && !my) {
      if (pg) {
        const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
        if (m) {
          const tag = m[0];
          const close = sql.indexOf(tag, i + tag.length);
          if (close < 0) throw new LexError(`Unterminated dollar-quoted string at position ${i}`);
          const end = close + tag.length;
          tokens.push({ type: 'string', value: sql.slice(i, end), start: i, end });
          i = end;
          continue;
        }
      }
      const m = /^\$(\d+|[A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
      if (m) {
        tokens.push({ type: 'param', value: m[0], start: i, end: i + m[0].length });
        i += m[0].length;
        continue;
      }
    }
    if (c === ':' && next === ':') {
      tokens.push({ type: 'op', value: '::', start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (my && c === '@') {
      // MySQL user and system variables (@x, @@version): not parameters.
      let j = i;
      while (sql[j] === '@') j++;
      tokens.push({ type: 'op', value: sql.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    // DuckDB reads `list[a:b]` and `SELECT alias: expr` with a colon right after a word.
    const sliceColon = duck && c === ':' && i > 0 && /[A-Za-z0-9_\]"]/.test(sql[i - 1] as string);
    if (
      (c === ':' || (lite && c === '@')) &&
      !sliceColon &&
      next !== undefined &&
      WORD_START.test(next)
    ) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(sql[j] as string)) j++;
      tokens.push({ type: 'named', value: sql.slice(i + 1, j), start: i, end: j });
      i = j;
      continue;
    }
    if ((lite || my || duck) && c === '?') {
      let j = i + 1;
      while (j < n && /\d/.test(sql[j] as string)) j++;
      tokens.push({ type: 'param', value: sql.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(sql[j] as string)) j++;
      tokens.push({ type: 'word', value: sql.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    if (/\d/.test(c) || (c === '.' && next !== undefined && /\d/.test(next))) {
      let j = i + 1;
      while (j < n && /[0-9.eE_xXa-fA-F]/.test(sql[j] as string)) {
        if ((sql[j] === 'e' || sql[j] === 'E') && (sql[j + 1] === '+' || sql[j + 1] === '-')) j++;
        j++;
      }
      tokens.push({ type: 'number', value: sql.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    const single: Record<string, TokenType> = {
      ';': 'semicolon',
      '(': 'lparen',
      ')': 'rparen',
      '.': 'dot',
    };
    tokens.push({ type: single[c] ?? 'op', value: c, start: i, end: i + 1 });
    i++;
  }
  return tokens;
}

/** Split tokens into statements on top-level semicolons. Empty statements are dropped. */
export function splitStatements(tokens: Token[]): Token[][] {
  const out: Token[][] = [];
  let current: Token[] = [];
  for (const t of tokens) {
    if (t.type === 'semicolon') {
      if (current.length > 0) out.push(current);
      current = [];
    } else current.push(t);
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** Function names called in a token stream (identifier followed by "("), lowercased, schema stripped. */
export function calledFunctions(tokens: Token[]): string[] {
  const names: string[] = [];
  for (let k = 0; k < tokens.length - 1; k++) {
    const t = tokens[k] as Token;
    if ((t.type === 'word' || t.type === 'quoted') && tokens[k + 1]?.type === 'lparen')
      names.push(t.value.toLowerCase());
  }
  return names;
}
