const { DiagnosticSeverity } = require("vscode-languageserver/node");
const fs = require("fs");
const path = require("path");
const { lex, maskSource } = require("./lexer");

const FILE_EXPORT_CACHE = new Map();

function computeDiagnostics(text, completionData, options = {}) {
  const diagnostics = [];
  const lines = text.split(/\r?\n/);
  const maskedLines = buildMaskedLines(lines);
  const ctx = buildValidationContext(text, completionData, options, diagnostics);

  // Lexical diagnostics (unexpected characters, unterminated strings/comments, etc.).
  let lexed = null;
  try {
    lexed = lex(text);
    if (lexed && Array.isArray(lexed.errors)) {
      for (const e of lexed.errors) {
        addDiagnostic(diagnostics, DiagnosticSeverity.Error, e.line, e.column, e.column + (e.length || 1), e.message);
      }
    }
  } catch {}

  checkMalformedComments(lines, diagnostics);
  checkMissingTypeAnnotation(lines, diagnostics, ctx, completionData);
  checkUnknownTypeAnnotations(lines, diagnostics, completionData);
  checkMissingDeclarationValue(lines, diagnostics);
  checkUnterminatedStrings(lines, diagnostics);
  checkMissingParamTypeAnnotations(lines, diagnostics);
  checkDeclarationTypeMismatch(lines, diagnostics, ctx, completionData);
  checkIncompleteControlSyntax(lines, diagnostics);
  checkDuplicateDeclarations(lines, maskedLines, diagnostics);
  checkReturnOutsideFunction(lines, diagnostics);
  checkMissingSemicolonInLetLexed(lexed, diagnostics);
  // Fallback string-based semicolon check to catch edge cases like trailing `//` comments.
  // (Tokenization can sometimes miss statement boundaries depending on masking.)
  checkMissingSemicolonInLet(lines, diagnostics);
  checkMissingSemicolonOnReturn(lines, diagnostics);
  checkUnbalancedPairs(maskedLines, diagnostics);
  checkIncompleteCallSyntax(lines, diagnostics);
  checkExpressionContextErrors(maskedLines, diagnostics);
  checkIncompleteMemberAccess(maskedLines, diagnostics);
  checkFunctionCallArity(maskedLines, diagnostics, ctx);
  checkDisallowedStandaloneCallSemicolon(lines, diagnostics);
  checkPipeCallBalanceLexed(lexed, diagnostics);
  checkUnknownUseModules(lines, diagnostics, completionData);
  checkUnknownUseMembers(lines, diagnostics, completionData);
  checkBuiltinInvocationSyntax(maskedLines, diagnostics, completionData);
  checkUnknownAtBuiltins(maskedLines, diagnostics, completionData);
  checkUnknownModuleMemberAccess(maskedLines, diagnostics, completionData);
  checkInvalidCastTargets(lines, diagnostics, completionData);
  checkInvalidLiteralCasts(lines, diagnostics);
  checkConstReassignment(lines, diagnostics, ctx);
  checkUndefinedSymbolsLexed(lexed, diagnostics, completionData);

  return addFixHints(dedupeAndSortDiagnostics(diagnostics));
}

function checkMissingTypeAnnotation(lines, diagnostics, ctx, completionData) {
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw).trim();
    if (!line) continue;

    const missingType = /^(let|const)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=/.exec(line);
    if (missingType) {
      const ident = missingType[2];
      const start = Math.max(raw.indexOf(ident), 0);
      addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, start, start + ident.length,
        "Type annotation required. Inferred typing is not supported.");
      continue;
    }

    const emptyType = /^(let|const)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*=/.exec(line);
    if (emptyType) {
      const col = Math.max(raw.indexOf(":"), 0);
      let inferred = null;
      try {
        const noComment = stripComment(raw);
        const eq = noComment.indexOf("=");
        if (eq >= 0) {
          let rhs = noComment.slice(eq + 1).trim();
          if (rhs.endsWith(";")) rhs = rhs.slice(0, -1).trim();
          const t = inferExpressionType(rhs, ctx, completionData);
          if (t && t !== "unknown") inferred = t;
        }
      } catch {}
      addDiagnostic(
        diagnostics,
        DiagnosticSeverity.Error,
        i,
        col,
        col + 1,
        inferred ? `Missing type annotation after ':'. Inferred type: '${inferred}'.` : "Missing type annotation after ':'.",
      );
    }
  }
}

function checkUnknownTypeAnnotations(lines, diagnostics, completionData) {
  const knownTypes = new Set(completionData.types || []);
  for (let i = 0; i < lines.length; i++) {
    const raw = stripComment(lines[i]);

    const varDecl = /^\s*(?:let|const)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([a-zA-Z_][a-zA-Z0-9_]*)/.exec(raw);
    if (varDecl) {
      const t = varDecl[2];
      if (!knownTypes.has(t)) {
        const start = Math.max(raw.indexOf(t), 0);
        addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, start, start + t.length, `Unknown type '${t}'.`);
      }
    }

    const funcReturn = /^\s*func\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\|[^|]*\|\s*->\s*([a-zA-Z_][a-zA-Z0-9_]*)/.exec(raw);
    if (funcReturn) {
      const t = funcReturn[1];
      if (!knownTypes.has(t)) {
        const start = Math.max(raw.lastIndexOf(t), 0);
        addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, start, start + t.length, `Unknown function return type '${t}'.`);
      }
    }

    const fnParams = /^\s*func\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\|([^|]*)\|/.exec(raw);
    if (fnParams) {
      const params = fnParams[1].split(",").map((s) => s.trim()).filter(Boolean);
      for (const p of params) {
        const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*=\s*.+)?$/.exec(p);
        if (!m) continue;
        const t = m[2];
        if (!knownTypes.has(t)) {
          const start = Math.max(raw.indexOf(t), 0);
          addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, start, start + t.length, `Unknown parameter type '${t}'.`);
        }
      }
    }
  }
}

function checkMissingDeclarationValue(lines, diagnostics) {
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw);
    const m = /^\s*(let|const)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*;?\s*$/.exec(line);
    if (!m) continue;

    // Multiline initializer support, e.g.:
    //   let grid: arr =
    //   [ ...
    //   ];
    let j = i + 1;
    while (j < lines.length) {
      const nxt = stripComment(lines[j]).trim();
      if (nxt === "") { j++; continue; }
      if (nxt.startsWith("[") || nxt.startsWith("{") || nxt.startsWith("(")) {
        j = -1;
      }
      break;
    }
    if (j == -1) continue;

    const eq = raw.indexOf("=");
    const start = eq >= 0 ? eq + 1 : 0;
    addDiagnostic(
      diagnostics,
      DiagnosticSeverity.Error,
      i,
      start,
      Math.min(start + 1, raw.length),
      `Missing value in declaration for "${m[2]}".`,
    );
  }
}

function checkUnterminatedStrings(lines, diagnostics) {
  for (let i = 0; i < lines.length; i++) {
    const raw = stripComment(lines[i]);
    let inSingle = false;
    let inDouble = false;
    let escaped = false;
    for (let c = 0; c < raw.length; c++) {
      const ch = raw[c];
      if (inSingle) {
        if (!escaped && ch === "'") inSingle = false;
        escaped = !escaped && ch === "\\";
        continue;
      }
      if (inDouble) {
        if (!escaped && ch === "\"") inDouble = false;
        escaped = !escaped && ch === "\\";
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        escaped = false;
      } else if (ch === "\"") {
        inDouble = true;
        escaped = false;
      }
    }
    if (inSingle || inDouble) {
      const start = Math.max(raw.length - 1, 0);
      addDiagnostic(
        diagnostics,
        DiagnosticSeverity.Error,
        i,
        start,
        Math.max(start + 1, raw.length),
        "Unterminated string literal.",
      );
    }
  }
}

function checkIncompleteControlSyntax(lines, diagnostics) {
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw).trim();
    if (!line) continue;

    if (/^if\b/.test(line)) {
      if (/^if\s*\{?$/.test(line)) {
        addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, 0, Math.min(2, raw.length), "Incomplete if statement: missing condition.");
        continue;
      }
      if (!/\{\s*$/.test(line)) {
        addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, 0, Math.min(raw.length, 2), "Invalid if statement: expected '{' at end of condition.");
      }
      continue;
    }

    if (/^else\b/.test(line)) {
      if (/^else\s*if\b/.test(line)) {
        if (/^else\s*if\s*\{?$/.test(line)) {
          addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, 0, Math.min(raw.length, 7), "Incomplete else-if statement: missing condition.");
          continue;
        }
        if (!/\{\s*$/.test(line)) {
          addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, 0, Math.min(raw.length, 7), "Invalid else-if statement: expected '{' at end of condition.");
        }
      } else if (!/^else\s*\{\s*$/.test(line)) {
        addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, 0, Math.min(raw.length, 4), "Invalid else statement: expected 'else {'.");
      }
      continue;
    }

    if (/^while\b/.test(line)) {
      if (/^while\s*\{?$/.test(line)) {
        addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, 0, Math.min(raw.length, 5), "Incomplete while loop: missing condition.");
        continue;
      }
      if (!/\{\s*$/.test(line)) {
        addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, 0, Math.min(raw.length, 5), "Invalid while loop: expected '{' at end of condition.");
      }
      continue;
    }

    if (/^for\b/.test(line)) {
      const forHeader = /^for\s*\|[^|]+\|\s*in\s+.+\{\s*$/.test(line);
      if (!forHeader) {
        if (!/^for\s*\|/.test(line)) {
          addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, 0, Math.min(raw.length, 3), "Invalid for loop: expected iterator block.");
        } else if (!/\|\s*in\s+/.test(line)) {
          addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, 0, Math.min(raw.length, 3), "Invalid for loop: expected 'in <source>' after iterator block.");
        } else if (!/\{\s*$/.test(line)) {
          addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, 0, Math.min(raw.length, 3), "Invalid for loop: expected '{' at end of header.");
        }
      }
      continue;
    }

    if (/^func\b/.test(line)) {
      const fnHeader = /^func\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\|[^|]*\|\s*(->\s*[a-zA-Z_][a-zA-Z0-9_]*\s*)?\{\s*$/.test(line);
      if (!fnHeader) {
        if (!/^func\s+[a-zA-Z_][a-zA-Z0-9_]*/.test(line)) {
          addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, 0, Math.min(raw.length, 4), "Invalid function declaration: missing function name.");
        } else if (!/\|[^|]*\|/.test(line)) {
          addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, 0, Math.min(raw.length, 4), "Invalid function declaration: expected parameter block '|...|'.");
        } else if (!/\{\s*$/.test(line)) {
          addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, 0, Math.min(raw.length, 4), "Invalid function declaration: expected '{' to start function body.");
        }
      }
      continue;
    }

    if (/^try\b/.test(line)) {
      if (!/^try\s*\{\s*$/.test(line)) {
        addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, 0, Math.min(raw.length, 3), "Invalid try statement: expected 'try {'.");
      }
      continue;
    }

    if (/^catch\b/.test(line)) {
      if (!/^catch\s*\|\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\|\s*\{\s*$/.test(line)) {
        addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, 0, Math.min(raw.length, 5), "Invalid catch statement: expected 'catch |err| {'.");
      }
      continue;
    }
  }
}

function checkMissingParamTypeAnnotations(lines, diagnostics) {
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw);
    const paramBlocks = line.match(/\|[^|]*\|/g) || [];
    for (const block of paramBlocks) {
      const blockStart = line.indexOf(block);
      const prefix = line.slice(0, blockStart);
      const isDeclaration = /\bfunc\b|->/.test(prefix);
      if (!isDeclaration) continue;

      const inner = block.slice(1, -1).trim();
      if (!inner) continue;
      const params = inner.split(",").map((s) => s.trim()).filter(Boolean);
      for (const param of params) {
        if (param.includes(":")) continue;
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(param)) continue;
        const start = raw.indexOf(param, blockStart);
        addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, Math.max(start, 0), Math.max(start, 0) + param.length,
          `Parameter '${param}' is missing a type annotation.`);
      }
    }
  }
}

function checkDeclarationTypeMismatch(lines, diagnostics, ctx, completionData) {
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw);
    if (!line.trim()) continue;

    const decl = /^\s*(let|const)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+?)\s*;?\s*$/.exec(line);
    if (!decl) continue;

    const name = decl[2];
    const expected = decl[3];
    const rhs = decl[4];
    const actual = inferExpressionType(rhs, ctx, completionData);
    if (!actual || actual === "unknown" || actual === expected) continue;

    const rhsStart = raw.indexOf(rhs);
    const start = rhsStart >= 0 ? rhsStart : 0;
    const end = start + Math.max(rhs.length, 1);
    const cast = `.cast => |"${expected}"|`;
    addDiagnostic(
      diagnostics,
      DiagnosticSeverity.Error,
      i,
      start,
      end,
      `Type mismatch for '${name}': declared '${expected}', value looks like '${actual}'. Fix: change declared type to '${actual}' or cast value with '${cast}'.`,
    );
  }
}

function checkAssignmentTypeMismatch(lines, diagnostics, ctx, completionData) {
  for (let i = 0; i < lines.length; i++) {
    const raw = stripComment(lines[i]);
    const m = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+?)\s*;?\s*$/.exec(raw);
    if (!m) continue;
    const name = m[1];
    const rhs = m[2];
    if (!ctx.declaredTypes.has(name)) continue;
    const expected = ctx.declaredTypes.get(name);
    const actual = inferExpressionType(rhs, ctx, completionData);
    if (!actual || actual === "unknown" || actual === expected) continue;
    const start = Math.max(raw.indexOf(rhs), 0);
    addDiagnostic(
      diagnostics,
      DiagnosticSeverity.Error,
      i,
      start,
      start + rhs.length,
      `Type mismatch in assignment to '${name}': expected '${expected}', got '${actual}'.`,
    );
  }
}

function checkDuplicateDeclarations(lines, maskedLines, diagnostics) {
  const scopeStack = [new Map()];

  function currentScope() {
    return scopeStack[scopeStack.length - 1];
  }
  function pushScope() {
    scopeStack.push(new Map());
  }
  function popScope() {
    if (scopeStack.length > 1) scopeStack.pop();
  }

  for (let i = 0; i < lines.length; i++) {
    const masked = maskedLines[i] || "";
    if (!masked.trim()) continue;

    // Apply leading '}' first so declarations on this line are checked in the correct scope.
    const leadingCloseMatch = masked.match(/^\s*}+/);
    if (leadingCloseMatch) {
      const closes = (leadingCloseMatch[0].match(/}/g) || []).length;
      for (let k = 0; k < closes; k++) popScope();
    }

    const decl = /^\s*(let|const|func)\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/.exec(masked);
    if (decl) {
      const name = decl[2];
      const scope = currentScope();
      if (scope.has(name)) {
        const start = Math.max((lines[i] || "").indexOf(name), 0);
        addDiagnostic(
          diagnostics,
          DiagnosticSeverity.Warning,
          i,
          start,
          start + name.length,
          `Duplicate declaration for '${name}' (first declared on line ${scope.get(name) + 1}).`,
        );
      } else {
        scope.set(name, i);
      }
    }

    // Apply the remaining braces in source order.
    const startIdx = leadingCloseMatch ? leadingCloseMatch[0].length : 0;
    for (let c = startIdx; c < masked.length; c++) {
      const ch = masked[c];
      if (ch === "{") pushScope();
      if (ch === "}") popScope();
    }
  }
}

function checkReturnOutsideFunction(lines, diagnostics) {
  let braceDepth = 0;
  const functionBraceStack = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = stripStringsAndComments(stripComment(lines[i]));
    const hasReturn = /\breturn\b/.test(raw);
    if (hasReturn && functionBraceStack.length === 0) {
      const start = Math.max(raw.indexOf("return"), 0);
      addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, start, start + 6, "Return statement is only valid inside a function/lambda body.");
    }

    const isFuncHeader = /^\s*func\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\|[^|]*\|/.test(raw);
    const isLambdaHeader = /->\s*\|[^|]*\|/.test(raw);
    let funcOpeningCaptured = false;

    for (let c = 0; c < raw.length; c++) {
      const ch = raw[c];
      if (ch === "{") {
        braceDepth += 1;
        if ((isFuncHeader || isLambdaHeader) && !funcOpeningCaptured) {
          functionBraceStack.push(braceDepth);
          funcOpeningCaptured = true;
        }
      } else if (ch === "}") {
        if (functionBraceStack.length > 0 && functionBraceStack[functionBraceStack.length - 1] === braceDepth) {
          functionBraceStack.pop();
        }
        braceDepth = Math.max(0, braceDepth - 1);
      }
    }
  }
}

function checkFunctionCallArity(lines, diagnostics, ctx) {
  const signatures = ctx.functionSignatures || new Map();
  for (let i = 0; i < lines.length; i++) {
    const raw = stripStringsAndComments(stripComment(lines[i]));
    const re = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*=>\s*\|([^|]*)\|/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const callee = m[1];
      const lhsIdx = m.index;
      const prev = lhsIdx > 0 ? raw[lhsIdx - 1] : "";
      if (prev === ".") continue;
      if (!signatures.has(callee)) continue;

      const signature = signatures.get(callee);
      const minExpected = typeof signature === "number" ? signature : (signature?.min ?? 0);
      const maxExpected = typeof signature === "number" ? signature : (signature?.max ?? 0);
      const argText = m[2].trim();
      const actual = argText === "" ? 0 : argText.split(",").map((s) => s.trim()).filter(Boolean).length;
      if (actual < minExpected || actual > maxExpected) {
        const start = Math.max(raw.indexOf(callee, lhsIdx), 0);
        addDiagnostic(
          diagnostics,
          DiagnosticSeverity.Error,
          i,
          start,
          start + callee.length,
          `Function '${callee}' expects ${minExpected === maxExpected ? `${maxExpected}` : `${minExpected}-${maxExpected}`} argument(s), got ${actual}.`,
        );
      }
    }
  }
}

function checkDisallowedStandaloneCallSemicolon(lines, diagnostics) {
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const code = stripComment(raw).trim();
    if (!code || !code.endsWith(";")) continue;
    if (!code.includes("=>")) continue;
    if (/^(let|const)\b/.test(code)) continue;
    if (/^return\b/.test(code)) continue;
    if (/^[a-zA-Z_][a-zA-Z0-9_]*\s*=/.test(code)) continue;
    const semi = raw.lastIndexOf(";");
    if (semi >= 0) {
      addDiagnostic(
        diagnostics,
        DiagnosticSeverity.Error,
        i,
        semi,
        semi + 1,
        "Standalone call statements should not end with ';'.",
      );
    }
  }
}

function checkMissingSemicolonInLet(lines, diagnostics) {
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw).trim();
    if (!line) continue;
    if (/^(let|const)\b/.test(line) && !line.endsWith(";") && !line.endsWith("{") && !/=\s*$/.test(line)) {
      const insertion = statementEndColumn(raw);
      const start = insertion > 0 ? insertion - 1 : 0;
      const end = Math.max(start + 1, insertion);
      addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, start, end, "Variable declarations should end with ';'.");
    }
  }
}

function checkMalformedComments(lines, diagnostics) {
  // Malformed single-line comment like `/ comment` (not `// comment`).
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*\/\s+\S/.test(raw) && !/^\s*\/\//.test(raw) && !/^\s*\/\*/.test(raw)) {
      const slash = Math.max(raw.indexOf("/"), 0);
      addDiagnostic(
        diagnostics,
        DiagnosticSeverity.Error,
        i,
        slash,
        slash + 1,
        "Malformed comment syntax. Use `// ...` for single-line comments.",
      );
    }
  }

  // Validate block comments and detect stray terminators.
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let inBlockComment = false;
  let blockStart = { line: 0, character: 0 };

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const raw = lines[lineNo];
    for (let c = 0; c < raw.length; c++) {
      const ch = raw[c];
      const next = raw[c + 1];

      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          c += 1;
        }
        continue;
      }

      if (inSingle) {
        if (!escaped && ch === "'") inSingle = false;
        escaped = !escaped && ch === "\\";
        continue;
      }

      if (inDouble) {
        if (!escaped && ch === "\"") inDouble = false;
        escaped = !escaped && ch === "\\";
        continue;
      }

      if (ch === "'") {
        inSingle = true;
        escaped = false;
        continue;
      }
      if (ch === "\"") {
        inDouble = true;
        escaped = false;
        continue;
      }

      if (ch === "/" && next === "/") break;

      if (ch === "/" && next === "*") {
        inBlockComment = true;
        blockStart = { line: lineNo, character: c };
        c += 1;
        continue;
      }

      if (ch === "*" && next === "/") {
        addDiagnostic(
          diagnostics,
          DiagnosticSeverity.Error,
          lineNo,
          c,
          c + 2,
          "Stray block comment terminator `*/`.",
        );
        c += 1;
      }
    }
  }

  if (inBlockComment) {
    addDiagnostic(
      diagnostics,
      DiagnosticSeverity.Error,
      blockStart.line,
      blockStart.character,
      blockStart.character + 2,
      "Unclosed multi-line comment. Missing closing `*/`.",
    );
  }
}

function checkUnbalancedPairs(lines, diagnostics) {
  const pairs = [
    { open: "{", close: "}", name: "brace" },
    { open: "(", close: ")", name: "parenthesis" },
    { open: "[", close: "]", name: "bracket" },
  ];

  for (const pair of pairs) {
    const stack = [];
    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      const stripped = lines[lineNo];
      for (let col = 0; col < stripped.length; col++) {
        const ch = stripped[col];
        if (ch === pair.open) stack.push({ line: lineNo, character: col });
        if (ch === pair.close) {
          if (!stack.length) {
            addDiagnostic(diagnostics, DiagnosticSeverity.Error, lineNo, col, col + 1, `Unmatched closing ${pair.name}.`);
          } else {
            stack.pop();
          }
        }
      }
    }
    for (const pos of stack) {
      addDiagnostic(diagnostics, DiagnosticSeverity.Error, pos.line, pos.character, pos.character + 1, `Unmatched opening ${pair.name}.`);
    }
  }
}

function checkPipeCallBalance(lines, diagnostics) {
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]);
    if (!line.includes("=>")) continue;
    const pipeCount = (maskStrings(line).match(/\|/g) || []).length;
    if (pipeCount % 2 !== 0) {
      addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, 0, lines[i].length, "Possibly unbalanced pipe delimiters in call syntax.");
    }
  }
}

function checkIncompleteCallSyntax(lines, diagnostics) {
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw);
    const arrowIdx = line.indexOf("=>");
    if (arrowIdx < 0) continue;

    const after = line.slice(arrowIdx + 2);
    const trimmed = after.trim();

    // `callee =>` or `callee =>    `
    if (!trimmed) {
      addDiagnostic(
        diagnostics,
        DiagnosticSeverity.Error,
        i,
        arrowIdx,
        Math.min(arrowIdx + 2, raw.length),
        "Incomplete call syntax: expected '|...|' after '=>'.",
      );
      continue;
    }

    // `callee => something` (must start with pipe-delimited arg block)
    const firstNonWs = after.search(/\S/);
    if (firstNonWs >= 0) {
      const absolute = arrowIdx + 2 + firstNonWs;
      if (line[absolute] !== "|") {
        addDiagnostic(
          diagnostics,
          DiagnosticSeverity.Error,
          i,
          absolute,
          Math.min(absolute + 1, raw.length),
          "Invalid call syntax: expected '|' after '=>'.",
        );
      }
    }
  }
}


function checkIncompleteMemberAccess(maskedLines, diagnostics) {
  // Catch incomplete member access like `b.` or `arr[i].` (outside strings/comments).
  for (let i = 0; i < maskedLines.length; i++) {
    const masked = maskedLines[i];
    const trimmedRight = masked.replace(/\s+$/, "");
    if (!trimmedRight.endsWith(".")) continue;

    // Require something that plausibly can have a property after it.
    const beforeDot = trimmedRight.slice(0, -1).trim();
    if (!/([A-Za-z_][A-Za-z0-9_]*|\]|\))$/.test(beforeDot)) continue;

    const dotCol = masked.lastIndexOf(".");
    if (dotCol < 0) continue;

    addDiagnostic(
      diagnostics,
      DiagnosticSeverity.Error,
      i,
      dotCol,
      dotCol + 1,
      "Incomplete member access: expected identifier after '.'.",
    );
  }
}

function checkExpressionContextErrors(lines, diagnostics) {
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // Zekken currently allows ';' for declarations/import/export, but not for
    // assignment/update/expression statements.
    if (trimmed.endsWith(";")) {
      const isAllowed =
        /^(let|const|use|include|export|return)\b/.test(trimmed) ||
        // Common multi-line initializer terminator (e.g. lambda: `let f: fn -> |...| { ... };`).
        /^\}\s*;\s*$/.test(trimmed) ||
        /^\]\s*;\s*$/.test(trimmed) ||
        /^\)\s*;\s*$/.test(trimmed) ||
        // Multi-line initializer terminator for `let x = [ { ... } ];`
        /^\}\s*\]\s*;\s*$/.test(trimmed) ||
        /^\s*$/.test(trimmed);
      if (!isAllowed) {
        const semi = raw.lastIndexOf(";");
        if (semi >= 0) {
          addDiagnostic(
            diagnostics,
            DiagnosticSeverity.Error,
            i,
            semi,
            semi + 1,
            "Semicolons are not supported for this statement type.",
          );
        }
      }
    }

    // Inline if-expressions are not supported in expression position.
    const patterns = [/\[\s*if\b/g, /\(\s*if\b/g, /=\s*if\b/g];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(raw)) !== null) {
        const ifStart = m.index + m[0].indexOf("if");
        addDiagnostic(
          diagnostics,
          DiagnosticSeverity.Error,
          i,
          ifStart,
          ifStart + 2,
          "Inline `if` expressions are not supported.",
        );
      }
    }
  }
}

function checkUnknownUseModules(lines, diagnostics, completionData) {
  const known = new Set(completionData.libraries || []);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw).trim();
    if (!line || !line.startsWith("use ")) continue;

    const direct = /^use\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;?$/.exec(line);
    if (direct) {
      const mod = direct[1];
      if (!known.has(mod)) {
        const start = Math.max(raw.indexOf(mod), 0);
        addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, start, start + mod.length, `Unknown library '${mod}'.`);
      }
      continue;
    }

    const fromImport = /^use\s*\{([^}]*)\}\s*from\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;?$/.exec(line);
    if (fromImport) {
      const mod = fromImport[2];
      if (!known.has(mod)) {
        const start = Math.max(raw.lastIndexOf(mod), 0);
        addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, start, start + mod.length, `Unknown library '${mod}'.`);
      }
    }
  }
}

function checkUnknownUseMembers(lines, diagnostics, completionData) {
  const libMembers = completionData.libMembers || {};
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw).trim();
    const fromImport = /^use\s*\{([^}]*)\}\s*from\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;?$/.exec(line);
    if (!fromImport) continue;

    const members = fromImport[1].split(",").map((s) => s.trim()).filter(Boolean);
    const mod = fromImport[2];
    const allowed = new Set(Array.isArray(libMembers[mod]) ? libMembers[mod] : []);
    for (const member of members) {
      if (allowed.has(member)) continue;
      const start = Math.max(raw.indexOf(member), 0);
      addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, start, start + member.length, `Unknown member '${member}' in library '${mod}'.`);
    }
  }
}

function knownBuiltinNames(completionData) {
  return new Set([...(completionData.atBuiltins || []), ...(completionData.globalFunctions || [])]);
}

function checkUnknownAtBuiltins(lines, diagnostics, completionData) {
  const known = knownBuiltinNames(completionData);
  for (let i = 0; i < lines.length; i++) {
    const line = stripStringsAndComments(lines[i]);
    const re = /@([a-zA-Z_][a-zA-Z0-9_]*)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const name = m[1];
      if (known.has(name)) continue;
      addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, m.index + 1, m.index + 1 + name.length, `Unknown built-in '@${name}'.`);
    }
  }
}

function checkBuiltinInvocationSyntax(lines, diagnostics, completionData) {
  const known = knownBuiltinNames(completionData);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripStringsAndComments(raw);
    const re = /@([a-zA-Z_][a-zA-Z0-9_]*)?/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const atIdx = m.index;
      const name = m[1] || "";
      const prev = atIdx > 0 ? line[atIdx - 1] : "";
      if (/[a-zA-Z0-9_.]/.test(prev)) continue;

      if (!name) {
        addDiagnostic(
          diagnostics,
          DiagnosticSeverity.Error,
          i,
          atIdx,
          atIdx + 1,
          "Invalid built-in call: expected built-in name after '@'.",
        );
        continue;
      }

      if (!known.has(name)) continue;

      const afterNameIdx = atIdx + 1 + name.length;
      const afterName = line.slice(afterNameIdx).trimStart();
      if (!afterName) {
        addDiagnostic(
          diagnostics,
          DiagnosticSeverity.Error,
          i,
          atIdx,
          Math.min(afterNameIdx, raw.length),
          `Incomplete built-in call '@${name}': expected '=> |...|'.`,
        );
        continue;
      }

      if (!afterName.startsWith("=>")) {
        addDiagnostic(
          diagnostics,
          DiagnosticSeverity.Error,
          i,
          atIdx,
          Math.min(afterNameIdx, raw.length),
          `Invalid built-in call '@${name}': expected '=> |...|'.`,
        );
      }
    }
  }
}

function checkUnknownModuleMemberAccess(lines, diagnostics, completionData) {
  const libMembers = completionData.libMembers || {};
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripStringsAndComments(raw);
    const re = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\.\s*([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const lib = m[1];
      const member = m[2];
      if (!Object.prototype.hasOwnProperty.call(libMembers, lib)) continue;
      const allowed = new Set(Array.isArray(libMembers[lib]) ? libMembers[lib] : []);
      if (allowed.has(member)) continue;
      const memberStart = raw.indexOf(member, m.index + lib.length);
      const start = Math.max(memberStart, 0);
      addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, start, start + member.length, `Unknown member '${member}' on library '${lib}'.`);
    }
  }
}

function checkInvalidCastTargets(lines, diagnostics, completionData) {
  const allowed = new Set(completionData.types || []);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw);
    const re = /\.cast\s*=>\s*\|\s*"([^"]+)"\s*\|/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const castType = m[1];
      if (allowed.has(castType)) continue;
      const start = Math.max(raw.indexOf(`"${castType}"`, m.index), 0);
      addDiagnostic(
        diagnostics,
        DiagnosticSeverity.Error,
        i,
        start + 1,
        start + 1 + castType.length,
        `Unsupported cast target '${castType}'. Allowed: ${Array.from(allowed).join(", ")}.`,
      );
    }
  }
}

function checkInvalidLiteralCasts(lines, diagnostics) {
  for (let i = 0; i < lines.length; i++) {
    const raw = stripComment(lines[i]);
    const re = /"([^"\\]|\\.)*"\s*\.cast\s*=>\s*\|\s*"([^"]+)"\s*\|/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const literalRaw = m[0].match(/^"([^"\\]|\\.)*"/);
      const castTarget = m[2];
      if (!literalRaw) continue;
      const literalValue = literalRaw[0].slice(1, -1);
      const valid =
        castTarget === "string" ||
        (castTarget === "int" && /^-?\d+$/.test(literalValue)) ||
        (castTarget === "float" && /^-?(?:\d+\.\d+|\d+\.\d*|\.\d+|\d+)$/.test(literalValue)) ||
        (castTarget === "bool" && /^(true|false)$/i.test(literalValue));
      if (valid) continue;
      const start = Math.max(raw.indexOf(`"${castTarget}"`, m.index), 0);
      addDiagnostic(
        diagnostics,
        DiagnosticSeverity.Error,
        i,
        start + 1,
        start + 1 + castTarget.length,
        `Invalid cast from string literal to '${castTarget}'.`,
      );
    }
  }
}

function checkConstReassignment(lines, diagnostics, ctx) {
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw);
    const re = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(=|\+=|-=|\*=|\/=|%=)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const name = m[1];
      if (!ctx.consts.has(name)) continue;
      const declarationRe = new RegExp(`^\\s*const\\s+${name}\\s*:\\s*[a-zA-Z_][a-zA-Z0-9_]*\\s*=`);
      if (m.index === 0 && declarationRe.test(line)) continue;
      addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, m.index, m.index + name.length, `Cannot reassign const '${name}'.`);
    }
  }
}

function checkUndefinedSymbols(lines, maskedLines, diagnostics, ctx, completionData) {
  const reserved = new Set([
    ...(completionData.keywords || []),
    ...(completionData.types || []),
    ...(completionData.libraries || []),
    ...(completionData.atBuiltins || []),
    ...(completionData.globalFunctions || []),
    "true",
    "false",
  ]);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = maskedLines[i] || "";
    if (!stripped.trim()) continue;
    const line = stripComment(stripped);
    if (shouldSkipUndefinedOnLine(line)) continue;
    const tokens = findIdentifierTokens(line);
    for (const token of tokens) {
      const name = token.name;
      if (reserved.has(name)) continue;
      if (ctx.declared.has(name)) continue;
      if (isDeclarationNameAt(line, token.index)) continue;
      if (isTypePositionAt(line, token.index, name)) continue;
      if (isPropertyNameAt(line, token.index)) continue;
      if (isObjectKeyAt(line, token.index, name)) continue;
      if (isAtBuiltinToken(line, token.index)) continue;
      addDiagnostic(diagnostics, DiagnosticSeverity.Error, i, token.index, token.index + name.length, `Undefined symbol '${name}'.`);
    }
  }
}

function shouldSkipUndefinedOnLine(line) {
  const t = line.trim();
  if (!t) return true;
  if (/^(\/\*|\*\/|\*|\/\/|\/\s+)/.test(t)) return true;
  if (/^(use|include|export)\b/.test(t)) return true;
  if (/@\s*$/.test(t)) return true;
  if (/@[a-zA-Z_][a-zA-Z0-9_]*/.test(t) && !/=>/.test(t)) return true;
  if (/^if\s*\{?$/.test(t)) return true;
  if (/^else\s*if\s*\{?$/.test(t)) return true;
  if (/^while\s*\{?$/.test(t)) return true;
  if (/^for\b/.test(t) && !/^for\s*\|[^|]+\|\s*in\s+.+\{\s*$/.test(t)) return true;
  if (/^func\b/.test(t) && !/^func\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\|[^|]*\|/.test(t)) return true;
  if (/^(try|else)\b/.test(t) && !/\{\s*$/.test(t)) return true;
  if (/^catch\b/.test(t) && !/^catch\s*\|\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\|\s*\{\s*$/.test(t)) return true;
  return false;
}

function buildValidationContext(text, completionData, options = {}, diagnostics = []) {
  const declared = new Set();
  const consts = new Set();
  const declaredTypes = new Map();
  const functionReturnTypes = new Map();
  const functionSignatures = new Map();
  const missingTypeDecls = [];

  for (const v of collectVariables(text)) declared.add(v);
  for (const f of collectFunctions(text)) declared.add(f);
  for (const g of completionData.globalFunctions || []) declared.add(g);
  for (const lib of completionData.libraries || []) declared.add(lib);
  for (const b of completionData.atBuiltins || []) declared.add(b);

  const lines = text.split(/\r?\n/);
  const importedFromInclude = new Set();
  for (const raw of lines) {
    const line = stripComment(raw);
    const maskedLine = stripStringsAndComments(line);

    const typedDecl = /^\s*(?:let|const)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([a-zA-Z_][a-zA-Z0-9_]*)/.exec(maskedLine);
    if (typedDecl) declaredTypes.set(typedDecl[1], typedDecl[2]);

    const emptyTypeDecl = /^\s*(?:let|const)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*=\s*(.+?)\s*;?\s*$/.exec(line);
    if (emptyTypeDecl) {
      missingTypeDecls.push({ name: emptyTypeDecl[1], rhs: (emptyTypeDecl[2] || "").trim() });
    }

    const fnReturn = /^\s*func\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\|[^|]*\|\s*->\s*([a-zA-Z_][a-zA-Z0-9_]*)/.exec(maskedLine);
    if (fnReturn) functionReturnTypes.set(fnReturn[1], fnReturn[2]);

    const constDecl = /^\s*const\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/.exec(maskedLine);
    if (constDecl) consts.add(constDecl[1]);

    const forMatch = /\bfor\s*\|([^|]*)\|/.exec(maskedLine);
    if (forMatch) {
      for (const n of forMatch[1].split(",").map((s) => s.trim()).filter(Boolean)) declared.add(n);
    }

    const catchMatch = /\bcatch\s*\|\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\|/.exec(maskedLine);
    if (catchMatch) declared.add(catchMatch[1]);

    const fnMatch = /\bfunc\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\|([^|]*)\|/.exec(maskedLine);
    if (fnMatch) {
      const fnNameMatch = /\bfunc\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\|/.exec(maskedLine);
      if (fnNameMatch) {
        const fnName = fnNameMatch[1];
        const params = fnMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
        const max = params.length;
        const min = params.filter((p) => !/\s=\s/.test(p)).length;
        functionSignatures.set(fnName, { min, max });
      }
      for (const p of fnMatch[1].split(",").map((s) => s.trim()).filter(Boolean)) {
        const n = p.split(":")[0].trim();
        if (n) declared.add(n);
      }
    }

    const lambdaMatch = /->\s*\|([^|]*)\|/.exec(maskedLine);
    if (lambdaMatch) {
      for (const p of lambdaMatch[1].split(",").map((s) => s.trim()).filter(Boolean)) {
        const n = p.split(":")[0].trim();
        if (n) declared.add(n);
      }
    }

    const useMembers = /^\s*use\s*\{([^}]*)\}\s*from\s+[a-zA-Z_][a-zA-Z0-9_]*\s*;?$/.exec(maskedLine);
    if (useMembers) {
      for (const n of useMembers[1].split(",").map((s) => s.trim()).filter(Boolean)) declared.add(n);
    }

    const includeMembers = /^\s*include\s*\{([^}]*)\}\s*from\s*["'][^"']+["']\s*;?$/.exec(maskedLine);
    if (includeMembers) {
      for (const n of includeMembers[1].split(",").map((s) => s.trim()).filter(Boolean)) declared.add(n);
    }
  }

  // Cross-file include support
  const filePath = pathFromUri(options.uri || "");
  if (filePath) {
    const dir = path.dirname(filePath);
    for (let i = 0; i < lines.length; i++) {
      const raw = stripComment(lines[i]).trim();
      if (!raw.startsWith("include")) continue;

      const includeAll = /^include\s*["']([^"']+)["']\s*;?$/.exec(raw);
      if (includeAll) {
        const abs = path.resolve(dir, includeAll[1]);
        const exported = readExportedSymbols(abs, diagnostics, i);
        for (const sym of exported) {
          declared.add(sym);
          importedFromInclude.add(sym);
        }
        continue;
      }

      const includeSome = /^include\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']\s*;?$/.exec(raw);
      if (includeSome) {
        const requested = includeSome[1].split(",").map((s) => s.trim()).filter(Boolean);
        const abs = path.resolve(dir, includeSome[2]);
        const exported = readExportedSymbols(abs, diagnostics, i);
        const expSet = new Set(exported);
        for (const sym of requested) {
          declared.add(sym);
          importedFromInclude.add(sym);
          if (exported.length > 0 && !expSet.has(sym)) {
            const col = Math.max(lines[i].indexOf(sym), 0);
            addDiagnostic(
              diagnostics,
              DiagnosticSeverity.Error,
              i,
              col,
              col + sym.length,
              `Symbol '${sym}' is not exported by '${includeSome[2]}'.`,
            );
          }
        }
      }
    }
  }

  // Best-effort type inference for `let x: = <expr>;` so later checks can continue with fewer cascades.
  if (missingTypeDecls.length > 0) {
    const ctxForInfer = { declaredTypes, functionReturnTypes, functionSignatures, declared };
    for (const d of missingTypeDecls) {
      if (declaredTypes.has(d.name)) continue;
      const t = inferExpressionType(d.rhs, ctxForInfer, completionData);
      if (t && t !== "unknown") declaredTypes.set(d.name, t);
    }
  }

  return { declared, consts, declaredTypes, functionReturnTypes, functionSignatures, importedFromInclude };
}

function inferExpressionType(expr, ctx, completionData) {
  const s = (expr || "").trim();
  if (!s) return "unknown";

  if ((s.startsWith("\"") && s.endsWith("\"")) || (s.startsWith("'") && s.endsWith("'"))) return "string";
  if (s === "true" || s === "false") return "bool";
  if (/^-?\d+$/.test(s)) return "int";
  if (/^-?(?:\d+\.\d+|\d+\.\d*|\.\d+)$/.test(s)) return "float";
  if (/^\[.*\]$/.test(s)) return "arr";
  if (/^\{.*\}$/.test(s)) return "obj";
  if (/^@input\s*=>\s*\|/.test(s)) return "string";
  if (/^@println\s*=>\s*\|/.test(s)) return "void";

  const castMatch = /\.cast\s*=>\s*\|\s*"([^"]+)"\s*\|$/.exec(s);
  if (castMatch) return castMatch[1];

  const callMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*=>\s*\|/.exec(s);
  if (callMatch) {
    const fn = callMatch[1];
    if (ctx.functionReturnTypes.has(fn)) return ctx.functionReturnTypes.get(fn);
    return "unknown";
  }

  const memberCallMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*=>\s*\|/.exec(s);
  if (memberCallMatch) {
    const lib = memberCallMatch[1];
    const member = memberCallMatch[2];
    if ((completionData.libraries || []).includes(lib)) {
      return inferLibraryMemberReturnType(lib, member);
    }
    return "unknown";
  }

  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) {
    return ctx.declaredTypes.get(s) || "unknown";
  }

  if (/[+\-*/%]/.test(s)) {
    const parts = s.split(/[+\-*/%]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) {
      const partTypes = parts.map((p) => inferExpressionType(p, ctx, completionData));
      if (partTypes.includes("string")) return "string";
      if (partTypes.includes("float")) return "float";
      if (partTypes.every((t) => t === "int")) return "int";
    }
  }

  return "unknown";
}

function inferLibraryMemberReturnType(lib, member) {
  if (lib === "math") {
    if (["PI", "E"].includes(member)) return "float";
    if (["sqrt", "pow", "abs", "sin", "cos", "tan", "dot", "log", "exp", "floor", "ceil", "round", "min", "max", "clamp", "random", "atan2"].includes(member)) return "float";
    if (["rand_int"].includes(member)) return "int";
    if (["rand_choice"].includes(member)) return "unknown";
    if (["shuffle"].includes(member)) return "arr";
    if (member === "vector") return "arr";
    if (["matrix", "matmul"].includes(member)) return "arr";
  }
  if (lib === "fs") {
    if (member === "read_file") return "string";
    if (["read_dir", "read_lines"].includes(member)) return "arr";
    if (["copy_file"].includes(member)) return "int";
    if (["stat"].includes(member)) return "obj";
    if (["exists", "is_file", "is_dir"].includes(member)) return "bool";
    if (["write_file", "append_file", "create_dir", "remove_dir", "remove_file", "rename"].includes(member)) return "void";
  }
  if (lib === "os") {
    if (["cwd", "platform", "env", "home_dir", "temp_dir", "hostname", "username", "arch", "which"].includes(member)) return "string";
    if (["exec"].includes(member)) return "obj";
    if (["ls"].includes(member)) return "arr";
    if (["pid", "spawn", "system", "cpu_count", "uptime_ms"].includes(member)) return "int";
    if (["set_env", "remove_env", "sleep", "exit"].includes(member)) return "void";
    if (["args"].includes(member)) return "arr";
  }
  if (lib === "path") {
    if (["join", "normalize", "resolve", "basename", "dirname", "extname", "stem", "relative"].includes(member)) return "string";
    if (["is_abs"].includes(member)) return "bool";
  }
  if (lib === "encoding") {
    if (["base64_encode", "base64_decode", "hex_encode", "hex_decode", "url_encode", "url_decode"].includes(member)) return "string";
  }
  if (lib === "http") {
    if (["build_query"].includes(member)) return "string";
    if (["parse_query"].includes(member)) return "obj";
    if (["get", "post", "request"].includes(member)) return "obj";
    if (["serve"].includes(member)) return "void";
    // get_json can produce obj/arr/scalars depending on the JSON payload.
    if (["get_json"].includes(member)) return "unknown";
    if (["listen"].includes(member)) return "obj";
  }
  return "unknown";
}

function collectVariables(text) {
  const out = new Set();
  const re = /\b(?:let|const)\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return out;
}

function collectFunctions(text) {
  const out = new Set();
  const re = /\bfunc\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return out;
}

function findIdentifierTokens(line) {
  const out = [];
  const re = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  let m;
  while ((m = re.exec(line)) !== null) out.push({ name: m[1], index: m.index });
  return out;
}

function isDeclarationNameAt(line, idx) {
  const prefix = line.slice(0, idx);
  return /\b(let|const|func)\s*$/.test(prefix) ||
    /\b(?:let|const)\s+[a-zA-Z_][a-zA-Z0-9_]*\s*:\s*$/.test(prefix) ||
    /\bfor\s*\|[^|]*$/.test(prefix) ||
    /\bcatch\s*\|\s*$/.test(prefix);
}

function isPropertyNameAt(line, idx) {
  let p = idx - 1;
  while (p >= 0 && /\s/.test(line[p])) p--;
  return p >= 0 && line[p] === ".";
}

function isObjectKeyAt(line, idx, name) {
  let p = idx + name.length;
  while (p < line.length && /\s/.test(line[p])) p++;
  if (line[p] !== ":") return false;
  let b = idx - 1;
  while (b >= 0 && /\s/.test(line[b])) b--;
  return b >= 0 && (line[b] === "{" || line[b] === ",");
}

function isAtBuiltinToken(line, idx) {
  let p = idx - 1;
  while (p >= 0 && /\s/.test(line[p])) p--;
  return p >= 0 && line[p] === "@";
}

function isTypePositionAt(line, idx, name) {
  const before = line.slice(0, idx);
  if (/:\s*$/.test(before)) return true;
  if (/->\s*$/.test(before)) return true;
  const after = line.slice(idx + name.length);
  if (/^\s*(=|\||,|\{)/.test(after) && /:\s*$/.test(before)) return true;
  return false;
}

function addDiagnostic(diags, severity, line, startChar, endChar, message) {
  const start = Math.max(0, startChar);
  const end = Math.max(start + 1, endChar);
  diags.push({
    severity,
    range: {
      start: { line, character: start },
      end: { line, character: end },
    },
    message,
    source: "zekken-lsp",
  });
}

function dedupeAndSortDiagnostics(diags) {
  const seen = new Set();
  const uniq = [];
  for (const d of diags) {
    const key = [
      d.severity,
      d.range.start.line,
      d.range.start.character,
      d.range.end.line,
      d.range.end.character,
      d.message,
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(d);
  }
  const severityRank = {
    [DiagnosticSeverity.Error]: 0,
    [DiagnosticSeverity.Warning]: 1,
    [DiagnosticSeverity.Information]: 2,
    [DiagnosticSeverity.Hint]: 3,
  };
  uniq.sort((a, b) =>
    a.range.start.line - b.range.start.line ||
    a.range.start.character - b.range.start.character ||
    (severityRank[a.severity] ?? 99) - (severityRank[b.severity] ?? 99) ||
    a.message.localeCompare(b.message)
  );
  return uniq;
}

function addFixHints(diags) {
  return diags.map((d) => {
    if (!d || typeof d.message !== "string") return d;
    if (/\bHint:/i.test(d.message)) return d;
    const hint = getHintForMessage(d.message);
    if (!hint) return d;
    return {
      ...d,
      message: `${d.message}\nHint: ${hint}`,
    };
  });
}

function getHintForMessage(message) {
  if (/Type annotation required/i.test(message)) {
    return "Declare the variable with an explicit type, for example: `let x: int = 45;`.";
  }
  if (/Missing type annotation after ':'/i.test(message)) {
    return "Add a valid type after `:`, such as `int`, `float`, `string`, `bool`, `arr`, `obj`, or `fn`.";
  }
  if (/Missing value in declaration/i.test(message)) {
    return "Provide a value after `=`, or remove the declaration until a value is available.";
  }
  if (/Unknown type/i.test(message) || /Unknown function return type/i.test(message) || /Unknown parameter type/i.test(message)) {
    return "Use one of the supported Zekken types: `int`, `float`, `string`, `bool`, `arr`, `obj`, `fn`.";
  }
  if (/Type mismatch/i.test(message)) {
    return "Change the declared type to match the value, or cast the value before assignment.";
  }
  if (/Cannot reassign const/i.test(message)) {
    return "Use `let` instead of `const` if the value must change.";
  }
  if (/Undefined symbol/i.test(message)) {
    return "Declare or import this symbol before use, and verify there are no typos.";
  }
  if (/Unknown library/i.test(message)) {
    return "Use a valid module name in `use`, such as `math`, `fs`, `os`, `path`, `encoding`, or `http`.";
  }
  if (/Unknown member/i.test(message)) {
    return "Check the module API and use a valid member name.";
  }
  if (/Unknown built-in/i.test(message)) {
    return "Use a valid built-in, for example `@println => |...|` or `@input => |...|`.";
  }
  if (/Invalid built-in call/i.test(message) || /Incomplete built-in call/i.test(message)) {
    return "Built-ins use call syntax like `@println => |value|`.";
  }
  if (/Invalid call syntax/i.test(message) || /Incomplete call syntax/i.test(message)) {
    return "Function calls use `callee => |arg1, arg2|`.";
  }
  if (/Invalid for loop/i.test(message)) {
    return "Use `for |item| in source { ... }` or `for |key, value| in object { ... }`.";
  }
  if (/Invalid function declaration/i.test(message)) {
    return "Use `func name |param: type| { ... }` (optional explicit return type: `-> type`).";
  }
  if (/Return statement is only valid inside/i.test(message)) {
    return "Move this `return` into a function/lambda body.";
  }
  if (/Invalid if statement|Incomplete if statement/i.test(message)) {
    return "Use `if condition { ... }`.";
  }
  if (/Invalid else-if statement|Incomplete else-if statement/i.test(message)) {
    return "Use `else if condition { ... }`.";
  }
  if (/Invalid else statement/i.test(message)) {
    return "Use `else { ... }`.";
  }
  if (/Invalid while loop|Incomplete while loop/i.test(message)) {
    return "Use `while condition { ... }`.";
  }
  if (/Invalid try statement/i.test(message)) {
    return "Use `try { ... }`.";
  }
  if (/Invalid catch statement/i.test(message)) {
    return "Use `catch |err| { ... }`.";
  }
  if (/Unsupported cast target/i.test(message)) {
    return "Cast to a supported type string, for example: `\"int\"`, `\"float\"`, `\"string\"`, `\"bool\"`, `\"arr\"`, `\"obj\"`, `\"fn\"`.";
  }
  if (/Unterminated string literal/i.test(message)) {
    return "Close the string with the matching quote character.";
  }
  if (/Unmatched opening|Unmatched closing/i.test(message)) {
    return "Balance all brackets, braces, and parentheses.";
  }
  if (/Function '.*' expects \d+ argument/i.test(message)) {
    return "Pass the expected number of arguments in the call block.";
  }
  if (/Duplicate declaration/i.test(message)) {
    return "Rename one declaration or remove the duplicate definition.";
  }
  if (/Variable declarations should end with ';'/i.test(message)) {
    return "Add a trailing semicolon for consistency.";
  }
  if (/Semicolons are not supported for this statement type/i.test(message)) {
    return "Remove the trailing semicolon from this statement.";
  }
  if (/Inline `if` expressions are not supported/i.test(message)) {
    return "Use statement-form `if { ... } else { ... }` and assign to a variable before using it in an expression.";
  }
  return null;
}

function stripComment(line) {
  const idx = lineCommentIndex(line);
  return idx >= 0 ? line.slice(0, idx) : line;
}

function statementEndColumn(line) {
  const commentIdx = lineCommentIndex(line);
  const code = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
  return code.replace(/\s+$/g, "").length;
}

function lineCommentIndex(line) {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (inSingle) {
      if (!escaped && ch === "'") inSingle = false;
      escaped = !escaped && ch === "\\";
      continue;
    }

    if (inDouble) {
      if (!escaped && ch === "\"") inDouble = false;
      escaped = !escaped && ch === "\\";
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      escaped = false;
      continue;
    }
    if (ch === "\"") {
      inDouble = true;
      escaped = false;
      continue;
    }

    if (ch === "/" && next === "/") return i;
  }
  return -1;
}

function maskStrings(line) {
  return line.replace(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g, (m) => " ".repeat(m.length));
}

function stripStringsAndComments(line) {
  return maskStrings(stripComment(line));
}

function buildMaskedLines(lines) {
  return maskSource(lines.join("\n"));
}

function pathFromUri(uri) {
  if (!uri || typeof uri !== "string") return null;
  if (!uri.startsWith("file://")) return null;
  try {
    const u = new URL(uri);
    return decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
}

function readExportedSymbols(filePath, diagnostics, lineNoForError) {
  if (!filePath) return [];
  if (FILE_EXPORT_CACHE.has(filePath)) return FILE_EXPORT_CACHE.get(filePath);
  if (!fs.existsSync(filePath)) {
    if (typeof lineNoForError === "number") {
      addDiagnostic(
        diagnostics,
        DiagnosticSeverity.Error,
        lineNoForError,
        0,
        1,
        `Included file not found: '${filePath}'.`,
      );
    }
    FILE_EXPORT_CACHE.set(filePath, []);
    return [];
  }
  try {
    const src = fs.readFileSync(filePath, "utf8");
    const exports = [];
    const re = /export\s+([^;]+);/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      for (const n of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
        exports.push(n);
      }
    }
    FILE_EXPORT_CACHE.set(filePath, exports);
    return exports;
  } catch {
    FILE_EXPORT_CACHE.set(filePath, []);
    return [];
  }
}

module.exports = {
  computeDiagnostics,
  buildMaskedLines,
  stripComment,
  stripStringsAndComments,
};


// --- Token-based (mini-lexer) diagnostics ---------------------------------

function checkMissingSemicolonInLetLexed(lexed, diagnostics) {
  if (!lexed || !Array.isArray(lexed.tokens)) return;

  const starters = new Set([
    "let",
    "const",
    "func",
    "if",
    "else",
    "for",
    "while",
    "try",
    "catch",
    "return",
    "use",
    "include",
    "export",
  ]);

  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;

  let active = null; // { startTokIdx, lastTokIdx }

  const toks = lexed.tokens;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];

    if (t.kind === "Punct") {
      if (t.value === "(") depthParen++;
      else if (t.value === ")") depthParen = Math.max(0, depthParen - 1);
      else if (t.value === "[") depthBracket++;
      else if (t.value === "]") depthBracket = Math.max(0, depthBracket - 1);
      else if (t.value === "{") depthBrace++;
      else if (t.value === "}") depthBrace = Math.max(0, depthBrace - 1);

      if (t.value === ";" && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
        active = null;
        continue;
      }
    }

    // Start tracking at `let`/`const` at top-level expression depth.
    if (!active && t.kind === "Keyword" && (t.value === "let" || t.value === "const") && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      active = { startTokIdx: i, lastTokIdx: i };
      continue;
    }

    if (!active) continue;

    active.lastTokIdx = i;

    // If we hit a new statement starter at top-level without seeing ';', complain.
    if (t.kind === "Keyword" && starters.has(t.value) && i > active.startTokIdx && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      const prev = toks[Math.max(active.lastTokIdx - 1, active.startTokIdx)];
      const ln = prev.endLine;
      const col = prev.endCol;
      addDiagnostic(
        diagnostics,
        DiagnosticSeverity.Error,
        ln,
        Math.max(0, col - 1),
        Math.max(0, col),
        "Variable declarations should end with ';'.",
      );
      active = null;
    }
  }

  if (active) {
    const last = toks[active.lastTokIdx];
    addDiagnostic(
      diagnostics,
      DiagnosticSeverity.Error,
      last.endLine,
      Math.max(0, last.endCol - 1),
      Math.max(0, last.endCol),
      "Variable declarations should end with ';'.",
    );
  }
}

function checkPipeCallBalanceLexed(lexed, diagnostics) {
  if (!lexed || !Array.isArray(lexed.tokens)) return;
  const pipes = [];
  for (const t of lexed.tokens) {
    if (t.kind === "Operator" && t.value === "|") pipes.push(t);
  }
  if (pipes.length % 2 === 0) return;
  const last = pipes[pipes.length - 1];
  addDiagnostic(
    diagnostics,
    DiagnosticSeverity.Error,
    last.startLine,
    last.startCol,
    last.endCol,
    "Unbalanced '|' delimiters.",
  );
}

function checkUndefinedSymbolsLexed(lexed, diagnostics, completionData) {
  if (!lexed || !Array.isArray(lexed.tokens)) return;

  const reserved = new Set([
    "true",
    "false",
    ...(completionData && completionData.keywords ? completionData.keywords : []),
    ...(completionData && completionData.types ? completionData.types : []),
    ...(completionData && completionData.libraries ? completionData.libraries : []),
    ...(completionData && completionData.atBuiltins ? completionData.atBuiltins : []),
    ...(completionData && completionData.globalFunctions ? completionData.globalFunctions : []),
  ]);

  const scopes = [new Set(reserved)];

  function declare(name) {
    if (!name || name === "_") return;
    scopes[scopes.length - 1].add(name);
  }

  function isDeclared(name) {
    if (!name || name === "_") return true;
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].has(name)) return true;
    }
    return false;
  }

  const toks = lexed.tokens;

  let pendingBlockDecls = null; // Set<string> for the next `{`
  let expectLetName = false;
  let expectConstName = false;
  let expectFuncName = false;

  function prevSigTok(idx) {
    for (let j = idx - 1; j >= 0; j--) {
      const t = toks[j];
      if (t.kind === "SingleLineComment" || t.kind === "MultiLineComment") continue;
      return t;
    }
    return null;
  }

  function nextSigTok(idx) {
    for (let j = idx + 1; j < toks.length; j++) {
      const t = toks[j];
      if (t.kind === "SingleLineComment" || t.kind === "MultiLineComment") continue;
      return t;
    }
    return null;
  }

  function parseBinderListFromPipe(pipeIdx) {
    const names = [];
    let j = pipeIdx + 1;
    while (j < toks.length) {
      const t = toks[j];
      if (t.kind === "Operator" && t.value === "|") {
        return { names, closeIdx: j };
      }
      if (t.kind === "Identifier") {
        names.push(t.value);
      }
      j++;
    }
    return { names, closeIdx: pipeIdx };
  }

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];

    // Block scopes: only treat `{` as a scope opener when we have a pending block (func/for/catch/if/etc).
    if (t.kind === "Punct" && t.value === "{") {
      if (pendingBlockDecls) {
        scopes.push(new Set(pendingBlockDecls));
        pendingBlockDecls = null;
      }
      continue;
    }
    if (t.kind === "Punct" && t.value === "}") {
      if (scopes.length > 1) scopes.pop();
      continue;
    }

    if (t.kind === "Keyword") {
      if (t.value === "let") {
        expectLetName = true;
        expectConstName = false;
        expectFuncName = false;
        continue;
      }
      if (t.value === "const") {
        expectConstName = true;
        expectLetName = false;
        expectFuncName = false;
        continue;
      }
      if (t.value === "func") {
        expectFuncName = true;
        expectLetName = false;
        expectConstName = false;
        continue;
      }

      if (t.value === "if" || t.value === "else" || t.value === "while" || t.value === "try") {
        pendingBlockDecls = new Set();
        continue;
      }

      if (t.value === "for" || t.value === "catch") {
        // for |a, b| in ... {  OR catch |e| { ... }
        // Don't scan forward to the next unrelated pipe; only treat an *immediate* pipe/|| as the binder list.
        const nxt = nextSigTok(i);
        if (nxt && nxt.kind === "Operator" && (nxt.value === "|" || nxt.value === "||")) {
          if (nxt.value === "||") {
            pendingBlockDecls = new Set();
          } else {
            let pipeIdx = i + 1;
            while (pipeIdx < toks.length && toks[pipeIdx] !== nxt) pipeIdx++;
            const parsed = parseBinderListFromPipe(pipeIdx);
            pendingBlockDecls = new Set(parsed.names.filter((n) => n && n !== "_"));
            i = parsed.closeIdx;
          }
        } else {
          pendingBlockDecls = new Set();
        }
        continue;
      }

      if (t.value === "use" || t.value === "include") {
        const nxt = nextSigTok(i);
        if (!nxt) continue;
        if (nxt.kind === "Punct" && nxt.value === "{") {
          // Collect identifiers until `}`
          let j = i + 1;
          while (j < toks.length) {
            const tt = toks[j];
            if (tt.kind === "Punct" && tt.value === "}") break;
            if (tt.kind === "Identifier") declare(tt.value);
            j++;
          }
        } else if (nxt.kind === "Identifier") {
          // module name
          declare(nxt.value);
        }
        continue;
      }

      continue;
    }

    if (expectLetName && t.kind === "Identifier") {
      declare(t.value);
      expectLetName = false;
      continue;
    }

    if (expectConstName && t.kind === "Identifier") {
      declare(t.value);
      expectConstName = false;
      continue;
    }

    if (expectFuncName && t.kind === "Identifier") {
      declare(t.value);
      expectFuncName = false;

      // Parse params only if the next significant token is a pipe (or || for empty params).
      // This avoids accidentally scanning forward into unrelated call/lambda pipes.
      const nxt = nextSigTok(i);
      if (nxt && nxt.kind === "Operator" && (nxt.value === "|" || nxt.value === "||")) {
        if (nxt.value === "||") {
          pendingBlockDecls = new Set();
        } else {
          let pipeIdx = i + 1;
          while (pipeIdx < toks.length && toks[pipeIdx] !== nxt) pipeIdx++;
          const parsed = parseBinderListFromPipe(pipeIdx);
          pendingBlockDecls = new Set(parsed.names.filter((n) => n && n !== "_"));
          i = parsed.closeIdx;
        }
      } else {
        pendingBlockDecls = new Set();
      }
      continue;
    }

    // Lambda params: `-> |a: int, b: int| { ... }`
    if (t.kind === "Operator" && t.value === "->") {
      const nxt = nextSigTok(i);
      if (nxt && nxt.kind === "Operator" && (nxt.value === "|" || nxt.value === "||")) {
        if (nxt.value === "||") {
          pendingBlockDecls = new Set();
          continue;
        }
        // find the immediate next pipe index
        let pipeIdx = i + 1;
        while (pipeIdx < toks.length && toks[pipeIdx] !== nxt) pipeIdx++;
        const parsed = parseBinderListFromPipe(pipeIdx);
        pendingBlockDecls = new Set(parsed.names.filter((n) => n && n !== "_"));
        i = parsed.closeIdx;
      }
      continue;
    }

    if (t.kind === "Identifier") {
      const prev = prevSigTok(i);
      const nxt = nextSigTok(i);

      // Ignore member access property names: `obj.prop`
      if (prev && prev.kind === "Operator" && prev.value === ".") continue;
      // Ignore built-in invocations: `@println`
      if (prev && prev.kind === "Operator" && prev.value === "@") continue;
      // Ignore object keys: `key: value`
      if (nxt && nxt.kind === "Punct" && nxt.value === ":") continue;

      const name = t.value;
      if (reserved.has(name)) continue;
      if (isDeclared(name)) continue;

      addDiagnostic(
        diagnostics,
        DiagnosticSeverity.Error,
        t.startLine,
        t.startCol,
        t.endCol,
        `Undefined symbol '${name}'.`,
      );
    }
  }
}


function checkMissingSemicolonOnReturn(lines, diagnostics) {
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const code = stripComment(raw).trim();
    if (!code) continue;
    if (!/^return\b/.test(code)) continue;
    // Match language behavior: return statements should be terminated with ';'.
    if (code.endsWith(";")) continue;

    const end = statementEndColumn(raw);
    const start = Math.max(0, end - 1);
    addDiagnostic(
      diagnostics,
      DiagnosticSeverity.Error,
      i,
      start,
      Math.max(start + 1, end),
      "Return statements should end with ';'.",
    );
  }
}
