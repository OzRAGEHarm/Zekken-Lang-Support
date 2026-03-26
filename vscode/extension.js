const path = require("path");
const vscode = require("vscode");
const { LanguageClient } = require("vscode-languageclient/node");

let client;

async function activate(context) {
  const serverModule = context.asAbsolutePath(path.join("server.js"));
  const outputChannel = vscode.window.createOutputChannel("Zekken LSP");

  const serverOptions = {
    run: {
      command: process.execPath,
      args: [serverModule, "--stdio"],
    },
    debug: {
      command: process.execPath,
      args: [serverModule, "--stdio"],
      options: { env: { ...process.env, ZEKKEN_LSP_DEBUG: "1" } },
    },
  };

  const clientOptions = {
    documentSelector: [{ scheme: "file", language: "zekken" }],
    outputChannel,
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.zk"),
    },
  };

  client = new LanguageClient(
    "zekkenLanguageServer",
    "Zekken Language Server",
    serverOptions,
    clientOptions
  );

  context.subscriptions.push(outputChannel);
  context.subscriptions.push({
    dispose: () => {
      if (!client) {
        return;
      }
      return client.stop().catch(() => undefined);
    },
  });

  try {
    await client.start();
    outputChannel.appendLine("[Zekken LSP] Started.");
  } catch (err) {
    outputChannel.appendLine(
      `[Zekken LSP] Failed to start: ${err && err.message ? err.message : String(err)}`
    );
    vscode.window.showErrorMessage("Zekken LSP failed to start. Open 'Zekken LSP' output for details.");
  }
}

function deactivate() {
  if (!client) {
    return undefined;
  }
  return client.stop().catch(() => undefined);
}

module.exports = {
  activate,
  deactivate,
};
