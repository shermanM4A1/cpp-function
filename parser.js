'use strict';

const Parser = require('web-tree-sitter');
const fs = require('fs');
const path = require('path');

// 语言 -> tree-sitter wasm 文件与函数定义节点类型
const LANG_CONFIG = {
    c:      { wasm: 'tree-sitter-c.wasm',      defs: ['function_definition'] },
    cpp:    { wasm: 'tree-sitter-cpp.wasm',    defs: ['function_definition'] },
    java:   { wasm: 'tree-sitter-java.wasm',   defs: ['method_declaration'] },
    python: { wasm: 'tree-sitter-python.wasm', defs: ['function_definition'] },
    go:     { wasm: 'tree-sitter-go.wasm',     defs: ['function_declaration', 'method_declaration'] },
    javascript: { wasm: 'tree-sitter-javascript.wasm', defs: ['function_declaration', 'method_definition'] },
    typescript: { wasm: 'tree-sitter-typescript.wasm', defs: ['function_declaration', 'method_definition'] },
    rust:   { wasm: 'tree-sitter-rust.wasm',   defs: ['function_item'] },
    c_sharp: { wasm: 'tree-sitter-c_sharp.wasm', defs: ['method_declaration'] },
    ruby:   { wasm: 'tree-sitter-ruby.wasm',   defs: ['method'] },
    php:    { wasm: 'tree-sitter-php.wasm',    defs: ['function_definition', 'method_declaration'] },
};

// 文件扩展名 -> 语言
const LANG_EXTS = {
    '.c': 'c', '.h': 'c',
    '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hh': 'cpp',
    '.java': 'java',
    '.py': 'python',
    '.go': 'go',
    '.js': 'javascript', '.jsx': 'javascript',
    '.ts': 'typescript', '.tsx': 'typescript',
    '.rs': 'rust',
    '.cs': 'c_sharp',
    '.rb': 'ruby',
    '.php': 'php',
};

/**
 * 基于 web-tree-sitter 的函数解析器。
 * 仅返回「实现」（有函数体的节点），过滤掉声明/原型。
 */
class FunctionParser {
    constructor(extensionPath) {
        this.extensionPath = extensionPath;
        this.languages = {}; // langId -> Language 缓存
    }

    async init() {
        if (!Parser.initialized) {
            await Parser.init();
        }
    }

    async getLanguage(langId) {
        if (!this.languages[langId]) {
            const cfg = LANG_CONFIG[langId];
            const wasmPath = path.join(this.extensionPath, 'node_modules', 'tree-sitter-wasms', 'out', cfg.wasm);
            const bytes = fs.readFileSync(wasmPath);
            this.languages[langId] = await Parser.Language.load(bytes);
        }
        return this.languages[langId];
    }

    /**
     * 解析源码文本，返回实现函数列表: [{ name, line, text }]
     */
    async parse(text, langId) {
        await this.init();
        const lang = await this.getLanguage(langId);
        const parser = new Parser();
        parser.setLanguage(lang);

        let tree;
        try {
            tree = parser.parse(text);
        } catch (e) {
            return [];
        }

        const cfg = LANG_CONFIG[langId];
        const funcs = [];

        const visit = (node) => {
            if (cfg.defs.includes(node.type)) {
                // 有 body 字段才视为实现（过滤掉 interface 方法、纯虚函数等声明）
                if (node.childForFieldName('body')) {
                    const name = this.findName(node, langId);
                    if (name) {
                        funcs.push({
                            name,
                            line: node.startPosition.row + 1,
                            text: this.trimText(node.text),
                        });
                    }
                }
            }
            for (const child of node.children) {
                visit(child);
            }
        };
        visit(tree.rootNode);

        // 按行号排序
        funcs.sort((a, b) => a.line - b.line);
        return funcs;
    }

    findName(node, langId) {
        // C/C++: declarator -> function_declarator -> declarator 链
        if (langId === 'c' || langId === 'cpp') {
            let cur = node.childForFieldName('declarator');
            let guard = 0;
            while (cur && guard++ < 10) {
                if (cur.type === 'identifier' || cur.type === 'field_identifier') {
                    return cur.text;
                }
                const next = cur.childForFieldName('declarator');
                if (next) { cur = next; continue; }
                const name = cur.childForFieldName('name');
                if (name) { return name.text; }
                break;
            }
            return null;
        }
        // 其余语言: name 字段
        const nameNode = node.childForFieldName('name');
        return nameNode ? nameNode.text : null;
    }

    trimText(text) {
        const oneLine = text.replace(/\s*\n\s*/g, ' ');
        return oneLine.length > 300 ? oneLine.slice(0, 300) + ' …' : oneLine;
    }
}

module.exports = { FunctionParser, LANG_CONFIG, LANG_EXTS };
