'use strict';

// Minimal Zekken lexer for LSP diagnostics/completions.
// Goal: be good enough to (1) mask strings/comments reliably, (2) surface lexical errors
// with line/column, and (3) provide tokens for context-aware completion.

const KEYWORDS = new Set([
  'let', 'const', 'func', 'if', 'else', 'for', 'while', 'try', 'catch', 'return',
  'use', 'include', 'export', 'from', 'in',
]);

const DATATYPES = new Set(['int', 'float', 'string', 'bool', 'arr', 'obj', 'fn']);

function isAlpha(ch) {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_';
}

function isAlnum(ch) {
  return isAlpha(ch) || (ch >= '0' && ch <= '9');
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function lex(text) {
  const tokens = [];
  const errors = [];

  let i = 0;
  let line = 0;
  let col = 0;

  function pushError(message, ln, cl, length = 1) {
    errors.push({ message, line: ln, column: cl, length: Math.max(1, length | 0) });
  }

  function at(offset = 0) {
    return i + offset < text.length ? text[i + offset] : '';
  }

  function advance(n = 1) {
    while (n-- > 0) {
      const ch = at(0);
      i++;
      if (ch === '\n') {
        line++;
        col = 0;
      } else {
        col++;
      }
    }
  }

  function addToken(kind, value, startLine, startCol, endLine, endCol) {
    tokens.push({ kind, value, startLine, startCol, endLine, endCol });
  }

  while (i < text.length) {
    const ch = at(0);

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      advance(1);
      continue;
    }

    const startLine = line;
    const startCol = col;
    const startIdx = i;

    // Comments
    if (ch === '/' && at(1) === '/') {
      let j = i;
      while (j < text.length && text[j] !== '\n') j++;
      const value = text.slice(i, j);
      // update positions by advancing
      while (i < j) advance(1);
      addToken('SingleLineComment', value, startLine, startCol, line, col);
      continue;
    }
    if (ch === '/' && at(1) === '*') {
      advance(2);
      let closed = false;
      // scan until */
      while (i < text.length) {
        if (at(0) === '*' && at(1) === '/') {
          advance(2);
          closed = true;
          break;
        }
        advance(1);
      }
      // Include the full comment as one token value is not needed; just mark span.
      if (!closed) {
        pushError('Unterminated multi-line comment.', startLine, startCol, 2);
      }
      addToken('MultiLineComment', '/*...*/', startLine, startCol, line, col);
      continue;
    }

    // Strings
    if (ch === '"' || ch === "'") {
      const quote = ch;
      advance(1);
      let escaped = false;
      while (i < text.length) {
        const c = at(0);
        if (!escaped && c === '\n') {
          pushError('Unterminated string literal.', startLine, startCol, 1);
          break;
        }
        if (!escaped && c === quote) {
          advance(1);
          break;
        }
        if (!escaped && c === '\\') {
          escaped = true;
          advance(1);
          continue;
        }
        escaped = false;
        advance(1);
      }
      addToken('String', '<string>', startLine, startCol, line, col);
      continue;
    }

    // Numbers
    if (isDigit(ch)) {
      let hasDot = false;
      advance(1);
      while (isDigit(at(0))) advance(1);
      if (at(0) === '.' && isDigit(at(1))) {
        hasDot = true;
        advance(1);
        while (isDigit(at(0))) advance(1);
      }
      addToken(hasDot ? 'Float' : 'Int', '<num>', startLine, startCol, line, col);
      continue;
    }

    // Identifiers / keywords / datatypes / booleans
    if (isAlpha(ch)) {
      advance(1);
      while (isAlnum(at(0))) advance(1);
      const value = text.slice(startIdx, i);
      if (value === 'true' || value === 'false') {
        addToken('Boolean', value, startLine, startCol, line, col);
      } else if (DATATYPES.has(value)) {
        addToken('DataType', value, startLine, startCol, line, col);
      } else if (KEYWORDS.has(value)) {
        addToken('Keyword', value, startLine, startCol, line, col);
      } else {
        addToken('Identifier', value, startLine, startCol, line, col);
      }
      continue;
    }

    // Multi-char operators
    const two = ch + at(1);
    const twoOps = new Set(['=>', '->', '+=', '-=', '*=', '/=', '%=', '==', '!=', '<=', '>=', '&&', '||']);
    if (twoOps.has(two)) {
      advance(2);
      addToken('Operator', two, startLine, startCol, line, col);
      continue;
    }

    // Single-char tokens
    const singleOps = new Set(['=', '<', '>', '+', '-', '*', '/', '%', '.', '@', '|', '&']);
    const singlePunc = new Set([',', ':', ';', '(', ')', '{', '}', '[', ']']);
    if (singleOps.has(ch)) {
      advance(1);
      addToken('Operator', ch, startLine, startCol, line, col);
      continue;
    }
    if (singlePunc.has(ch)) {
      advance(1);
      addToken('Punct', ch, startLine, startCol, line, col);
      continue;
    }

    // Unknown character
    pushError(`Unexpected character '${ch}'.`, startLine, startCol, 1);
    advance(1);
  }

  return { tokens, errors };
}

function maskSource(text) {
  // Replace characters inside strings and comments with spaces so regex diagnostics
  // don't accidentally match inside them.
  const lines = text.split(/\r?\n/);
  const masked = lines.map((l) => l.split(''));

  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let inBlock = false;

  for (let ln = 0; ln < lines.length; ln++) {
    const raw = lines[ln];
    for (let c = 0; c < raw.length; c++) {
      const ch = raw[c];
      const next = c + 1 < raw.length ? raw[c + 1] : '';

      if (inBlock) {
        masked[ln][c] = ' ';
        if (ch === '*' && next === '/') {
          masked[ln][c + 1] = ' ';
          inBlock = false;
          c++;
        }
        continue;
      }

      if (inSingle) {
        masked[ln][c] = ' ';
        if (!escaped && ch === "'") inSingle = false;
        escaped = !escaped && ch === '\\';
        continue;
      }

      if (inDouble) {
        masked[ln][c] = ' ';
        if (!escaped && ch === '"') inDouble = false;
        escaped = !escaped && ch === '\\';
        continue;
      }

      // Not in string/comment
      if (ch === '/' && next === '/') {
        // rest of line
        for (let k = c; k < raw.length; k++) masked[ln][k] = ' ';
        break;
      }
      if (ch === '/' && next === '*') {
        masked[ln][c] = ' ';
        masked[ln][c + 1] = ' ';
        inBlock = true;
        c++;
        continue;
      }
      if (ch === "'") {
        masked[ln][c] = ' ';
        inSingle = true;
        escaped = false;
        continue;
      }
      if (ch === '"') {
        masked[ln][c] = ' ';
        inDouble = true;
        escaped = false;
        continue;
      }
    }
  }

  return masked.map((arr) => arr.join(''));
}

function indexFromLineCol(text, line, col) {
  let ln = 0;
  let idx = 0;
  while (idx < text.length && ln < line) {
    if (text[idx] === '\n') ln++;
    idx++;
  }
  return idx + col;
}

module.exports = {
  lex,
  maskSource,
};
