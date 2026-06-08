import * as vscode from 'vscode';
import * as path from 'path';

interface DiagEntry {
    file: string;
    line: number;
    col: number;
    severity: vscode.DiagnosticSeverity;
    message: string;
    code?: string;
}

export class FmdDiagnostics {
    private collection: vscode.DiagnosticCollection;

    constructor(collection: vscode.DiagnosticCollection) {
        this.collection = collection;
    }

    clear() {
        this.collection.clear();
    }

    /**
     * 解析编译器输出，提取错误和警告
     *
     * 支持的格式：
     * 1. GCC 风格：  file.c:12: error: xxx
     * 2. XC8 风格：  file.c:12:5: error: xxx
     * 3. Linker 风格：(1234) Error [L1234] xxx
     */
    parse(output: string) {
        const entries: DiagEntry[] = [];

        // GCC/XC8 风格错误
        // 匹配：文件路径:行号: severity: 消息
        // 或：  文件路径:行号:列号: severity: 消息
        const gccPattern = /^((?:[A-Za-z]:)?[^:]+\.[cChH]):(\d+)(?::(\d+))?:\s*(error|warning|note):\s*(.+)$/gm;

        let m: RegExpExecArray | null;
        while ((m = gccPattern.exec(output)) !== null) {
            const [, file, lineStr, colStr, sev, msg] = m;
            entries.push({
                file: this.normalizePath(file),
                line: parseInt(lineStr, 10) - 1,
                col: colStr ? parseInt(colStr, 10) - 1 : 0,
                severity: this.mapSeverity(sev),
                message: msg.trim(),
            });
        }

        // XC8 linker 错误：如 :error: (1234) xxx
        const linkerPattern = /^.*?(error|warning)\s*\[([A-Z]\d+)\]\s*(.+)$/gim;
        while ((m = linkerPattern.exec(output)) !== null) {
            const [, sev, code, msg] = m;
            // 链接器错误没有文件位置，用一个特殊处理
            entries.push({
                file: '',
                line: 0,
                col: 0,
                severity: this.mapSeverity(sev),
                message: `[${code}] ${msg.trim()}`,
                code,
            });
        }

        // 按文件分组，推送到 VSCode
        const fileMap = new Map<string, vscode.Diagnostic[]>();

        for (const entry of entries) {
            if (!entry.file) {
                continue;
            }

            const diag = new vscode.Diagnostic(
                new vscode.Range(entry.line, entry.col, entry.line, entry.col + 999),
                entry.message,
                entry.severity
            );
            if (entry.code) {
                diag.code = entry.code;
            }

            const key = entry.file;
            if (!fileMap.has(key)) {
                fileMap.set(key, []);
            }
            fileMap.get(key)!.push(diag);
        }

        for (const [filePath, diags] of fileMap) {
            const uri = vscode.Uri.file(filePath);
            this.collection.set(uri, diags);
        }
    }

    private normalizePath(filePath: string): string {
        // 确保路径分隔符统一
        return filePath.replace(/\//g, path.sep);
    }

    private mapSeverity(sev: string): vscode.DiagnosticSeverity {
        switch (sev.toLowerCase()) {
            case 'error':   return vscode.DiagnosticSeverity.Error;
            case 'warning': return vscode.DiagnosticSeverity.Warning;
            case 'note':    return vscode.DiagnosticSeverity.Information;
            default:        return vscode.DiagnosticSeverity.Error;
        }
    }
}
