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
        vscode.commands.registerCommand('fmdCompiler.selectProject', async (uri?: vscode.Uri) => {
            if (uri) {
                projectManager.setProjectFile(uri.fsPath);
                vscode.window.showInformationMessage(`已选择工程: ${path.basename(uri.fsPath)}`);
            } else {
                await projectManager.pickProjectFile();
            }
            await ensureWorkspaceSettings();
            ensureCppProperties();
            ensureGitignore();
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
        vscode.commands.registerCommand('fmdCompiler.regenerateConfig', () => regenerateConfig()),
        diagnosticsCollection
    );

    // 状态栏
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'fmdCompiler.build';
    const chipStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    chipStatusBar.command = 'fmdCompiler.selectChip';
    const downloadStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    downloadStatusBar.command = 'fmdCompiler.download';
    const configStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
    configStatusBar.command = 'fmdCompiler.regenerateConfig';

    const update = () => {
        const cfg = getConfig();
        const projectFile = projectManager.getProjectFile() || cfg.projectFile;
        statusBar.text = '$(play) FMD Build';
        statusBar.tooltip = projectFile ? `编译 FMD 工程: ${projectFile}` : '编译 FMD 工程 (F7)';
        chipStatusBar.text = `$(circuit-board) ${cfg.chip}`;
        chipStatusBar.tooltip = '切换 FMD 目标芯片';
        downloadStatusBar.text = '$(cloud-upload) FMD Download';
        downloadStatusBar.tooltip = cfg.programmerPath ? `下载程序: ${cfg.programmerPath}` : '未配置烧录工具，点击配置后可下载';
        configStatusBar.text = '$(gear) FMD Config';
        configStatusBar.tooltip = '一键重新生成 .gitignore 和 .vscode 配置';
        statusBar.show();
        chipStatusBar.show();
        downloadStatusBar.show();
        configStatusBar.show();
    };
    updateStatusBars = update;
    updateStatusBars();
    context.subscriptions.push(statusBar, chipStatusBar, downloadStatusBar, configStatusBar);

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
    ensureWorkspaceSettings();
    ensureCppProperties();
    ensureGitignore();
    updateStatusBars();

    outputChannel.appendLine('[FMD] 插件已激活');
    outputChannel.appendLine(`[FMD] 编译器: ${getConfig().compilerPath}`);
}

export function deactivate() {
    diagnosticsCollection?.dispose();
    outputChannel?.dispose();
}

let updateStatusBars = () => {};

async function regenerateConfig(): Promise<void> {
    outputChannel.show(true);
    outputChannel.appendLine('');
    outputChannel.appendLine('========== FMD 重新生成 VS Code 配置 ==========');
    await ensureWorkspaceSettings();
    ensureCppProperties();
    ensureGitignore();
    updateStatusBars();
    outputChannel.appendLine('========== FMD 配置生成完成 ==========');
    vscode.window.showInformationMessage('FMD: 已重新生成 .gitignore 和 .vscode 配置');
}

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

async function ensureWorkspaceSettings(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return;
    }

    for (const folder of folders) {
        const settingsDir = path.join(folder.uri.fsPath, '.vscode');
        const settingsFile = path.join(settingsDir, 'settings.json');
        let settings: Record<string, unknown> = {};

        try {
            if (fs.existsSync(settingsFile)) {
                settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
            }
        } catch (err) {
            outputChannel.appendLine(`[警告] 无法解析工作区设置，跳过自动写入: ${settingsFile}: ${err}`);
            continue;
        }

        let changed = false;
        const cfg = getConfig();
        const projectFile = projectManager.getProjectFile() || findSinglePrjFile(folder.uri.fsPath) || cfg.projectFile;
        const projectChip = projectFile ? projectManager.getCurrentChip(projectFile) : undefined;

        if (settings['fmdCompiler.outputDir'] === undefined) {
            settings['fmdCompiler.outputDir'] = 'build';
            changed = true;
        }
        if (settings['fmdCompiler.compilerPath'] === undefined) {
            settings['fmdCompiler.compilerPath'] = cfg.compilerPath;
            changed = true;
        }
        if (settings['fmdCompiler.chip'] === undefined) {
            settings['fmdCompiler.chip'] = projectChip || cfg.chip || 'FT61FC6X';
            changed = true;
        }
        if (projectFile && settings['fmdCompiler.projectFile'] === undefined) {
            settings['fmdCompiler.projectFile'] = projectFile;
            changed = true;
        }
        if (settings['fmdCompiler.autoSaveBeforeBuild'] === undefined) {
            settings['fmdCompiler.autoSaveBeforeBuild'] = true;
            changed = true;
        }
        if (settings['fmdCompiler.showOutputOnBuild'] === undefined) {
            settings['fmdCompiler.showOutputOnBuild'] = true;
            changed = true;
        }

        if (changed) {
            fs.mkdirSync(settingsDir, { recursive: true });
            fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
            outputChannel.appendLine(`[FMD] 已自动生成/更新工作区设置: ${settingsFile}`);
        }
    }
}

function ensureCppProperties(): void {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return;
    }

    const cfg = getConfig();
    const compilerInclude = path.join(path.dirname(cfg.compilerPath), '..', 'include');

    for (const folder of folders) {
        const vscodeDir = path.join(folder.uri.fsPath, '.vscode');
        const propertiesFile = path.join(vscodeDir, 'c_cpp_properties.json');
        const projectFile = projectManager.getProjectFile() || findSinglePrjFile(folder.uri.fsPath) || cfg.projectFile;
        const projectDir = projectFile ? path.dirname(projectFile) : folder.uri.fsPath;
        const chip = (projectFile ? projectManager.getCurrentChip(projectFile) : undefined) || cfg.chip;
        const intellisenseHeader = ensureFmdIntellisenseHeader(vscodeDir, compilerInclude, chip);
        const includePath = [
            '${workspaceFolder}/**',
            normalizeForCppProperties(projectDir),
            normalizeForCppProperties(path.join(projectDir, '**')),
            normalizeForCppProperties(compilerInclude),
        ];
        const defines = [
            `_${chip}`,
            '__GCC8PRO__',
            '_CHIP_SELECT_H_',
        ];
        const forcedInclude = [
            normalizeForCppProperties(intellisenseHeader),
        ];
        let properties: {
            configurations?: Array<Record<string, unknown>>;
            version?: number;
            [key: string]: unknown;
        } = {};

        try {
            if (fs.existsSync(propertiesFile)) {
                properties = JSON.parse(fs.readFileSync(propertiesFile, 'utf8'));
            }
        } catch (err) {
            outputChannel.appendLine(`[警告] 无法解析 C/C++ 配置，跳过自动写入: ${propertiesFile}: ${err}`);
            continue;
        }

        if (!Array.isArray(properties.configurations) || properties.configurations.length === 0) {
            properties.configurations = [{
                name: 'FMD',
                includePath,
                defines,
                forcedInclude,
                compilerPath: cfg.compilerPath,
                cStandard: 'c99',
                intelliSenseMode: 'windows-gcc-x86',
            }];
        } else {
            const configuration = properties.configurations[0];
            const currentIncludePath = Array.isArray(configuration.includePath) ? configuration.includePath as string[] : [];
            const currentDefines = Array.isArray(configuration.defines) ? configuration.defines as string[] : [];
            const currentForcedInclude = Array.isArray(configuration.forcedInclude) ? configuration.forcedInclude as string[] : [];
            configuration.includePath = mergeUnique(currentIncludePath, includePath);
            configuration.defines = mergeUnique(currentDefines, defines);
            configuration.forcedInclude = mergeUnique(currentForcedInclude, forcedInclude);
            if (!configuration.compilerPath) {
                configuration.compilerPath = cfg.compilerPath;
            }
            if (!configuration.cStandard) {
                configuration.cStandard = 'c99';
            }
            if (!configuration.intelliSenseMode) {
                configuration.intelliSenseMode = 'windows-gcc-x86';
            }
        }

        if (!properties.version) {
            properties.version = 4;
        }

        fs.mkdirSync(vscodeDir, { recursive: true });
        fs.writeFileSync(propertiesFile, JSON.stringify(properties, null, 2) + '\n');
        outputChannel.appendLine(`[FMD] 已自动生成/更新 C/C++ 头文件路径: ${propertiesFile}`);
    }
}

function ensureFmdIntellisenseHeader(vscodeDir: string, compilerInclude: string, chip: string): string {
    fs.mkdirSync(vscodeDir, { recursive: true });
    const target = path.join(vscodeDir, 'fmd_intellisense.h');
    const chipHeader = findChipHeader(compilerInclude, chip);
    const names = chipHeader ? extractChipSymbols(chipHeader) : [];
    const lines = [
        '/* Auto-generated by FMD C Compiler extension. */',
        '/* This file is only for VS Code IntelliSense and is not used by c.exe. */',
        '#ifndef FMD_INTELLISENSE_H',
        '#define FMD_INTELLISENSE_H',
        '',
        '#ifndef __FMD_INTELLISENSE__',
        '#define __FMD_INTELLISENSE__ 1',
        '#endif',
        '',
        '#ifndef bit',
        'typedef unsigned char bit;',
        '#endif',
        '',
        '#ifndef asm',
        '#define asm(...)',
        '#endif',
        '',
        '#ifndef interrupt',
        '#define interrupt',
        '#endif',
        '',
        `#ifndef _${chip}`,
        `#define _${chip}`,
        '#endif',
        '',
        ...names.map(name => `extern volatile unsigned char ${name};`),
        '',
        '#endif',
        '',
    ];

    fs.writeFileSync(target, lines.join('\n'));
    return target;
}

function findChipHeader(compilerInclude: string, chip: string): string | undefined {
    const candidates = [
        path.join(compilerInclude, `${chip}.h`),
        path.join(compilerInclude, `${chip}.H`),
    ];
    return candidates.find(file => fs.existsSync(file));
}

function extractChipSymbols(chipHeader: string): string[] {
    const text = fs.readFileSync(chipHeader, 'utf8');
    const names = new Set<string>();
    const patterns = [
        /volatile\s+(?:unsigned\s+char|bit)\s+([A-Za-z_][A-Za-z0-9_]*)\s*@/g,
        /volatile\s+union\s*\{[\s\S]*?\}\s*([A-Za-z_][A-Za-z0-9_]*)\s*@/g,
    ];

    for (const pattern of patterns) {
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(text)) !== null) {
            names.add(m[1]);
        }
    }

    return Array.from(names).sort();
}

function normalizeForCppProperties(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function mergeUnique(first: string[], second: string[]): string[] {
    const result: string[] = [];
    for (const value of [...first, ...second]) {
        if (value && !result.includes(value)) {
            result.push(value);
        }
    }
    return result;
}

function ensureGitignore(): void {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return;
    }

    const patterns = [
        '.vscode',
        '**/*.as',
        '**/*.asm',
        '**/*.bin',
        '**/*.cmf',
        '**/*.cof',
        '**/*.d',
        '**/*.hex',
        '**/*.lpp',
        '**/*.map',
        '**/*.obj',
        '**/*.p1',
        '**/*.pre',
        '**/*.rlf',
        '**/*.sdb',
        '**/*.sym',
        '**/*.hxl',
        '**/*.ini',
        '**/*.rar',
        '**/*.o',
        '**/*.crf',
        '**/*.htm',
        '**/*.dep',
        '**/*.bak',
        '**/*.lnp',
        '**/*.lst',
        '**/*.iex',
        '**/*.sct',
        '**/*.scvd',
        '**/*.uvguix',
        '**/*.dbg*',
        '**/*.uvguix.*',
        '**/.mxproject',
        '**/*.uvopt',
        '**/*.uvgui.*',
        '**/Listings',
        '**/output',
        '**/*.zip',
    ];

    const blockStart = '# FMD generated ignores';
    const blockEnd = '# End FMD generated ignores';
    const block = [blockStart, ...patterns, blockEnd].join('\n');

    for (const folder of folders) {
        const gitignoreFile = path.join(folder.uri.fsPath, '.gitignore');
        let text = '';

        if (fs.existsSync(gitignoreFile)) {
            text = fs.readFileSync(gitignoreFile, 'utf8');
            if (text.includes(blockStart) && text.includes(blockEnd)) {
                const pattern = new RegExp(`${escapeRegExp(blockStart)}[\\s\\S]*?${escapeRegExp(blockEnd)}`);
                const nextText = text.replace(pattern, block);
                if (nextText !== text) {
                    fs.writeFileSync(gitignoreFile, ensureTrailingNewline(nextText));
                    outputChannel.appendLine(`[FMD] 已更新 .gitignore: ${gitignoreFile}`);
                }
                continue;
            }
        }

        const missing = patterns.filter(p => !hasGitignorePattern(text, p));
        if (missing.length === 0) {
            continue;
        }

        const prefix = text.trim().length > 0 ? ensureTrailingNewline(text).replace(/\s*$/, '\n\n') : '';
        fs.writeFileSync(gitignoreFile, `${prefix}${block}\n`);
        outputChannel.appendLine(`[FMD] 已自动生成/更新 .gitignore: ${gitignoreFile}`);
    }
}

function hasGitignorePattern(text: string, pattern: string): boolean {
    return text.split(/\r?\n/).some(line => line.trim() === pattern);
}

function ensureTrailingNewline(text: string): string {
    return text.endsWith('\n') ? text : text + '\n';
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findSinglePrjFile(folderPath: string): string | undefined {
    const result: string[] = [];
    const walk = (dir: string, depth: number) => {
        if (depth > 2 || result.length > 1) {
            return;
        }
        try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isFile() && entry.name.toLowerCase().endsWith('.prj')) {
                    result.push(fullPath);
                } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
                    walk(fullPath, depth + 1);
                }
            }
        } catch {
            // 忽略权限错误
        }
    };

    walk(folderPath, 0);
    return result.length === 1 ? result[0] : undefined;
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
        outputDir: cfg.get<string>('outputDir', 'build'),
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
