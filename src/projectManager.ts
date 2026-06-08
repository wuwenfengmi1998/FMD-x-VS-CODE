import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface FmdProjectInfo {
    projectFile: string;
    projectDir: string;
    projectName: string;
    device?: string;
    sourceFiles: string[];
    headerFiles: string[];
    eeFile?: string;
    encoding: BufferEncoding;
}

export class FmdProjectManager {
    private projectDir: string | undefined;
    private projectFile: string | undefined;

    /**
     * 自动在工作区中搜索 .prj 文件
     */
    autoDetectProject(): void {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return;
        }

        for (const folder of workspaceFolders) {
            const prjFiles = this.findPrjFiles(folder.uri.fsPath);
            if (prjFiles.length === 1) {
                this.projectFile = prjFiles[0];
                this.projectDir = path.dirname(prjFiles[0]);
                console.log(`[FMD] 自动检测到工程: ${this.projectFile}`);
                return;
            } else if (prjFiles.length > 1) {
                // 多个工程文件，不自动选择
                console.log(`[FMD] 发现多个工程文件，请手动选择`);
                return;
            }
        }
    }

    /**
     * 在目录下搜索 .prj 文件（最多2层深度）
     */
    private findPrjFiles(dir: string, depth = 0): string[] {
        if (depth > 2) {
            return [];
        }

        const result: string[] = [];
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile() && entry.name.toLowerCase().endsWith('.prj')) {
                    result.push(path.join(dir, entry.name));
                } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
                    result.push(...this.findPrjFiles(path.join(dir, entry.name), depth + 1));
                }
            }
        } catch {
            // 忽略权限错误
        }
        return result;
    }

    setProjectFile(filePath: string): void {
        this.projectFile = filePath;
        this.projectDir = path.dirname(filePath);
    }

    getProjectDir(): string | undefined {
        // 优先用已设置的工程目录
        if (this.projectDir) {
            return this.projectDir;
        }

        // 其次用当前活动文件所在目录
        const editor = vscode.window.activeTextEditor;
        if (editor && /\.[cChH]$/.test(editor.document.fileName)) {
            return path.dirname(editor.document.fileName);
        }

        return undefined;
    }

    getProjectFile(): string | undefined {
        if (this.projectFile && fs.existsSync(this.projectFile)) {
            return this.projectFile;
        }

        const dir = this.getProjectDir();
        if (!dir) {
            return undefined;
        }

        const files = this.findPrjFiles(dir, 2);
        return files.length === 1 ? files[0] : undefined;
    }

    getProjectInfo(projectFile?: string): FmdProjectInfo | undefined {
        const file = projectFile || this.getProjectFile();
        if (!file || !fs.existsSync(file)) {
            return undefined;
        }

        return this.readProjectInfo(file);
    }

    readProjectInfo(projectFile: string): FmdProjectInfo {
        const { text, encoding } = this.readProjectText(projectFile);
        const projectDir = path.dirname(projectFile);
        const rawName = this.matchValue(text, /^\s*Projece\s+Name\s*=\s*(.+)$/im);
        const projectName = path.basename(rawName || projectFile, path.extname(rawName || projectFile));
        const device = this.matchValue(text, /^\s*Device\s*=\s*(.+)$/im);
        const sourceLine = this.matchValue(text, /^\s*Source\s+File\s*=\s*(.*)$/im) || '';
        const eeLine = this.matchValue(text, /^\s*EE\s+File\s*=\s*(.*)$/im) || '';
        const headerFiles: string[] = [];
        const headerPattern = /^\s*Head\s+File\s+\d+\s*=\s*(.+)$/gim;
        let m: RegExpExecArray | null;

        while ((m = headerPattern.exec(text)) !== null) {
            const value = m[1].trim();
            if (value) {
                headerFiles.push(this.resolveProjectPath(projectDir, value));
            }
        }

        const sourceFiles = sourceLine
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0)
            .map(s => this.resolveProjectPath(projectDir, s));

        return {
            projectFile,
            projectDir,
            projectName,
            device,
            sourceFiles,
            headerFiles,
            eeFile: eeLine.trim() ? this.resolveProjectPath(projectDir, eeLine.trim()) : undefined,
            encoding,
        };
    }

    async updateProjectDevice(projectFile: string, chip: string): Promise<void> {
        const { text, encoding } = this.readProjectText(projectFile);
        const pattern = /^(\s*Device\s*=\s*).+$/im;
        const nextText = pattern.test(text)
            ? text.replace(pattern, `$1${chip}`)
            : `${text.replace(/\s*$/, '')}\r\nDevice = ${chip}\r\n`;

        fs.writeFileSync(projectFile, Buffer.from(nextText, encoding));
    }

    getCurrentChip(projectFile?: string): string | undefined {
        return this.getProjectInfo(projectFile)?.device;
    }

    /**
     * 弹出文件选择框让用户选择 .prj 文件
     */
    async pickProjectFile(): Promise<void> {
        const files = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: '选择 FMD 工程文件',
            filters: {
                'FMD Project': ['prj'],
                '所有文件': ['*'],
            },
        });

        if (files && files.length > 0) {
            this.setProjectFile(files[0].fsPath);
            vscode.window.showInformationMessage(`已选择工程: ${path.basename(files[0].fsPath)}`);
        }
    }

    private readProjectText(filePath: string): { text: string; encoding: BufferEncoding } {
        const buf = fs.readFileSync(filePath);
        const encoding = this.detectEncoding(buf);
        let text = buf.toString(encoding);
        if (text.charCodeAt(0) === 0xfeff) {
            text = text.slice(1);
        }
        return { text, encoding };
    }

    private detectEncoding(buf: Buffer): BufferEncoding {
        if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
            return 'utf16le';
        }

        const sampleLength = Math.min(buf.length, 200);
        let nulCount = 0;
        for (let i = 0; i < sampleLength; i++) {
            if (buf[i] === 0) {
                nulCount++;
            }
        }

        return nulCount > sampleLength / 4 ? 'utf16le' : 'utf8';
    }

    private matchValue(text: string, pattern: RegExp): string | undefined {
        const m = pattern.exec(text);
        return m?.[1]?.trim();
    }

    private resolveProjectPath(projectDir: string, value: string): string {
        return path.isAbsolute(value) ? value : path.join(projectDir, value);
    }
}
