import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { getConfig } from './extension';
import { FmdDiagnostics } from './diagnostics';
import { FmdProjectInfo, FmdProjectManager } from './projectManager';

export interface FmdOutputArtifacts {
    projectDir: string;
    projectName: string;
    outputDir: string;
    hexFile: string;
    binFile: string;
}

export interface FmdBuildResult {
    success: boolean;
    exitCode: number;
    artifacts?: FmdOutputArtifacts;
}

export class FmdCompiler {
    private outputChannel: vscode.OutputChannel;
    private diagnostics: FmdDiagnostics;
    private projectManager: FmdProjectManager;
    private building = false;

    constructor(
        outputChannel: vscode.OutputChannel,
        diagnostics: FmdDiagnostics,
        projectManager: FmdProjectManager
    ) {
        this.outputChannel = outputChannel;
        this.diagnostics = diagnostics;
        this.projectManager = projectManager;
    }

    reloadConfig() {
        this.outputChannel.appendLine('[FMD] 配置已更新');
    }

    /**
     * 编译整个工程（所有 .c/.C 文件 + 链接）
     */
    async buildProject(): Promise<void> {
        const result = await this.buildProjectWithResult();
        if (!result.success && result.exitCode !== -1) {
            vscode.window.showErrorMessage(`FMD: 编译失败，退出码 ${result.exitCode}，请查看输出面板`);
        }
    }

    async buildProjectWithResult(): Promise<FmdBuildResult> {
        if (this.building) {
            vscode.window.showWarningMessage('FMD: 编译正在进行中...');
            return { success: false, exitCode: -1 };
        }

        const cfg = getConfig();

        // 自动保存
        if (cfg.autoSaveBeforeBuild) {
            await vscode.workspace.saveAll(false);
        }

        const projectInfo = await this.getProjectInfo();
        const projectDir = projectInfo?.projectDir || await this.getProjectDir();
        if (!projectDir) {
            return { success: false, exitCode: -1 };
        }

        const projectName = projectInfo?.projectName || path.basename(projectDir);
        const outputDir = cfg.outputDir || projectDir;
        const artifacts = this.getOutputArtifacts(projectDir, projectName, outputDir);

        this.building = true;
        this.diagnostics.clear();

        if (cfg.showOutputOnBuild) {
            this.outputChannel.show(true);
        }

        this.outputChannel.appendLine('');
        this.outputChannel.appendLine(`========== FMD 开始编译: ${projectName} ==========`);
        this.outputChannel.appendLine(`工程目录: ${projectDir}`);
        this.outputChannel.appendLine(`芯片: ${cfg.chip}`);
        if (projectInfo?.device && projectInfo.device !== cfg.chip) {
            this.outputChannel.appendLine(`[警告] 配置芯片 ${cfg.chip} 与工程文件 Device ${projectInfo.device} 不一致，本次编译使用配置芯片 ${cfg.chip}`);
        }
        this.outputChannel.appendLine(new Date().toLocaleString());
        this.outputChannel.appendLine('');

        try {
            const cFiles = this.getSourceFiles(projectDir, projectInfo);

            if (cFiles.length === 0) {
                vscode.window.showErrorMessage('工程目录中没有找到 .c/.C 文件');
                return { success: false, exitCode: -1, artifacts };
            }

            this.outputChannel.appendLine(`源文件 (${cFiles.length} 个):`);
            cFiles.forEach(f => this.outputChannel.appendLine(`  ${path.basename(f)}`));
            this.outputChannel.appendLine('');

            // 构建编译命令
            // c.exe 是 XC8-like 驱动，可以接受多文件一次编译+链接
            const args = this.buildCompileArgs(cFiles, projectDir, outputDir, projectName, cfg);

            this.outputChannel.appendLine('编译命令:');
            this.outputChannel.appendLine(`  ${cfg.compilerPath} ${args.join(' ')}`);
            this.outputChannel.appendLine('');

            const exitCode = await this.runCompiler(cfg.compilerPath, args, projectDir);

            if (exitCode === 0) {
                this.outputChannel.appendLine('');
                this.outputChannel.appendLine('========== 编译成功 ==========');

                this.logArtifact(artifacts.hexFile);
                this.logArtifact(artifacts.binFile);

                vscode.window.showInformationMessage('FMD: 编译成功 ✓');
                return { success: true, exitCode, artifacts };
            }

            this.outputChannel.appendLine('');
            this.outputChannel.appendLine(`========== 编译失败 (退出码: ${exitCode}) ==========`);
            return { success: false, exitCode, artifacts };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.outputChannel.appendLine(`[错误] ${msg}`);
            vscode.window.showErrorMessage(`FMD 编译异常: ${msg}`);
            return { success: false, exitCode: -1, artifacts };
        } finally {
            this.building = false;
        }
    }

    /**
     * 仅编译单个 .c 文件（生成 .obj，不链接）
     */
    async buildFile(filePath: string): Promise<void> {
        if (this.building) {
            vscode.window.showWarningMessage('FMD: 编译正在进行中...');
            return;
        }

        const cfg = getConfig();
        if (cfg.autoSaveBeforeBuild) {
            await vscode.workspace.saveAll(false);
        }

        const projectDir = path.dirname(filePath);
        const fileName = path.basename(filePath);

        this.building = true;
        this.diagnostics.clear();

        if (cfg.showOutputOnBuild) {
            this.outputChannel.show(true);
        }

        this.outputChannel.appendLine('');
        this.outputChannel.appendLine(`========== FMD 编译文件: ${fileName} ==========`);

        try {
            // 单文件编译：只预处理+编译到 .obj，不链接
            const args = [
                `--chip=${cfg.chip}`,
                '-Q',        // 静默链接器
                '-P',        // 仅编译，不链接（生成 .p1 和 .obj）
                `-I${path.join(path.dirname(cfg.compilerPath), '..', 'include')}`,
                filePath,
            ];

            if (cfg.extraArgs) {
                args.push(...cfg.extraArgs.split(' ').filter(a => a));
            }

            this.outputChannel.appendLine(`命令: ${cfg.compilerPath} ${args.join(' ')}`);

            const exitCode = await this.runCompiler(cfg.compilerPath, args, projectDir);

            if (exitCode === 0) {
                this.outputChannel.appendLine('单文件编译成功');
                vscode.window.showInformationMessage(`FMD: ${fileName} 编译成功 ✓`);
            } else {
                vscode.window.showErrorMessage(`FMD: ${fileName} 编译失败`);
            }
        } finally {
            this.building = false;
        }
    }

    /**
     * 清理编译产物
     */
    async cleanProject(): Promise<void> {
        const projectDir = await this.getProjectDir();
        if (!projectDir) {
            return;
        }

        const cleanExts = ['.obj', '.p1', '.pre', '.d', '.lpp', '.cmf', '.sym', '.map', '.rlf', '.sdb', '.asm'];
        let count = 0;

        try {
            const files = fs.readdirSync(projectDir);
            for (const f of files) {
                const ext = path.extname(f).toLowerCase();
                if (cleanExts.includes(ext)) {
                    fs.unlinkSync(path.join(projectDir, f));
                    count++;
                }
            }
            this.outputChannel.appendLine(`[FMD] 清理完成，删除 ${count} 个中间文件`);
            vscode.window.showInformationMessage(`FMD: 清理完成，删除 ${count} 个中间文件`);
        } catch (err) {
            vscode.window.showErrorMessage(`FMD 清理失败: ${err}`);
        }
    }

    async resolveOutputArtifacts(): Promise<FmdOutputArtifacts | undefined> {
        const cfg = getConfig();
        const projectInfo = await this.getProjectInfo();
        const projectDir = projectInfo?.projectDir || await this.getProjectDir();
        if (!projectDir) {
            return undefined;
        }

        const projectName = projectInfo?.projectName || path.basename(projectDir);
        const outputDir = cfg.outputDir || projectDir;
        return this.getOutputArtifacts(projectDir, projectName, outputDir);
    }

    getOutputArtifacts(projectDir: string, projectName: string, outputDir: string): FmdOutputArtifacts {
        return {
            projectDir,
            projectName,
            outputDir,
            hexFile: path.join(outputDir, projectName + '.hex'),
            binFile: path.join(outputDir, projectName + '.bin'),
        };
    }

    /**
     * 构造编译参数
     * 基于对 .map 文件的分析，c.exe 是 XC8-style 驱动器
     * 标准调用：c.exe --chip=CHIP [options] file1.c file2.c ...
     */
    private buildCompileArgs(
        cFiles: string[],
        projectDir: string,
        outputDir: string,
        projectName: string,
        cfg: ReturnType<typeof getConfig>
    ): string[] {
        const compilerBinDir = path.dirname(cfg.compilerPath);
        const compilerDataDir = path.dirname(compilerBinDir); // data/
        const includeDir = path.join(compilerDataDir, 'include');

        const args: string[] = [
            `--chip=${cfg.chip}`,
            `-I${includeDir}`,
            `-o${path.join(outputDir, projectName + '.hex')}`,
        ];

        // 额外参数
        if (cfg.extraArgs) {
            args.push(...cfg.extraArgs.split(' ').filter(a => a));
        }

        // 源文件
        args.push(...cFiles);

        return args;
    }

    /**
     * 执行编译器，实时输出日志
     */
    private runCompiler(
        compilerPath: string,
        args: string[],
        cwd: string
    ): Promise<number> {
        return new Promise((resolve, reject) => {
            // 检查编译器是否存在
            if (!fs.existsSync(compilerPath)) {
                reject(new Error(`编译器不存在: ${compilerPath}\n请检查 fmdCompiler.compilerPath 配置`));
                return;
            }

            const proc = spawn(compilerPath, args, {
                cwd,
                shell: false,
                env: { ...process.env },
            });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data: Buffer) => {
                const text = data.toString();
                stdout += text;
                // 实时输出，逐行过滤空行
                text.split('\n').forEach(line => {
                    if (line.trim()) {
                        this.outputChannel.appendLine(line.replace(/\r$/, ''));
                    }
                });
            });

            proc.stderr.on('data', (data: Buffer) => {
                const text = data.toString();
                stderr += text;
                text.split('\n').forEach(line => {
                    if (line.trim()) {
                        this.outputChannel.appendLine(line.replace(/\r$/, ''));
                    }
                });
            });

            proc.on('close', (code: number | null) => {
                const allOutput = stdout + stderr;
                // 解析错误/警告，推送到诊断
                this.diagnostics.parse(allOutput);
                resolve(code ?? 1);
            });

            proc.on('error', (err: Error) => {
                reject(err);
            });
        });
    }

    /**
     * 获取工程目录
     */
    private async getProjectDir(): Promise<string | undefined> {
        const cfg = getConfig();

        // 优先用配置指定的 .prj 文件目录
        if (cfg.projectFile && fs.existsSync(cfg.projectFile)) {
            return path.dirname(cfg.projectFile);
        }

        // 其次用 ProjectManager 自动检测到的
        const detected = this.projectManager.getProjectDir();
        if (detected) {
            return detected;
        }

        // 最后用当前打开的文件目录
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            return path.dirname(editor.document.fileName);
        }

        vscode.window.showErrorMessage('FMD: 未找到工程目录，请打开 .c 文件或配置 fmdCompiler.projectFile');
        return undefined;
    }

    private async getProjectInfo(): Promise<FmdProjectInfo | undefined> {
        const cfg = getConfig();
        try {
            if (cfg.projectFile && fs.existsSync(cfg.projectFile)) {
                return this.projectManager.getProjectInfo(cfg.projectFile);
            }
            return this.projectManager.getProjectInfo();
        } catch (err) {
            this.outputChannel.appendLine(`[警告] 读取工程文件失败: ${err}`);
            return undefined;
        }
    }

    private getSourceFiles(projectDir: string, projectInfo?: FmdProjectInfo): string[] {
        const projectSources = projectInfo?.sourceFiles
            .filter(f => /\.[cC]$/.test(f) && fs.existsSync(f));

        if (projectSources && projectSources.length > 0) {
            return this.sortSourceFiles(projectSources);
        }

        // 收集所有 .c/.C 文件
        return this.sortSourceFiles(fs.readdirSync(projectDir)
            .filter(f => /\.[cC]$/.test(f))
            .map(f => path.join(projectDir, f)));
    }

    private sortSourceFiles(files: string[]): string[] {
        // 这个 8 位 MCU 编译器对多源文件顺序较敏感。历史 IDE 输出中源文件按文件名稳定排序，
        // 例如 1028.c 在 2288_test.C 前；保持该顺序可避免部分工程触发工具链内部错误。
        return [...files].sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, {
            numeric: false,
            sensitivity: 'base',
        }));
    }

    private logArtifact(filePath: string): void {
        if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            this.outputChannel.appendLine(`输出: ${filePath} (${stat.size} 字节)`);
        }
    }
}
