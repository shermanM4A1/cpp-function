'use strict';

const vscode = require('vscode');
const path = require('path');
const { FunctionParser, LANG_EXTS } = require('./parser');

const STARRED_KEY = 'funcstar.starred';
const MAX_FILES = 3000;
const SKIP_DIRS = new Set([
    'node_modules', '.git', '.svn', '.hg', '.idea', '.vscode',
    'build', 'dist', 'out', 'binarylibs', 'third_party', '.vs',
]);

let functionsProvider = null; // 函数列表视图 provider
let starredProvider = null;   // 星标函数视图 provider

// ==================== Tree Items ====================

class FunctionItem extends vscode.TreeItem {
    constructor(fileUri, func) {
        super(func.name, vscode.TreeItemCollapsibleState.None);
        this.fileUri = fileUri;
        this.func = func;
        this.description = `L${func.line}`;
        this.tooltip = func.text;
        this.iconPath = new vscode.ThemeIcon('symbol-function');
        this.contextValue = 'funcItem';
        this.command = {
            command: 'funcstar.jump',
            title: '跳转到函数',
            arguments: [fileUri, func.line],
        };
    }
}

class FileGroupItem extends vscode.TreeItem {
    constructor(fileUri, funcs) {
        const label = path.basename(fileUri.fsPath);
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.fileUri = fileUri;
        this.funcs = funcs;
        this.description = `${funcs.length} 个函数`;
        this.tooltip = fileUri.fsPath;
        this.iconPath = new vscode.ThemeIcon('file-code');
        this.contextValue = 'fileGroup';
    }
}

class StarredItem extends vscode.TreeItem {
    constructor(fileUri, func) {
        super(func.name, vscode.TreeItemCollapsibleState.None);
        this.fileUri = fileUri;
        this.func = func;
        this.description = `L${func.line}`;
        this.tooltip = func.text;
        this.iconPath = new vscode.ThemeIcon('star-full');
        this.contextValue = 'starredItem';
        this.command = {
            command: 'funcstar.jump',
            title: '跳转到函数',
            arguments: [fileUri, func.line],
        };
    }
}

// ==================== Tree Data Providers ====================

class FunctionsProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.scannedFiles = []; // [{ fileUri, funcs }]
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    setScanned(files) {
        this.scannedFiles = files;
        this.refresh();
    }

    getChildren(element) {
        if (!element) {
            if (this.scannedFiles.length === 0) {
                return [new vscode.TreeItem('未扫描：右键文件/文件夹或点击上方按钮', vscode.TreeItemCollapsibleState.None)];
            }
            return this.scannedFiles.map(f => new FileGroupItem(f.fileUri, f.funcs));
        }
        if (element instanceof FileGroupItem) {
            return element.funcs.map(f => new FunctionItem(element.fileUri, f));
        }
        return [];
    }

    getTreeItem(element) {
        return element;
    }
}

class StarredProvider {
    constructor(context) {
        this.context = context;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    getChildren(element) {
        if (!element) {
            // 根级：按文件分组展示星标函数
            const stars = loadStars(this.context);
            if (stars.length === 0) {
                const empty = new vscode.TreeItem('暂无星标函数：在函数列表中点击星标收藏', vscode.TreeItemCollapsibleState.None);
                empty.iconPath = new vscode.ThemeIcon('star-empty');
                return [empty];
            }
            const byFile = {};
            for (const s of stars) {
                if (!byFile[s.uri]) byFile[s.uri] = [];
                byFile[s.uri].push(s);
            }
            return Object.keys(byFile).map(uri => {
                const fileUri = vscode.Uri.file(uri);
                return new FileGroupItem(fileUri, byFile[uri]);
            });
        }
        if (element instanceof FileGroupItem) {
            return element.funcs.map(f => new StarredItem(element.fileUri, f));
        }
        return [];
    }

    getTreeItem(element) {
        return element;
    }
}

// ==================== 星标持久化 ====================

function loadStars(context) {
    return context.workspaceState.get(STARRED_KEY, []);
}

async function saveStars(context, stars) {
    await context.workspaceState.update(STARRED_KEY, stars);
}

// ==================== 扫描与解析 ====================

async function collectFiles(uri, out) {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type === vscode.FileType.File) {
        out.push(uri);
        return;
    }
    if (stat.type !== vscode.FileType.Directory) {
        return;
    }
    const entries = await vscode.workspace.fs.readDirectory(uri);
    for (const [name, type] of entries) {
        if (out.length >= MAX_FILES) return;
        if (type === vscode.FileType.Directory) {
            if (SKIP_DIRS.has(name)) continue;
            await collectFiles(vscode.Uri.joinPath(uri, name), out);
        } else if (type === vscode.FileType.File) {
            const ext = path.extname(name).toLowerCase();
            if (LANG_EXTS[ext]) out.push(vscode.Uri.joinPath(uri, name));
        }
    }
}

async function parseFile(parser, uri) {
    const ext = path.extname(uri.fsPath).toLowerCase();
    const langId = LANG_EXTS[ext];
    if (!langId) return null;
    const bytes = await vscode.workspace.fs.readFile(uri);
    // 跳过二进制文件
    if (bytes.length > 2 * 1024 * 1024 || bytes.includes(0)) return null;
    const text = Buffer.from(bytes).toString('utf8');
    const funcs = await parser.parse(text, langId);
    if (funcs.length === 0) return null;
    return { fileUri: uri, funcs };
}

async function scanTarget(uri, parser, context) {
    const stat = await vscode.workspace.fs.stat(uri);
    let files = [];
    if (stat.type === vscode.FileType.Directory) {
        await collectFiles(uri, files);
    } else if (stat.type === vscode.FileType.File) {
        files.push(uri);
    } else {
        return;
    }

    const supported = files.filter(f => LANG_EXTS[path.extname(f.fsPath).toLowerCase()]);
    if (supported.length === 0) {
        vscode.window.showWarningMessage('所选路径中没有受支持的语言文件');
        return;
    }
    if (supported.length >= MAX_FILES) {
        vscode.window.showWarningMessage(`文件数超过 ${MAX_FILES}，仅扫描前 ${MAX_FILES} 个`);
    }

    vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `FuncStar: 正在解析 ${supported.length} 个文件…` },
        async () => {
            const results = [];
            const poolSize = 8;
            for (let i = 0; i < supported.length; i += poolSize) {
                const batch = supported.slice(i, i + poolSize);
                const parsed = await Promise.all(batch.map(f => parseFile(parser, f)));
                for (const r of parsed) {
                    if (r) results.push(r);
                }
            }
            results.sort((a, b) => a.fileUri.fsPath.localeCompare(b.fileUri.fsPath));
            functionsProvider.setScanned(results);
            const total = results.reduce((s, r) => s + r.funcs.length, 0);
            vscode.window.showInformationMessage(`FuncStar: 扫描完成，${results.length} 个文件，共 ${total} 个函数实现`);
        }
    );
}

// ==================== 跳转 ====================

async function jumpToFunction(uri, line) {
    try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, { preview: true });
        const pos = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    } catch (e) {
        vscode.window.showErrorMessage(`无法打开文件: ${e.message}`);
    }
}

// ==================== 星标操作 ====================

function findInStars(stars, uri, line) {
    return stars.find(s => s.uri === uri.fsPath && s.line === line);
}

async function starFunction(context, uri, func) {
    const stars = loadStars(context);
    if (findInStars(stars, uri, func.line)) return;
    stars.push({ uri: uri.fsPath, name: func.name, line: func.line, text: func.text });
    await saveStars(context, stars);
    starredProvider.refresh();
    vscode.window.showInformationMessage(`已星标: ${func.name} @ L${func.line}`);
}

async function unstarFunction(context, uri, func) {
    let stars = loadStars(context);
    const idx = stars.findIndex(s => s.uri === uri.fsPath && s.line === func.line);
    if (idx >= 0) {
        stars = stars.slice(0, idx).concat(stars.slice(idx + 1));
        await saveStars(context, stars);
        starredProvider.refresh();
        vscode.window.showInformationMessage(`已取消星标: ${func.name}`);
    }
}

// ==================== 激活 ====================

function activate(context) {
    functionsProvider = new FunctionsProvider();
    starredProvider = new StarredProvider(context);

    const parser = new FunctionParser(context.extensionPath);

    // 注册视图
    vscode.window.registerTreeDataProvider('funcstar.functions', functionsProvider);
    vscode.window.registerTreeDataProvider('funcstar.starred', starredProvider);

    // 扫描当前文件
    const scanCurrent = vscode.commands.registerCommand('funcstar.scanCurrent', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('没有活动的编辑器');
            return;
        }
        await scanTarget(editor.document.uri, parser, context);
    });

    // 选择文件/文件夹扫描
    const scanPick = vscode.commands.registerCommand('funcstar.scan', async () => {
        const options = {
            canSelectFiles: true,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: '选择要扫描的文件/文件夹',
        };
        const picked = await vscode.window.showOpenDialog(options);
        if (picked && picked.length > 0) {
            await scanTarget(picked[0], parser, context);
        }
    });

    // 从资源管理器右键扫描
    const scanSelection = vscode.commands.registerCommand('funcstar.scanSelection', async (uri) => {
        if (!uri) return;
        await scanTarget(uri, parser, context);
    });

    // 星标
    const star = vscode.commands.registerCommand('funcstar.star', async (item) => {
        if (item && item.fileUri && item.func) {
            await starFunction(context, item.fileUri, item.func);
        }
    });

    // 取消星标
    const unstar = vscode.commands.registerCommand('funcstar.unstar', async (item) => {
        if (item && item.fileUri && item.func) {
            await unstarFunction(context, item.fileUri, item.func);
        }
    });

    // 跳转
    const jump = vscode.commands.registerCommand('funcstar.jump', async (uri, line) => {
        await jumpToFunction(uri, line);
    });

    // 清空星标
    const clear = vscode.commands.registerCommand('funcstar.clearStars', async () => {
        const stars = loadStars(context);
        if (stars.length === 0) {
            vscode.window.showInformationMessage('没有星标函数');
            return;
        }
        const answer = await vscode.window.showWarningMessage(
            `确定清空全部 ${stars.length} 个星标函数？`,
            { modal: true },
            '清空'
        );
        if (answer === '清空') {
            await saveStars(context, []);
            starredProvider.refresh();
        }
    });

    context.subscriptions.push(
        functionsProvider, starredProvider,
        scanCurrent, scanPick, scanSelection, star, unstar, jump, clear
    );
}

function deactivate() {}

module.exports = { activate, deactivate };
