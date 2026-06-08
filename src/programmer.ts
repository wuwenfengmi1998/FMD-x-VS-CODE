import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getConfig } from './extension';
import { FmdCompiler, FmdOutputArtifacts } from './compiler';
import { FmdProjectManager } from './projectManager';
import { expandArgs, expandTokens, parseCommandLine, TokenContext, ToolRunner } from './toolRunner';

export class FmdProgrammer {
    private runner = new ToolRunner();

    constructor(
        private outputChannel: vscode.OutputChannel,
        private projectManager: FmdProjectManager,
        private compiler: FmdCompiler
    ) {}

    async configureProgrammer(): Promise<void> {
        const cfg = getConfig();
        const files = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: '选择烧录/下载工具',
            defaultUri: cfg.programmerPath ? vscode.Uri.file(path.dirname(cfg.programmerPath)) : undefined,
            filters: {
                '可执行文件': ['exe', 'bat', 'cmd'],
                '所有文件': ['*'],
            },
        });

        if (!files || files.length === 0) {
            return;
        }

        const programmerPath = files[0].fsPath;
        await vscode.workspace.getConfiguration('fmdCompiler').update('programmerPath', programmerPath, vscode.ConfigurationTarget.Workspace);

        const argText = await vscode.window.showInputBox({
            title: '烧录工具参数',
            prompt: '可使用 ${chip}、${hexFile}、${binFile}、${downloadFile} 等变量',
            value: cfg.programmerArgs.join(' '),
            placeHolder: '--chip ${chip} --file ${hexFile} --program',
        });

        if (argText !== undefined) {
            await vscode.workspace.getConfiguration('fmdCompiler').update('programmerArgs', parseCommandLine(argText), vscode.ConfigurationTarget.Workspace);
        }

        vscode.window.showInformationMessage('FMD: 烧录工具配置已保存');
    }

    async buildAndDownload(): Promise<void> {
        const result = await this.compiler.buildProjectWithResult();
        if (!result.success) {
            vscode.window.showErrorMessage('FMD: 编译失败，已取消下载');
            return;
        }

        await this.download(result.artifacts);
    }

    async download(artifacts?: FmdOutputArtifacts): Promise<void> {
        const cfg = getConfig();
        const resolvedArtifacts = artifacts || await this.compiler.resolveOutputArtifacts();
        if (!resolvedArtifacts) {
            return;
        }

        if (!cfg.programmerPath) {
            vscode.window.showWarningMessage('FMD: 未配置烧录工具路径，请先运行 “FMD: Configure Programmer”');
            return;
        }

        if (cfg.programmerArgs.length === 0) {
            vscode.window.showWarningMessage('FMD: 未配置烧录工具参数，请先运行 “FMD: Configure Programmer”');
            return;
        }

        const downloadFile = cfg.downloadFileType === 'bin' ? resolvedArtifacts.binFile : resolvedArtifacts.hexFile;
        if (!fs.existsSync(downloadFile)) {
            vscode.window.showErrorMessage(`FMD: 未找到下载文件: ${downloadFile}，请先编译工程`);
            return;
        }

        if (cfg.showOutputOnDownload) {
            this.outputChannel.show(true);
        }

        const context = this.createTokenContext(resolvedArtifacts, downloadFile);
        const cwd = expandTokens(cfg.programmerCwd || '${projectDir}', context);
        const args = expandArgs(cfg.programmerArgs, context);

        try {
            const result = await this.runner.run({
                executable: cfg.programmerPath,
                args,
                cwd,
                shell: cfg.programmerUseShell,
                outputChannel: this.outputChannel,
                label: 'FMD 下载程序',
                successExitCodes: cfg.programmerSuccessExitCodes,
            });

            if (result.success) {
                vscode.window.showInformationMessage('FMD: 下载完成 ✓');
            } else {
                vscode.window.showErrorMessage(`FMD: 下载失败，退出码 ${result.exitCode}`);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.outputChannel.appendLine(`[错误] ${msg}`);
            vscode.window.showErrorMessage(`FMD 下载异常: ${msg}`);
        }
    }

    createTokenContext(artifacts: FmdOutputArtifacts, downloadFile?: string): TokenContext {
        const cfg = getConfig();
        const projectFile = this.projectManager.getProjectFile() || cfg.projectFile;
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

        return {
            chip: cfg.chip,
            projectFile,
            projectDir: artifacts.projectDir,
            projectName: artifacts.projectName,
            compilerPath: cfg.compilerPath,
            hexFile: artifacts.hexFile,
            binFile: artifacts.binFile,
            downloadFile: downloadFile || (cfg.downloadFileType === 'bin' ? artifacts.binFile : artifacts.hexFile),
            workspaceFolder,
        };
    }
}
