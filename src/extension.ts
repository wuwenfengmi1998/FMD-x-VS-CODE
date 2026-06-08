import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { FmdCompiler } from './compiler';
import { FmdDiagnostics } from './diagnostics';
import { FmdProjectManager } from './projectManager';
import { FmdProgrammer } from './programmer';
import { FmdEepromManager } from './eepromManager';

let outputChannel: vscode.OutputChannel;
let diagnosticsCollection: vscode.DiagnosticCollection;
let compiler: FmdCompiler;
let diagnostics: FmdDiagnostics;
let projectManager: FmdProjectManager;
let programmer: FmdProgrammer;
let eepromManager: FmdEepromManager;

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('FMD Compiler');
    diagnosticsCollection = vscode.languages.createDiagnosticCollection('fmd');
    diagnostics = new FmdDiagnostics(diagnosticsCollection);
    projectManager = new FmdProjectManager();
    compiler = new FmdCompiler(outputChannel, diagnostics, projectManager);
    programmer = new FmdProgrammer(outputChannel, projectManager, compiler);
    eepromManager = new FmdEepromManager(outputChannel, projectManager, compiler);

    // 注册命令
    context.subscriptions.push(
        vscode.commands.registerCommand('fmdCompiler.build', () => compiler.buildProject()),
        vscode.commands.registerCommand('fmdCompiler.buildFile', (uri?: vscode.Uri) => {
            const filePath = uri?.fsPath || vscode.window.activeTextEditor?.document.fileName;
            if (filePath) {
                compiler.buildFile(filePath);
            } else {
                vscode.window.showWarningMessage('没有可编译的文件');
            }
        }),
        vscode.commands.registerCommand('fmdCompiler.clean', () => compiler.cleanProject()),
        vscode.commands.registerCommand('fmdCompiler.selectProject', (uri?: vscode.Uri) => {
            if (uri) {
                projectManager.setProjectFile(uri.fsPath);
                vscode.window.showInformationMessage(`已选择工程: ${path.basename(uri.fsPath)}`);
            } else {
                projectManager.pickProjectFile();
            }
            updateStatusBars();
        }),
        vscode.commands.registerCommand('fmdCompiler.openOutput', () => {
            outputChannel.show();
        }),
        vscode.commands.registerCommand('fmdCompiler.setCompilerPath', () => setCompilerPath()),
        vscode.commands.registerCommand('fmdCompiler.detectCompilerPath', () => detectCompilerPath()),
        vscode.commands.registerCommand('fmdCompiler.selectChip', () => selectChip()),
        vscode.commands.registerCommand('fmdCompiler.syncChipFromProject', () => syncChipFromProject()),
        vscode.commands.registerCommand('fmdCompiler.configureProgrammer', () => programmer.configureProgrammer()),
        vscode.commands.registerCommand('fmdCompiler.download', () => programmer.download()),
        vscode.commands.registerCommand('fmdCompiler.buildAndDownload', () => programmer.buildAndDownload()),
        vscode.commands.registerCommand('fmdCompiler.openEeprom', () => eepromManager.openEditor()),
        vscode.commands.registerCommand('fmdCompiler.readEeprom', () => eepromManager.readEeprom()),
        vscode.commands.registerCommand('fmdCompiler.writeEeprom', () => eepromManager.writeEeprom()),
        vscode.commands.registerCommand('fmdCompiler.exportEepromHex', () => eepromManager.exportEepromHex()),
        diagnosticsCollection
    );

    // 状态栏
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'fmdCompiler.build';
    const chipStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    chipStatusBar.command = 'fmdCompiler.selectChip';
    const downloadStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    downloadStatusBar.command = 'fmdCompiler.download';

    const update = () => {
        const cfg = getConfig();
        const projectFile = projectManager.getProjectFile() || cfg.projectFile;
        statusBar.text = '$(play) FMD Build';
        statusBar.tooltip = projectFile ? `编译 FMD 工程: ${projectFile}` : '编译 FMD 工程 (F7)';
        chipStatusBar.text = `$(circuit-board) ${cfg.chip}`;
        chipStatusBar.tooltip = '切换 FMD 目标芯片';
        downloadStatusBar.text = '$(cloud-upload) FMD Download';
        downloadStatusBar.tooltip = cfg.programmerPath ? `下载程序: ${cfg.programmerPath}` : '未配置烧录工具，点击配置后可下载';
        statusBar.show();
        chipStatusBar.show();
        downloadStatusBar.show();
    };
    updateStatusBars = update;
    updateStatusBars();
    context.subscriptions.push(statusBar, chipStatusBar, downloadStatusBar);

    // 监听配置变化
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('fmdCompiler')) {
                compiler.reloadConfig();
                updateStatusBars();
            }
        })
    );

    // 尝试自动找工程文件
    projectManager.autoDetectProject();
    updateStatusBars();

    outputChannel.appendLine('[FMD] 插件已激活');
    outputChannel.appendLine(`[FMD] 编译器: ${getConfig().compilerPath}`);
}

export function deactivate() {
    diagnosticsCollection?.dispose();
    outputChannel?.dispose();
}

let updateStatusBars = () => {};

async function setCompilerPath(): Promise<void> {
    const cfg = getConfig();
    const files = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: '选择 FMD 编译器 c.exe',
        defaultUri: cfg.compilerPath ? vscode.Uri.file(path.dirname(cfg.compilerPath)) : undefined,
        filters: {
            'Compiler': ['exe'],
            '所有文件': ['*'],
        },
    });

    if (!files || files.length === 0) {
        return;
    }

    await vscode.workspace.getConfiguration('fmdCompiler').update('compilerPath', files[0].fsPath, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage(`FMD: 编译器路径已设置: ${files[0].fsPath}`);
}

async function detectCompilerPath(): Promise<void> {
    const cfg = getConfig();
    const candidates = Array.from(new Set([
        ...cfg.compilerSearchPaths,
        'C:\\Program Files (x86)\\CCompiler\\Compiler\\data\\bin\\c.exe',
        'C:\\Program Files\\CCompiler\\Compiler\\data\\bin\\c.exe',
    ]));
    const found = candidates.find(file => fs.existsSync(file));

    if (!found) {
        vscode.window.showWarningMessage('FMD: 未自动找到编译器，请手动选择');
        await setCompilerPath();
        return;
    }

    const answer = await vscode.window.showInformationMessage(`找到 FMD 编译器: ${found}`, '使用此路径', '取消');
    if (answer === '使用此路径') {
        await vscode.workspace.getConfiguration('fmdCompiler').update('compilerPath', found, vscode.ConfigurationTarget.Workspace);
    }
}

async function selectChip(): Promise<void> {
    const cfg = getConfig();
    const chips = collectChipCandidates();
    const selected = await vscode.window.showQuickPick(chips, {
        title: '选择 FMD 目标芯片',
        placeHolder: cfg.chip,
    });

    if (!selected) {
        return;
    }

    await vscode.workspace.getConfiguration('fmdCompiler').update('chip', selected, vscode.ConfigurationTarget.Workspace);
    outputChannel.appendLine(`[FMD] 已切换芯片: ${selected}`);

    const projectFile = projectManager.getProjectFile() || cfg.projectFile;
    if (projectFile && fs.existsSync(projectFile)) {
        const answer = await vscode.window.showInformationMessage(`是否同步修改工程文件 Device 为 ${selected}?`, '同步', '仅修改 VS Code 设置');
        if (answer === '同步') {
            await projectManager.updateProjectDevice(projectFile, selected);
            vscode.window.showInformationMessage(`FMD: 已更新工程芯片: ${selected}`);
        }
    }

    updateStatusBars();
}

async function syncChipFromProject(): Promise<void> {
    const projectChip = projectManager.getCurrentChip(getConfig().projectFile);
    if (!projectChip) {
        vscode.window.showWarningMessage('FMD: 当前工程文件中没有找到 Device 字段');
        return;
    }

    await vscode.workspace.getConfiguration('fmdCompiler').update('chip', projectChip, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage(`FMD: 已从工程同步芯片: ${projectChip}`);
}

function collectChipCandidates(): string[] {
    const cfg = getConfig();
    const chips = new Set<string>(['FT61FC6X', cfg.chip]);
    const projectChip = projectManager.getCurrentChip(cfg.projectFile);
    if (projectChip) {
        chips.add(projectChip);
    }

    const includeDir = path.join(path.dirname(cfg.compilerPath), '..', 'include');
    try {
        for (const file of fs.readdirSync(includeDir)) {
            const m = /([A-Z]{2}\d+[A-Z0-9]+)/i.exec(file);
            if (m) {
                chips.add(m[1].toUpperCase());
            }
        }
    } catch {
        // 没有 include 目录时忽略
    }

    return Array.from(chips).filter(Boolean).sort();
}

export function getConfig() {
    const cfg = vscode.workspace.getConfiguration('fmdCompiler');
    return {
        compilerPath: cfg.get<string>('compilerPath', 'C:\\Program Files (x86)\\CCompiler\\Compiler\\data\\bin\\c.exe'),
        compilerSearchPaths: cfg.get<string[]>('compilerSearchPaths', [
            'C:\\Program Files (x86)\\CCompiler\\Compiler\\data\\bin\\c.exe',
            'C:\\Program Files\\CCompiler\\Compiler\\data\\bin\\c.exe',
        ]),
        projectFile: cfg.get<string>('projectFile', ''),
        chip: cfg.get<string>('chip', 'FT61FC6X'),
        outputDir: cfg.get<string>('outputDir', ''),
        extraArgs: cfg.get<string>('extraArgs', ''),
        autoSaveBeforeBuild: cfg.get<boolean>('autoSaveBeforeBuild', true),
        showOutputOnBuild: cfg.get<boolean>('showOutputOnBuild', true),
        programmerPath: cfg.get<string>('programmerPath', ''),
        programmerArgs: cfg.get<string[]>('programmerArgs', []),
        programmerCwd: cfg.get<string>('programmerCwd', '${projectDir}'),
        programmerUseShell: cfg.get<boolean>('programmerUseShell', false),
        programmerSuccessExitCodes: cfg.get<number[]>('programmerSuccessExitCodes', [0]),
        downloadFileType: cfg.get<'hex' | 'bin'>('downloadFileType', 'hex'),
        autoBuildBeforeDownload: cfg.get<boolean>('autoBuildBeforeDownload', false),
        showOutputOnDownload: cfg.get<boolean>('showOutputOnDownload', true),
        eepromBaseAddress: cfg.get<string>('eepromBaseAddress', '0x2100'),
        eepromStart: cfg.get<string>('eepromStart', '0x00'),
        eepromSize: cfg.get<number>('eepromSize', 112),
        eepromFill: cfg.get<string>('eepromFill', '0xFF'),
        eepromImageFile: cfg.get<string>('eepromImageFile', ''),
        eepromReadArgs: cfg.get<string[]>('eepromReadArgs', []),
        eepromWriteArgs: cfg.get<string[]>('eepromWriteArgs', []),
    };
}
