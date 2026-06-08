import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getConfig } from './extension';
import { FmdCompiler } from './compiler';
import { FmdProjectInfo, FmdProjectManager } from './projectManager';
import { expandArgs, expandTokens, TokenContext, ToolRunner } from './toolRunner';
import { extractRange, writeIntelHex } from './intelHex';

interface EepromGeometry {
    baseAddress: number;
    start: number;
    size: number;
    fill: number;
}

export class FmdEepromManager {
    private panel: vscode.WebviewPanel | undefined;
    private data: Uint8Array | undefined;
    private eepromFile: string | undefined;
    private geometry: EepromGeometry | undefined;
    private runner = new ToolRunner();

    constructor(
        private outputChannel: vscode.OutputChannel,
        private projectManager: FmdProjectManager,
        private compiler: FmdCompiler
    ) {}

    async openEditor(): Promise<void> {
        const state = await this.loadState();
        if (!state) {
            return;
        }

        this.data = state.data;
        this.eepromFile = state.eepromFile;
        this.geometry = state.geometry;

        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                'fmdEeprom',
                'FMD EEPROM',
                vscode.ViewColumn.One,
                { enableScripts: true }
            );
            this.panel.onDidDispose(() => this.panel = undefined);
            this.panel.webview.onDidReceiveMessage(async message => {
                if (message.command === 'save') {
                    await this.saveFromWebview(message.values || {});
                } else if (message.command === 'reload') {
                    await this.openEditor();
                } else if (message.command === 'export') {
                    await this.exportEepromHex();
                }
            });
        }

        this.panel.webview.html = this.renderWebview(state.data, state.geometry, state.labels, state.eepromFile);
        this.panel.reveal();
    }

    async exportEepromHex(): Promise<void> {
        if (!this.data || !this.geometry) {
            const state = await this.loadState();
            if (!state) {
                return;
            }
            this.data = state.data;
            this.geometry = state.geometry;
            this.eepromFile = state.eepromFile;
        }

        const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(this.eepromFile || 'eeprom.eep.hex'),
            filters: {
                'Intel HEX': ['hex', 'eep', 'eep.hex'],
                '所有文件': ['*'],
            },
        });

        if (!target) {
            return;
        }

        fs.writeFileSync(target.fsPath, writeIntelHex(this.data, this.geometry.baseAddress));
        this.eepromFile = target.fsPath;
        vscode.window.showInformationMessage(`FMD: EEPROM 已导出: ${target.fsPath}`);
    }

    async readEeprom(): Promise<void> {
        const cfg = getConfig();
        const state = await this.loadState();
        if (!state) {
            return;
        }

        if (!cfg.programmerPath || cfg.eepromReadArgs.length === 0) {
            vscode.window.showWarningMessage('FMD: 未配置 EEPROM 读取命令，请设置 fmdCompiler.programmerPath 和 fmdCompiler.eepromReadArgs');
            return;
        }

        const artifacts = await this.compiler.resolveOutputArtifacts();
        if (!artifacts) {
            return;
        }

        const context = this.createTokenContext(artifacts, state.eepromFile, state.geometry);
        const result = await this.runner.run({
            executable: cfg.programmerPath,
            args: expandArgs(cfg.eepromReadArgs, context),
            cwd: expandTokens(cfg.programmerCwd || '${projectDir}', context),
            shell: cfg.programmerUseShell,
            outputChannel: this.outputChannel,
            label: 'FMD 读取 EEPROM',
            successExitCodes: cfg.programmerSuccessExitCodes,
        });

        if (result.success) {
            vscode.window.showInformationMessage('FMD: EEPROM 读取完成 ✓');
            await this.openEditor();
        } else {
            vscode.window.showErrorMessage(`FMD: EEPROM 读取失败，退出码 ${result.exitCode}`);
        }
    }

    async writeEeprom(): Promise<void> {
        if (this.data && this.geometry && this.eepromFile) {
            fs.writeFileSync(this.eepromFile, writeIntelHex(this.data, this.geometry.baseAddress));
        }

        const cfg = getConfig();
        const state = await this.loadState();
        if (!state) {
            return;
        }

        if (!cfg.programmerPath || cfg.eepromWriteArgs.length === 0) {
            vscode.window.showWarningMessage('FMD: 未配置 EEPROM 写入命令，请设置 fmdCompiler.programmerPath 和 fmdCompiler.eepromWriteArgs');
            return;
        }

        const artifacts = await this.compiler.resolveOutputArtifacts();
        if (!artifacts) {
            return;
        }

        const context = this.createTokenContext(artifacts, state.eepromFile, state.geometry);
        const result = await this.runner.run({
            executable: cfg.programmerPath,
            args: expandArgs(cfg.eepromWriteArgs, context),
            cwd: expandTokens(cfg.programmerCwd || '${projectDir}', context),
            shell: cfg.programmerUseShell,
            outputChannel: this.outputChannel,
            label: 'FMD 写入 EEPROM',
            successExitCodes: cfg.programmerSuccessExitCodes,
        });

        if (result.success) {
            vscode.window.showInformationMessage('FMD: EEPROM 写入完成 ✓');
        } else {
            vscode.window.showErrorMessage(`FMD: EEPROM 写入失败，退出码 ${result.exitCode}`);
        }
    }

    private async saveFromWebview(values: Record<string, string>): Promise<void> {
        if (!this.data || !this.geometry || !this.eepromFile) {
            return;
        }

        for (const [key, value] of Object.entries(values)) {
            const index = parseInt(key, 10);
            const byte = parseInt(value, 16);
            if (!Number.isNaN(index) && !Number.isNaN(byte) && index >= 0 && index < this.data.length) {
                this.data[index] = byte & 0xff;
            }
        }

        fs.writeFileSync(this.eepromFile, writeIntelHex(this.data, this.geometry.baseAddress));
        vscode.window.showInformationMessage(`FMD: EEPROM 已保存: ${this.eepromFile}`);
    }

    private async loadState(): Promise<{ data: Uint8Array; geometry: EepromGeometry; labels: Map<number, string[]>; eepromFile: string } | undefined> {
        const projectInfo = this.getProjectInfo();
        const artifacts = await this.compiler.resolveOutputArtifacts();
        const projectDir = projectInfo?.projectDir || artifacts?.projectDir;
        const projectName = projectInfo?.projectName || artifacts?.projectName;

        if (!projectDir || !projectName) {
            vscode.window.showErrorMessage('FMD: 未找到工程，无法打开 EEPROM');
            return undefined;
        }

        const geometry = this.resolveGeometry(projectDir, projectName);
        const eepromFile = this.resolveEepromFile(projectDir, projectName, projectInfo);
        const data = this.loadEepromData(eepromFile, artifacts?.hexFile, geometry);
        const labels = this.loadLabels(projectInfo, projectDir);

        return { data, geometry, labels, eepromFile };
    }

    private resolveGeometry(projectDir: string, projectName: string): EepromGeometry {
        const cfg = getConfig();
        const mapFile = path.join(projectDir, projectName + '.map');
        const configured = {
            baseAddress: parseNumber(cfg.eepromBaseAddress, 0x2100),
            start: parseNumber(cfg.eepromStart, 0),
            size: cfg.eepromSize,
            fill: parseNumber(cfg.eepromFill, 0xff),
        };

        if (!fs.existsSync(mapFile)) {
            return configured;
        }

        const text = fs.readFileSync(mapFile, 'utf8');
        const m = /-AEEDATA=([0-9A-Fa-f]+)h-([0-9A-Fa-f]+)h\/([0-9A-Fa-f]+)h/.exec(text);
        if (!m) {
            return configured;
        }

        const start = parseInt(m[1], 16);
        const end = parseInt(m[2], 16);
        const baseAddress = parseInt(m[3], 16);
        return {
            baseAddress,
            start,
            size: end - start + 1,
            fill: configured.fill,
        };
    }

    private resolveEepromFile(projectDir: string, projectName: string, projectInfo?: FmdProjectInfo): string {
        const cfg = getConfig();
        if (cfg.eepromImageFile) {
            return path.isAbsolute(cfg.eepromImageFile) ? cfg.eepromImageFile : path.join(projectDir, cfg.eepromImageFile);
        }
        if (projectInfo?.eeFile) {
            return projectInfo.eeFile;
        }
        return path.join(projectDir, `${projectName}.eep.hex`);
    }

    private loadEepromData(eepromFile: string, hexFile: string | undefined, geometry: EepromGeometry): Uint8Array {
        if (fs.existsSync(eepromFile)) {
            return extractRange(fs.readFileSync(eepromFile, 'utf8'), geometry.baseAddress, geometry.size, geometry.fill);
        }

        if (hexFile && fs.existsSync(hexFile)) {
            return extractRange(fs.readFileSync(hexFile, 'utf8'), geometry.baseAddress, geometry.size, geometry.fill);
        }

        const data = new Uint8Array(geometry.size);
        data.fill(geometry.fill & 0xff);
        return data;
    }

    private loadLabels(projectInfo: FmdProjectInfo | undefined, projectDir: string): Map<number, string[]> {
        const labels = new Map<number, string[]>();
        const files = new Set<string>(projectInfo ? [...projectInfo.sourceFiles, ...projectInfo.headerFiles] : []);

        if (files.size === 0) {
            for (const file of fs.readdirSync(projectDir)) {
                if (/\.[cChH]$/.test(file)) {
                    files.add(path.join(projectDir, file));
                }
            }
        }

        for (const file of files) {
            if (!fs.existsSync(file)) {
                continue;
            }
            const text = fs.readFileSync(file, 'utf8');
            const pattern = /^\s*#\s*define\s+(eeprom_[A-Za-z0-9_]+)\s+(0x[0-9A-Fa-f]+|\d+)/gm;
            let m: RegExpExecArray | null;
            while ((m = pattern.exec(text)) !== null) {
                const address = parseNumber(m[2], -1);
                if (address >= 0) {
                    const arr = labels.get(address) || [];
                    arr.push(m[1]);
                    labels.set(address, arr);
                }
            }
        }

        return labels;
    }

    private renderWebview(data: Uint8Array, geometry: EepromGeometry, labels: Map<number, string[]>, eepromFile: string): string {
        const rows = Array.from(data).map((value, index) => {
            const logical = geometry.start + index;
            const absolute = geometry.baseAddress + index;
            const label = labels.get(logical)?.join(', ') || '';
            const ascii = value >= 32 && value <= 126 ? String.fromCharCode(value) : '.';
            return `<tr>
                <td>0x${logical.toString(16).toUpperCase().padStart(2, '0')}</td>
                <td>0x${absolute.toString(16).toUpperCase().padStart(4, '0')}</td>
                <td><input data-index="${index}" value="${value.toString(16).toUpperCase().padStart(2, '0')}" maxlength="2" /></td>
                <td>${escapeHtml(ascii)}</td>
                <td>${escapeHtml(label)}</td>
            </tr>`;
        }).join('');

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
body { font-family: var(--vscode-font-family); padding: 12px; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; text-align: left; }
input { width: 3em; font-family: monospace; }
.actions { margin: 12px 0; display: flex; gap: 8px; }
.meta { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<h2>FMD EEPROM 编辑器</h2>
<div class="meta">文件: ${escapeHtml(eepromFile)}</div>
<div class="meta">Base: 0x${geometry.baseAddress.toString(16).toUpperCase()}，Size: ${geometry.size} bytes</div>
<div class="actions">
<button id="save">保存</button>
<button id="export">导出 HEX</button>
<button id="reload">重新加载</button>
</div>
<table>
<thead><tr><th>逻辑地址</th><th>HEX 地址</th><th>值</th><th>ASCII</th><th>标签</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<script>
const vscode = acquireVsCodeApi();
document.getElementById('save').addEventListener('click', () => {
    const values = {};
    document.querySelectorAll('input[data-index]').forEach(input => values[input.dataset.index] = input.value);
    vscode.postMessage({ command: 'save', values });
});
document.getElementById('export').addEventListener('click', () => vscode.postMessage({ command: 'export' }));
document.getElementById('reload').addEventListener('click', () => vscode.postMessage({ command: 'reload' }));
document.querySelectorAll('input[data-index]').forEach(input => {
    input.addEventListener('input', () => input.value = input.value.replace(/[^0-9a-fA-F]/g, '').toUpperCase());
});
</script>
</body>
</html>`;
    }

    private createTokenContext(artifacts: { projectDir: string; projectName: string; hexFile: string; binFile: string }, eepromFile: string, geometry: EepromGeometry): TokenContext {
        const cfg = getConfig();
        return {
            chip: cfg.chip,
            projectFile: this.projectManager.getProjectFile() || cfg.projectFile,
            projectDir: artifacts.projectDir,
            projectName: artifacts.projectName,
            compilerPath: cfg.compilerPath,
            hexFile: artifacts.hexFile,
            binFile: artifacts.binFile,
            downloadFile: cfg.downloadFileType === 'bin' ? artifacts.binFile : artifacts.hexFile,
            eepromFile,
            eepromBaseAddress: `0x${geometry.baseAddress.toString(16).toUpperCase()}`,
            eepromSize: String(geometry.size),
            workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
        };
    }

    private getProjectInfo(): FmdProjectInfo | undefined {
        const cfg = getConfig();
        try {
            if (cfg.projectFile && fs.existsSync(cfg.projectFile)) {
                return this.projectManager.getProjectInfo(cfg.projectFile);
            }
            return this.projectManager.getProjectInfo();
        } catch {
            return undefined;
        }
    }
}

function parseNumber(value: string, fallback: number): number {
    const trimmed = value.trim();
    if (/^0x/i.test(trimmed)) {
        return parseInt(trimmed.slice(2), 16);
    }
    if (/^[0-9A-Fa-f]+h$/i.test(trimmed)) {
        return parseInt(trimmed.slice(0, -1), 16);
    }
    const parsed = parseInt(trimmed, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
