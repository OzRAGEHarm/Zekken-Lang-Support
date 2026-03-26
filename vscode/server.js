const {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  CompletionItemKind,
  InsertTextFormat,
  MarkupKind,
} = require("vscode-languageserver/node");
const { TextDocument } = require("vscode-languageserver-textdocument");
const fs = require("fs");
const path = require("path");
const { computeDiagnostics, buildMaskedLines } = require("./diagnostics");

process.on("uncaughtException", (err) => {
  console.error("[zekken-lsp] uncaughtException:", err && err.stack ? err.stack : err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[zekken-lsp] unhandledRejection:", reason);
});

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

const HOVER_DATA = loadHoverData();
const COMPLETION_DATA = loadCompletionData(HOVER_DATA);
const OPERATOR_CANDIDATES = loadOperatorCandidates(HOVER_DATA);
const HOVER_SYMBOL_CACHE = new Map();

// Type method completion (matches runtime in src/environment/mod.rs).
const TYPE_METHODS = {
  string: ["length", "toUpper", "toLower", "trim", "split", "cast", "format"],
  arr: ["length", "first", "last", "push", "pop", "shift", "unshift", "join", "cast", "format"],
  obj: ["keys", "values", "entries", "hasKey", "get", "cast", "format"],
  int: ["isEven", "isOdd", "cast", "format"],
  float: ["round", "floor", "ceil", "isEven", "isOdd", "cast", "format"],
  bool: ["cast", "format"],
  fn: ["cast", "format"],
};

const METHOD_SNIPPETS = {
  // Universal
  cast: 'cast => |"$1"|',
  format: "format => ||",
  // String
  length: "length => ||",
  toUpper: "toUpper => ||",
  toLower: "toLower => ||",
  trim: "trim => ||",
  split: "split => |$1|",
  // Array
  first: "first => ||",
  last: "last => ||",
  push: "push => |$1|",
  pop: "pop => ||",
  shift: "shift => ||",
  unshift: "unshift => |$1|",
  join: "join => |$1|",
  // Object
  keys: "keys => ||",
  values: "values => ||",
  entries: "entries => ||",
  hasKey: "hasKey => |$1|",
  get: "get => |$1, $2|",
  // Numeric
  round: "round => ||",
  floor: "floor => ||",
  ceil: "ceil => ||",
  isEven: "isEven => ||",
  isOdd: "isOdd => ||",
};

connection.onInitialize(() => {
  return {
    capabilities: {
      textDocumentSync: documents.syncKind,
      completionProvider: {
        triggerCharacters: [".", "@", ":"],
      },
      hoverProvider: true,
    },
  };
});

documents.onDidOpen((e) => validate(e.document));
documents.onDidChangeContent((e) => validate(e.document));
documents.onDidClose((e) => {
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

connection.onCompletion((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const text = doc.getText();
  const offset = doc.offsetAt(params.position);
  const prefix = text.slice(0, offset);
  const wordMatch = /([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(prefix);
  const wordPrefix = wordMatch ? wordMatch[1] : "";

  // Built-ins typed with @ prefix (e.g. @pri -> @println => ||)
  const atMatch = /@([a-zA-Z_]*)$/.exec(prefix);
  if (atMatch) {
    const typed = atMatch[1] || "";
    const start = offset - atMatch[0].length;
    const range = {
      start: doc.positionAt(start),
      end: params.position,
    };
    return COMPLETION_DATA.atBuiltins.filter((name) => name.startsWith(typed)).map((name) => ({
      label: `@${name}`,
      kind: CompletionItemKind.Function,
      detail: "built-in",
      insertTextFormat: InsertTextFormat.Snippet,
      textEdit: {
        range,
        newText:
          name === "input"
            ? "@input => |\"$1\"|"
            : name === "queue"
              ? "@queue => ||"
              : "@println => ||",
      },
    }));
  }

  const lineText = getLineAt(doc, params.position.line);
  const linePrefix = lineText.slice(0, params.position.character);

  // Type position: `let x: <here>`
  if (/^\s*(let|const)\b/.test(linePrefix) && !/=/.test(linePrefix)) {
    const typeMatch = /:\s*([a-zA-Z_]*)$/.exec(linePrefix);
    if (typeMatch) {
      const typed = typeMatch[1] || "";
      const start = offset - typed.length;
      const range = { start: doc.positionAt(start), end: params.position };
      return COMPLETION_DATA.types
        .filter((t) => t.startsWith(typed))
        .map((t) => ({
          label: t,
          kind: CompletionItemKind.TypeParameter,
          detail: "type",
          textEdit: { range, newText: t },
        }));
    }
  }


  // Function return type position: `func name |...| -> <here>`
  const fnRetMatch = /^\s*func\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\|[^|]*\|\s*->\s*([a-zA-Z_]*)$/.exec(linePrefix);
  if (fnRetMatch) {
    const typed = fnRetMatch[1] || '';
    const start = offset - typed.length;
    const range = { start: doc.positionAt(start), end: params.position };
    return COMPLETION_DATA.types
      .filter((t) => t.startsWith(typed))
      .map((t) => ({
        label: t,
        kind: CompletionItemKind.TypeParameter,
        detail: 'type',
        textEdit: { range, newText: t },
      }));
  }
  // `use <lib>`
  const useMatch = /^\s*use\s+([a-zA-Z_]*)$/.exec(linePrefix);
  if (useMatch) {
    const typed = useMatch[1] || "";
    const start = offset - typed.length;
    const range = { start: doc.positionAt(start), end: params.position };
    return COMPLETION_DATA.libraries
      .filter((lib) => lib.startsWith(typed))
      .map((lib) => ({
        label: lib,
        kind: CompletionItemKind.Module,
        detail: "library",
        textEdit: { range, newText: lib },
      }));
  }

  // `use { member1, mem<here> } from <lib>`
  const useMembersMatch = /^\s*use\s*\{([^}]*)$/.exec(linePrefix);
  if (useMembersMatch) {
    const fromMatch = /\bfrom\s+([a-zA-Z_][a-zA-Z0-9_]*)/.exec(lineText);
    const lib = fromMatch ? fromMatch[1] : null;
    if (lib && COMPLETION_DATA.libMembers[lib]) {
      const inside = useMembersMatch[1] || "";
      const parts = inside.split(",").map((s) => s.trim());
      const typed = (parts[parts.length - 1] || "").trim();
      const start = offset - typed.length;
      const range = { start: doc.positionAt(start), end: params.position };
      return COMPLETION_DATA.libMembers[lib]
        .filter((m) => m.startsWith(typed))
        .map((m) => ({
          label: m,
          kind: CompletionItemKind.Method,
          detail: `${lib} member`,
          textEdit: { range, newText: m },
        }));
    }
  }

  const dotMatch = /([a-zA-Z_][a-zA-Z0-9_]*)\.\s*([a-zA-Z_]*)$/.exec(prefix);
  if (dotMatch) {
    const lhs = dotMatch[1];
    const typedMember = dotMatch[2] || "";
    const start = offset - typedMember.length;
    const range = { start: doc.positionAt(start), end: params.position };

    if (COMPLETION_DATA.libMembers[lhs]) {
      return COMPLETION_DATA.libMembers[lhs]
        .filter((m) => m.startsWith(typedMember))
        .map((m) => ({
          label: m,
          kind: CompletionItemKind.Method,
          detail: `${lhs} member`,
          insertTextFormat: InsertTextFormat.Snippet,
          textEdit: {
            range,
            newText: /^[A-Z_][A-Z0-9_]*$/.test(m) ? m : `${m} => |$1|`,
          },
        }));
    }

    const queueVars = collectQueueVariables(text);
    if (queueVars.has(lhs)) {
      const queueMembers = ["enqueue", "dequeue", "peek", "length", "is_empty", "clear"];
      return queueMembers
        .filter((m) => m.startsWith(typedMember))
        .map((m) => ({
          label: m,
          kind: CompletionItemKind.Method,
          detail: "queue method",
          insertTextFormat: InsertTextFormat.Snippet,
          textEdit: {
            range,
            newText: m === "enqueue" ? "enqueue => |$1|" : `${m} => ||`,
          },
        }));
    }

    const varTypes = collectVariablesWithInferredTypes(text);
    const t = varTypes.get(lhs);
    if (t && TYPE_METHODS[t]) {
      const methods = TYPE_METHODS[t];
      return methods
        .filter((m) => m.startsWith(typedMember))
        .map((m) => ({
          label: m,
          kind: CompletionItemKind.Method,
          detail: `${t} method`,
          insertTextFormat: InsertTextFormat.Snippet,
          textEdit: {
            range,
            newText: METHOD_SNIPPETS[m] || `${m} => ||`,
          },
        }));
    }
  }





  // Avoid noisy completions when the user isn't typing an identifier.
  // This prevents Enter/newline from accidentally accepting e.g. `arr` when opening multiline literals.
  if (!wordPrefix) {
    return [];
  }

  const items = [];
  const keywordSnippets = {
    func: "func ${1:name} |${2:args}| {\n  $0\n}",
  };
  const add = (label, kind, detail, insertText) =>
    items.push({
      label,
      kind,
      detail,
      ...(insertText
        ? {
            insertText,
            insertTextFormat: InsertTextFormat.Snippet,
          }
        : {}),
    });

  for (const kw of COMPLETION_DATA.keywords) {
    if (!wordPrefix || kw.startsWith(wordPrefix)) {
      add(kw, CompletionItemKind.Keyword, "keyword", keywordSnippets[kw]);
    }
  }
  for (const gf of COMPLETION_DATA.globalFunctions) {
    if (!wordPrefix || gf.startsWith(wordPrefix)) {
      add(gf, CompletionItemKind.Function, "global function", `${gf} => |$1|`);
    }
  }
  for (const lib of COMPLETION_DATA.libraries) if (!wordPrefix || lib.startsWith(wordPrefix)) add(lib, CompletionItemKind.Module, "library");

  const vars = collectVariables(text);
  const funcs = collectFunctions(text);
  for (const name of vars) if (!wordPrefix || name.startsWith(wordPrefix)) add(name, CompletionItemKind.Variable, "variable");
  for (const name of funcs) if (!wordPrefix || name.startsWith(wordPrefix)) add(name, CompletionItemKind.Function, "function", `${name} => |$1|`);

  return items;
});

connection.onHover((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const line = getLineAt(doc, params.position.line);
  if (isInStringOrCommentAt(line, params.position.character)) return null;

  const contextual = getContextualLineHover(doc, params.position);
  if (contextual) {
    return contextual;
  }

  const word = getWordAt(doc, params.position);
  if (!word) return null;

  const symbols = buildSymbolIndex(doc.getText(), doc.uri);
  const symbolInfo = getBestSymbolForHover(symbols, word, params.position.line, doc.uri);
  // Reduce hover noise: only show declaration hovers for functions/imports/params/loop vars.
  if (symbolInfo && ["function", "imported", "param", "loop"].includes(symbolInfo.kind)) {
    const lineNum = symbolInfo.line + 1;
    const colNum = symbolInfo.character + 1;
    const sourceLabel = symbolInfo.sourcePath
      ? `Declared in: \`${symbolInfo.sourcePath}\` (Ln ${lineNum}, Col ${colNum})`
      : `Declared at: Ln ${lineNum}, Col ${colNum}`;
    const value = [
      `**${word}**`,
      "",
      `${symbolInfo.kind === "function" ? "Function" : symbolInfo.kind === "imported" ? "Imported symbol" : symbolInfo.kind === "param" ? "Parameter" : "Variable"} declaration`,
      `\`${symbolInfo.declaration}\``,
      "",
      sourceLabel,
      ...(symbolInfo.detail ? ["", symbolInfo.detail] : []),
    ].join("\n");
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value,
      },
    };
  }

  const info = getHoverDoc(word);
  if (!info) return null;

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: `**${word}**\n\n${info}`,
    },
  };
});

documents.listen(connection);
connection.listen();

function validate(document) {
  const text = document.getText();
  const diagnostics = computeDiagnostics(text, COMPLETION_DATA, { uri: document.uri });

  connection.sendDiagnostics({
    uri: document.uri,
    diagnostics,
  });
}

function collectVariables(text) {
  const out = new Set();
  const re = /\b(?:let|const)\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return out;
}

function collectVariablesWithTypes(text) {
  const out = new Map();
  const re = /\b(?:let|const)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.set(m[1], m[2]);
  }
  return out;
}

function inferSimpleTypeFromExpr(expr) {
  const s = (expr || "").trim();
  if (!s) return null;
  if ((s.startsWith("\"") && s.endsWith("\"")) || (s.startsWith("'") && s.endsWith("'"))) return "string";
  if (s === "true" || s === "false") return "bool";
  if (/^-?\d+$/.test(s)) return "int";
  if (/^-?(?:\d+\.\d+|\d+\.\d*|\.\d+)$/.test(s)) return "float";
  if (s.startsWith("[") && s.endsWith("]")) return "arr";
  if (s.startsWith("{") && s.endsWith("}")) return "obj";
  return null;
}

function collectVariablesWithInferredTypes(text) {
  const out = collectVariablesWithTypes(text);
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = stripComment(raw).trim();
    const m = /^(?:let|const)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*=\s*(.+?);?\s*$/.exec(line);
    if (!m) continue;
    const name = m[1];
    const rhs = (m[2] || "").trim();
    if (out.has(name)) continue;
    const t = inferSimpleTypeFromExpr(rhs);
    if (t) out.set(name, t);
  }
  return out;
}

function collectFunctions(text) {
  const out = new Set();
  const re = /\bfunc\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return out;
}

function collectQueueVariables(text) {
  const out = new Set();
  const re = /\b(?:let|const)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*obj\s*=\s*@queue\s*=>\s*\|\|/g;
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return out;
}

function getWordAt(document, position) {
  const text = document.getText();
  const offset = document.offsetAt(position);
  const isWord = (c) => /[a-zA-Z0-9_]/.test(c);

  let start = offset;
  while (start > 0 && isWord(text[start - 1])) start--;
  let end = offset;
  while (end < text.length && isWord(text[end])) end++;

  const word = text.slice(start, end);
  return word || null;
}

function inferMemberDoc(word) {
  return (HOVER_DATA.methods || {})[word] || null;
}

function buildSymbolIndex(text, docUri = "") {
  const symbols = new Map();
  const lines = text.split(/\r?\n/);
  const maskedLines = buildMaskedLines(lines);
  const localPath = pathFromUri(docUri);

  // Scope model: brace-delimited blocks. We attach each declaration to its scope id.
  const scopes = [{ id: 0, parent: -1, startLine: 0, endLine: lines.length - 1, depth: 0 }];
  const scopeStack = [0];
  const lineScopeId = new Array(lines.length).fill(0);

  let pendingParams = null; // { kind, fnName, params: [{name,type}], sig, startLine }
  let pendingLoopVars = null; // { kind, vars: [name], startLine }

  const parseParams = (rawParams) => {
    const out = [];
    const parts = (rawParams || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) {
      const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*(?::\s*([a-zA-Z_][a-zA-Z0-9_]*))?/.exec(p);
      if (!m) continue;
      out.push({ name: m[1], type: m[2] || null });
    }
    return out;
  };

  const openScope = (lineNo, kind) => {
    const parent = scopeStack[scopeStack.length - 1];
    const id = scopes.length;
    const depth = (scopes[parent]?.depth ?? 0) + 1;
    scopes.push({ id, parent, startLine: lineNo, endLine: lines.length - 1, depth, kind: kind || "block" });
    scopeStack.push(id);
    return id;
  };

  const closeScope = (lineNo) => {
    if (scopeStack.length <= 1) return;
    const id = scopeStack.pop();
    scopes[id].endLine = lineNo;
  };

  const addDecl = (name, entry) => {
    pushSymbol(symbols, name, entry);
  };

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    lineScopeId[lineNo] = scopeStack[scopeStack.length - 1];

    const rawLine = lines[lineNo];
    const masked = maskedLines[lineNo] || "";
    if (!masked.trim()) continue;

    const maskedNoLineComment = stripComment(masked);
    const rawNoLineComment = stripComment(rawLine);

    // Function declaration (records function symbol in the current scope).
    const fnDecl = /^\s*func\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\|([^|]*)\|\s*(->\s*([a-zA-Z_][a-zA-Z0-9_]*))?/.exec(maskedNoLineComment);
    if (fnDecl) {
      const fnName = fnDecl[1];
      const paramsRaw = (fnDecl[2] || "").trim();
      const returnType = fnDecl[4] ? fnDecl[4].trim() : null;
      const col = Math.max(rawLine.indexOf(fnName), 0);
      const signature = `func ${fnName} |${paramsRaw}|${returnType ? ` -> ${returnType}` : ""}`;
      const allParams = paramsRaw ? paramsRaw.split(",").map((p) => p.trim()).filter(Boolean) : [];
      const maxParams = allParams.length;
      const minParams = allParams.filter((p) => !/\s=\s/.test(p)).length;
      const arityText = minParams === maxParams ? `${maxParams}` : `${minParams}-${maxParams}`;
      const detail = `Parameters: ${arityText}${returnType ? `\n\nReturns: \`${returnType}\`` : ""}`;

      addDecl(fnName, {
        kind: "function",
        line: lineNo,
        character: col,
        declaration: signature,
        detail,
        sourceUri: docUri,
        sourcePath: localPath || "",
        scopeId: scopeStack[scopeStack.length - 1],
        scopeDepth: scopes[scopeStack[scopeStack.length - 1]]?.depth ?? 0,
      });

      pendingParams = {
        kind: "function",
        fnName,
        params: parseParams(paramsRaw),
        startLine: lineNo,
      };
    }

    // Lambda header (`-> |...|`) also introduces a parameter scope at the next '{'.
    const lambdaDecl = /->\s*\|([^|]*)\|/.exec(maskedNoLineComment);
    if (lambdaDecl) {
      pendingParams = {
        kind: "lambda",
        fnName: "<lambda>",
        params: parseParams((lambdaDecl[1] || "").trim()),
        startLine: lineNo,
      };
    }

    // For-loop iterator variables are scoped to the block body.
    const forMatch = /\bfor\s*\|([^|]*)\|\s*in\b/.exec(maskedNoLineComment);
    if (forMatch) {
      const vars = (forMatch[1] || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.split(":")[0].trim())
        .filter(Boolean);
      if (vars.length > 0) {
        pendingLoopVars = { kind: "for", vars, startLine: lineNo };
      }
    }

    const catchMatch = /\bcatch\s*\|\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\|/.exec(maskedNoLineComment);
    if (catchMatch) {
      pendingLoopVars = { kind: "catch", vars: [catchMatch[1]], startLine: lineNo };
    }

    // Variable declaration in the current scope.
    const varDecl = /^\s*(let|const)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([a-zA-Z_][a-zA-Z0-9_]*)/.exec(maskedNoLineComment);
    if (varDecl) {
      const kindKeyword = varDecl[1];
      const name = varDecl[2];
      const type = varDecl[3];
      const col = Math.max(rawLine.indexOf(name), 0);
      const declaration = `${kindKeyword} ${name}: ${type};`;
      const detail = `Type: \`${type}\`${kindKeyword === "const" ? "\n\nImmutable (`const`)." : "\n\nMutable (`let`)."}`;
      addDecl(name, {
        kind: "variable",
        line: lineNo,
        character: col,
        declaration,
        detail,
        sourceUri: docUri,
        sourcePath: localPath || "",
        scopeId: scopeStack[scopeStack.length - 1],
        scopeDepth: scopes[scopeStack[scopeStack.length - 1]]?.depth ?? 0,
      });
    }

    // Apply braces in source order (maskedLine already hides strings and comments).
    for (let c = 0; c < maskedNoLineComment.length; c++) {
      const ch = maskedNoLineComment[c];
      if (ch === "{") {
        const newScopeId = openScope(lineNo, pendingParams ? pendingParams.kind : (pendingLoopVars ? pendingLoopVars.kind : "block"));

        if (pendingParams && pendingParams.params.length > 0) {
          for (const p of pendingParams.params) {
            const pName = p.name;
            const pType = p.type;
            const pCol = Math.max(rawNoLineComment.indexOf(pName), 0);
            addDecl(pName, {
              kind: "param",
              line: pendingParams.startLine,
              character: pCol,
              declaration: pType ? `param ${pName}: ${pType}` : `param ${pName}`,
              detail: `Parameter${pendingParams.kind === "function" ? ` of \`${pendingParams.fnName}\`` : ""}${pType ? `\n\nType: \`${pType}\`` : ""}.`,
              sourceUri: docUri,
              sourcePath: localPath || "",
              scopeId: newScopeId,
              scopeDepth: scopes[newScopeId]?.depth ?? 0,
            });
          }
        }

        if (pendingLoopVars && pendingLoopVars.vars.length > 0) {
          for (const vName of pendingLoopVars.vars) {
            const vCol = Math.max(rawNoLineComment.indexOf(vName), 0);
            addDecl(vName, {
              kind: "loop",
              line: pendingLoopVars.startLine,
              character: vCol,
              declaration: `loop ${vName}`,
              detail: "Loop variable.",
              sourceUri: docUri,
              sourcePath: localPath || "",
              scopeId: newScopeId,
              scopeDepth: scopes[newScopeId]?.depth ?? 0,
            });
          }
        }

        pendingParams = null;
        pendingLoopVars = null;
      } else if (ch === "}") {
        closeScope(lineNo);
      }
    }
  }

  // Cross-file include support for hover.
  const imported = collectIncludedSymbolEntries(text, docUri);
  for (const [name, entry] of imported) {
    pushSymbol(symbols, name, { ...entry, scopeId: 0, scopeDepth: 0 });
  }

  // Attach scope metadata for hover resolution.
  symbols._scopes = scopes;
  symbols._lineScopeId = lineScopeId;

  return symbols;
}

function pushSymbol(symbols, name, entry) {
  if (!symbols.has(name)) symbols.set(name, []);
  symbols.get(name).push(entry);
}

function getBestSymbolForHover(symbols, name, hoverLine, currentUri = "") {
  if (!symbols.has(name)) return null;
  const entries = symbols.get(name);
  const localEntries = entries.filter((e) => (e.sourceUri || "") === (currentUri || ""));

  const scopes = symbols._scopes || [{ id: 0, parent: -1, startLine: 0, endLine: hoverLine, depth: 0 }];
  const lineScopeId = symbols._lineScopeId || [];
  let sid = lineScopeId[hoverLine] ?? 0;
  const chain = new Set();
  while (sid >= 0 && sid < scopes.length) {
    chain.add(sid);
    sid = scopes[sid].parent;
  }

  const candidates = localEntries.filter((e) => chain.has(e.scopeId ?? 0));
  const pool = candidates.length > 0 ? candidates : localEntries;

  let best = null;
  for (const e of pool) {
    if (typeof e.line === "number" && e.line > hoverLine) continue;
    const depth = e.scopeDepth ?? 0;
    if (!best) {
      best = e;
      continue;
    }
    const bestDepth = best.scopeDepth ?? 0;
    if (depth > bestDepth) {
      best = e;
      continue;
    }
    if (depth === bestDepth) {
      if (e.line > best.line || (e.line === best.line && e.character > best.character)) {
        best = e;
      }
    }
  }

  if (best) return best;
  if (pool.length > 0) return pool[0];
  return entries[0] || null;
}

function collectIncludedSymbolEntries(text, docUri) {
  const out = new Map();
  const currentPath = pathFromUri(docUri);
  if (!currentPath) return out;
  const currentDir = path.dirname(currentPath);
  const lines = text.split(/\r?\n/);

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const raw = stripComment(lines[lineNo]).trim();
    if (!raw.startsWith("include")) continue;

    const includeAll = /^include\s*["']([^"']+)["']\s*;?$/.exec(raw);
    if (includeAll) {
      const targetPath = path.resolve(currentDir, includeAll[1]);
      const exported = getExportedSymbolsFromFile(targetPath);
      for (const [name, meta] of exported.entries()) {
        out.set(name, {
          kind: "imported",
          line: meta.line,
          character: meta.character,
          declaration: meta.declaration || `export ${name}`,
          detail: `Imported via \`include "${includeAll[1]}"\`.`,
          sourceUri: fileUriFromPath(targetPath),
          sourcePath: targetPath,
        });
      }
      continue;
    }

    const includeSome = /^include\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']\s*;?$/.exec(raw);
    if (includeSome) {
      const requested = includeSome[1].split(",").map((s) => s.trim()).filter(Boolean);
      const targetPath = path.resolve(currentDir, includeSome[2]);
      const exported = getExportedSymbolsFromFile(targetPath);
      for (const name of requested) {
        if (exported.has(name)) {
          const meta = exported.get(name);
          out.set(name, {
            kind: "imported",
            line: meta.line,
            character: meta.character,
            declaration: meta.declaration || `export ${name}`,
            detail: `Imported via \`include { ${requested.join(", ")} } from "${includeSome[2]}"\`.`,
            sourceUri: fileUriFromPath(targetPath),
            sourcePath: targetPath,
          });
        }
      }
    }
  }

  return out;
}

function getExportedSymbolsFromFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return new Map();
  if (HOVER_SYMBOL_CACHE.has(filePath)) return HOVER_SYMBOL_CACHE.get(filePath);

  const src = fs.readFileSync(filePath, "utf8");
  const lines = src.split(/\r?\n/);
  const declarations = new Map();
  const exports = new Set();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const code = stripComment(raw);

    const varDecl = /^\s*(let|const)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.*?);?\s*$/.exec(code);
    if (varDecl) {
      const kw = varDecl[1];
      const name = varDecl[2];
      const type = varDecl[3];
      const valueExpr = (varDecl[4] || "").trim();
      declarations.set(name, {
        line: i,
        character: Math.max(raw.indexOf(name), 0),
        declaration: `${kw} ${name}: ${type}${valueExpr ? ` = ${valueExpr}` : ""};`,
      });
    }

    const fnDecl = /^\s*func\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\|([^|]*)\|\s*(->\s*([a-zA-Z_][a-zA-Z0-9_]*))?/.exec(code);
    if (fnDecl) {
      const name = fnDecl[1];
      const params = (fnDecl[2] || "").trim();
      const returnType = fnDecl[4] ? fnDecl[4].trim() : null;
      declarations.set(name, {
        line: i,
        character: Math.max(raw.indexOf(name), 0),
        declaration: `func ${name} |${params}|${returnType ? ` -> ${returnType}` : ""}`,
      });
    }

    const ex = /export\s+([^;]+);?/.exec(code);
    if (ex) {
      for (const n of ex[1].split(",").map((s) => s.trim()).filter(Boolean)) exports.add(n);
    }
  }

  const map = new Map();
  for (const name of exports) {
    if (declarations.has(name)) map.set(name, declarations.get(name));
    else map.set(name, { line: 0, character: 0, declaration: `export ${name}` });
  }
  HOVER_SYMBOL_CACHE.set(filePath, map);
  return map;
}

function pathFromUri(uri) {
  if (!uri || typeof uri !== "string" || !uri.startsWith("file://")) return "";
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return "";
  }
}

function fileUriFromPath(filePath) {
  return `file://${filePath}`;
}

function getContextualLineHover(document, position) {
  const line = getLineAt(document, position.line);
  const word = getWordAt(document, position);
  if (!word) return null;

  // include { a, b } from "file.zk"
  if (/\binclude\b/.test(line)) {
    if (/\bfrom\b/.test(line)) {
      const m = /include\s*\{([^}]*)\}\s*from\s*("([^"]+)"|'([^']+)')/.exec(line);
      if (m) {
        const symbols = m[1].split(",").map((s) => s.trim()).filter(Boolean);
        const file = m[3] || m[4] || "file";
        if (symbols.includes(word)) {
          return hover(word, `Included symbol from \`${file}\`.\n\nThis name must be exported by the target file.`);
        }
      }
    } else {
      const m = /include\s*("([^"]+)"|'([^']+)')/.exec(line);
      if (m && (word === "include")) {
        const file = m[2] || m[3] || "file";
        return hover(word, `Includes all exported symbols from \`${file}\`.`);
      }
    }
  }

  // export a, b, c;
  if (/\bexport\b/.test(line)) {
    const m = /export\s+(.+);?/.exec(line);
    if (m) {
      const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (names.includes(word)) {
        return hover(word, "Exported symbol.\n\nAvailable to other files via `include`.");
      }
    }
  }

  // use { read_file } from fs;
  if (/\buse\b/.test(line) && /\bfrom\b/.test(line)) {
    const m = /use\s*\{([^}]*)\}\s*from\s*([a-zA-Z_][a-zA-Z0-9_]*)/.exec(line);
    if (m) {
      const members = m[1].split(",").map((s) => s.trim()).filter(Boolean);
      const mod = m[2];
      if (members.includes(word)) {
        const memberDoc = ((HOVER_DATA.module_members || {})[word]) || `${mod}.${word} member import.`;
        return hover(word, `Imported from module \`${mod}\`.\n\n${memberDoc}`);
      }
    }
  }

  return null;
}

function getOperatorHoverAt(document, position) {
  const line = getLineAt(document, position.line);
  const c = position.character;
  if (isInStringOrCommentAt(line, c)) return null;
  const two = line.slice(Math.max(0, c - 1), Math.min(line.length, c + 1));
  const one = line[c] || line[c - 1] || "";

  for (const op of OPERATOR_CANDIDATES.twoChar) {
    if (line.slice(c, c + 2) === op || line.slice(c - 1, c + 1) === op) {
      return hover(op, (HOVER_DATA.operators || {})[op]);
    }
  }

  if (OPERATOR_CANDIDATES.oneChar.includes(one)) {
    return hover(one, (HOVER_DATA.operators || {})[one]);
  }

  // Handle when cursor is between operator chars.
  if (OPERATOR_CANDIDATES.twoChar.includes(two)) {
    return hover(two, (HOVER_DATA.operators || {})[two]);
  }

  return null;
}

function getLineAt(document, lineNumber) {
  const text = document.getText();
  const lines = text.split(/\r?\n/);
  return lines[lineNumber] || "";
}

function isInStringOrCommentAt(line, character) {
  if (!line) return false;
  const idx = Math.max(0, Math.min(character, line.length));
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < idx; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (!inSingle && !inDouble && ch === "/" && next === "/") {
      return true;
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
    }
  }

  if (!inSingle && !inDouble) {
    const commentIdx = line.indexOf("//");
    if (commentIdx >= 0 && idx >= commentIdx) return true;
  }
  return inSingle || inDouble;
}

function hover(title, body) {
  if (!body) return null;
  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: `**${title}**\n\n${body}`,
    },
  };
}

function loadHoverData() {
  try {
    const filePath = path.join(__dirname, "hover-data.json");
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("[zekken-lsp] Failed to load hover-data.json:", err);
    return {};
  }
}

function loadCompletionData(data) {
  const completion = data && data.completion ? data.completion : {};
  return {
    keywords: Array.isArray(completion.keywords) ? completion.keywords : [],
    types: Array.isArray(completion.types) ? completion.types : [],
    atBuiltins: Array.isArray(completion.at_builtins) ? completion.at_builtins : [],
    globalFunctions: Array.isArray(completion.global_functions) ? completion.global_functions : [],
    libraries: Array.isArray(completion.libraries) ? completion.libraries : [],
    libMembers: completion.lib_members && typeof completion.lib_members === "object" ? completion.lib_members : {},
  };
}

function loadOperatorCandidates(data) {
  const ops = data && data.operators && typeof data.operators === "object"
    ? Object.keys(data.operators)
    : [];
  return {
    twoChar: ops.filter((op) => op.length === 2),
    oneChar: ops.filter((op) => op.length === 1),
  };
}

function getHoverDoc(word) {
  return (
    (HOVER_DATA.keywords || {})[word] ||
    (HOVER_DATA.types || {})[word] ||
    (HOVER_DATA.literals || {})[word] ||
    (HOVER_DATA.builtins || {})[word] ||
    (HOVER_DATA.modules || {})[word] ||
    (HOVER_DATA.module_members || {})[word] ||
    (HOVER_DATA.methods || {})[word] ||
    null
  );
}

function stripComment(line) {
  const idx = line.indexOf("//");
  return idx >= 0 ? line.slice(0, idx) : line;
}

function maskStrings(line) {
  return line.replace(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g, (m) => " ".repeat(m.length));
}

function stripStringsAndComments(line) {
  return maskStrings(stripComment(line));
}
