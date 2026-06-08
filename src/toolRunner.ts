import * as vscode from 'vscode';
import * as fs from 'fs';
import { spawn } from 'child_process';

export interface ToolRunOptions {
    executable: string;
    args: string[];
    cwd: string;
    shell?: boolean;
    outputChannel: vscode.OutputChannel;
    label: string;
    successExitCodes?: number[];
}

export interface ToolRunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    success: boolean;
}

export type TokenContext = Record<string, string | undefined>;

export function expandTokens(input: string, context: TokenContext): string {
    return input.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, key) => context[key] ?? match);
}

export function expandArgs(args: string[], context: TokenContext): string[] {
    return args.map(arg => expandTokens(arg, context));
}

export function parseCommandLine(input: string): string[] {
    const args: string[] = [];
    let current = '';
    let quote: string | undefined;
    let escaped = false;

    for (const ch of input) {
        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }

        if (ch === '\\') {
            escaped = true;
            continue;
        }

        if (quote) {
            if (ch === quote) {
                quote = undefined;
            } else {
                current += ch;
            }
            continue;
        }

        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }

        if (/\s/.test(ch)) {
            if (current.length > 0) {
                args.push(current);
                current = '';
            }
            continue;
        }

        current += ch;
    }

    if (escaped) {
        current += '\\';
    }
    if (current.length > 0) {
        args.push(current);
    }

    return args;
}

export class ToolRunner {
    async run(options: ToolRunOptions): Promise<ToolRunResult> {
        const successExitCodes = options.successExitCodes || [0];

        if (!options.shell && !fs.existsSync(options.executable)) {
            throw new Error(`工具不存在: ${options.executable}`);
        }

        options.outputChannel.appendLine('');
        options.outputChannel.appendLine(`========== ${options.label} ==========`);
        options.outputChannel.appendLine(`工作目录: ${options.cwd}`);
        options.outputChannel.appendLine(`命令: ${options.executable} ${options.args.join(' ')}`);
        options.outputChannel.appendLine('');

        return new Promise((resolve, reject) => {
            const proc = spawn(options.executable, options.args, {
                cwd: options.cwd,
                shell: options.shell || false,
                env: { ...process.env },
            });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data: Buffer) => {
                const text = data.toString();
                stdout += text;
                this.writeLines(options.outputChannel, text);
            });

            proc.stderr.on('data', (data: Buffer) => {
                const text = data.toString();
                stderr += text;
                this.writeLines(options.outputChannel, text);
            });

            proc.on('close', (code: number | null) => {
                const exitCode = code ?? 1;
                const success = successExitCodes.includes(exitCode);
                options.outputChannel.appendLine('');
                options.outputChannel.appendLine(`========== ${options.label}${success ? '成功' : '失败'} (退出码: ${exitCode}) ==========`);
                resolve({ exitCode, stdout, stderr, success });
            });

            proc.on('error', (err: Error) => reject(err));
        });
    }

    private writeLines(outputChannel: vscode.OutputChannel, text: string): void {
        text.split('\n').forEach(line => {
            if (line.trim()) {
                outputChannel.appendLine(line.replace(/\r$/, ''));
            }
        });
    }
}
