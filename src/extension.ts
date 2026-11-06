import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

async function traceAndRender(uri: vscode.Uri, position: vscode.Position, fallbackName: string, panel: vscode.WebviewPanel) {
    try {
        // query definition
        const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeDefinitionProvider',
            uri,
            position
        );

        // query references
        const references = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeReferenceProvider',
            uri,
            position
        );

        const wordRange = vscode.window.activeTextEditor?.document.getWordRangeAtPosition(position);
        const symbolName = wordRange ? vscode.window.activeTextEditor!.document.getText(wordRange) : fallbackName;

        if (definitions && definitions.length > 0) {
            const def = definitions[0];
            const targetDoc = await vscode.workspace.openTextDocument(def.uri);
            
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                def.uri
            );

            let sourceCode = targetDoc.lineAt(def.range.start.line).text.trim();
            
            function findSymbolAtLine(syms: vscode.DocumentSymbol[], line: number, targetName: string): vscode.DocumentSymbol | undefined {
                if (!syms) return undefined;
                for (const sym of syms) {
                    if (sym.range.start.line <= line && sym.range.end.line >= line) {
                        // If this symbol is exactly what the user clicked, stop here
                        if (sym.name === targetName) {
                            return sym;
                        }
                        const childMatch = findSymbolAtLine(sym.children, line, targetName);
                        return childMatch ? childMatch : sym;
                    }
                }
                return undefined;
            }

            if (symbols) {
                const targetSymbol = findSymbolAtLine(symbols, def.range.start.line, symbolName);
                if (targetSymbol) {
                    sourceCode = targetDoc.getText(targetSymbol.range);
                }
            }

            const refList = references ? references.map(ref => ({
                file: ref.uri.path.split('/').pop(),
                fullUri: ref.uri.toString(),
                line: ref.range.start.line + 1 
            })) : [];

            const fileName = def.uri.path.split('/').pop() || "";

            // this will be send into the webview where the window.addEventListener('message', ...) will handle it
            const payload = {
                command: 'addNode',
                data: {
                    symbolName: symbolName,
                    fileName: fileName,
                    fileExt: fileName.split('.').pop(),
                    line: def.range.start.line + 1,
                    code: sourceCode,
                    references: refList
                }
            };
            
            panel.webview.postMessage(payload);
        } else {
            vscode.window.showInformationMessage('LSP returned no definition for this symbol.');
        }
    } catch (error) {
        console.error('LSP Query failed:', error);
    }
}

export function activate(context: vscode.ExtensionContext) {
    let currentPanel: vscode.WebviewPanel | undefined = undefined;

    let disposable = vscode.commands.registerCommand('stackdelta.traceSymbol', async () => {
        // 1. Get the current editor and cursor position
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor found.');
            return;
        }

        const position = editor.selection.active;
        const uri = editor.document.uri;

        // Create or reveal the Webview Panel
        if (currentPanel) {
            // If it exists, just make sure it is visible
            currentPanel.reveal(vscode.ViewColumn.Beside);
        } else {
            // If it doesn't exist, create it
            currentPanel = vscode.window.createWebviewPanel(
                'stackDeltaVisualizer',     // Internal ID for VS Code
                'StackDelta Visualizer',    // Title shown on the tab
                vscode.ViewColumn.Beside,   // Open in a split pane next to the code
                { 
                    enableScripts: true,     // Allows our injected JS to run
                    retainContextWhenHidden: true
                }
            );

            // Initialize the HTML shell immediately
            currentPanel.webview.html = getWebviewContent(context, currentPanel);

            currentPanel.webview.onDidReceiveMessage(
                async message => {
                    if (message.command === 'jumpTo') {
                        try {
                            // Parse the URI string back into a VS Code URI object
                            const uri = vscode.Uri.parse(message.fullUri);
                            
                            // Open the document in the main editor pane (ViewColumn.One)
                            const doc = await vscode.workspace.openTextDocument(uri);
                            const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
                            
                            // Move the cursor to the exact line (0-indexed again)
                            const targetLine = message.line - 1;
                            const position = new vscode.Position(targetLine, 0);
                            editor.selection = new vscode.Selection(position, position);
                            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
                        } catch (err) {
                            console.error("Failed to jump to file:", err);
                        }
                    } 
                    else if (message.command === 'searchSymbol') {
                        try {
                            // Search the entire workspace for the clicked word
                            const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                                'vscode.executeWorkspaceSymbolProvider',
                                message.symbolName
                            );

                            if (symbols && symbols.length > 0) {
                                // Prioritize exact name matches in case of fuzzy search results
                                const exactMatch = symbols.find(s => s.name === message.symbolName) || symbols[0];
                                
                                // Trigger the render engine with the discovered coordinates
                                await traceAndRender(
                                    exactMatch.location.uri, 
                                    exactMatch.location.range.start, 
                                    message.symbolName,
                                    currentPanel
                                );
                            } else {
                                vscode.window.showInformationMessage(`Could not find global definition for '${message.symbolName}'.`);
                            }
                        } catch (err) {
                            console.error("Workspace search failed:", err);
                        }
                    }
                },
                undefined,
                context.subscriptions
            );

            // Clean up the reference when the user closes the tab
            currentPanel.onDidDispose(() => {
                currentPanel = undefined;
            }, null, context.subscriptions);
        }

        // trace the symbol and render as card
        await traceAndRender(editor.document.uri, editor.selection.active, "Unknown Symbol", currentPanel);
    });

    context.subscriptions.push(disposable);
}

function getWebviewContent(context: vscode.ExtensionContext, panel: vscode.WebviewPanel) {
    // Find the absolute path to the .html file
    const htmlPath = path.join(context.extensionPath, 'media', 'inspector_webview.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    // load script path by converting it into secure webview uri
    const scriptPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'inspector_webview.js');
    const scriptUri = panel.webview.asWebviewUri(scriptPath);

    // inject into the HTML string
    html = html.replace('{{SCRIPT_URI}}', scriptUri.toString());
    
    // Read the file synchronously and return it as a string
    return html;
}

export function deactivate() {}