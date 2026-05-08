import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, SpawnOptions } from 'child_process';
import { DiagnosticParser } from './diagnosticParser';
import { UvprojProject } from './uvprojParser';

/**
 * 编译流程编排器
 * 流程: C251 (C编译) → A251 (汇编) → L251 (链接) → OH251 (生成HEX)
 */
export class StcCompiler {
    private outputChannel: vscode.OutputChannel;
    private diagnosticParser: DiagnosticParser;
    private statusBarItem: vscode.StatusBarItem;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('STC Build');
        this.diagnosticParser = new DiagnosticParser();
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            10
        );
        this.statusBarItem.command = 'stc-extension.build';
    }

    /**
     * 完整编译流程
     */
    async build(project: UvprojProject): Promise<boolean> {
        const toolchainPath = this.getToolchainPath();
        if (!toolchainPath) {
            vscode.window.showErrorMessage('请先设置 Keil C251 工具链路径');
            return false;
        }

        if (!this.checkTools(toolchainPath)) {
            return false;
        }

        const workspaceRoot = this.getWorkspaceRoot();
        if (!workspaceRoot) {
            return false;
        }

        this.outputChannel.clear();
        this.outputChannel.show(true);
        this.diagnosticParser.clear();
        this.updateStatus('$(sync~spin) 编译中...');

        const startTime = Date.now();
        let allOutput = '';

        try {
            // 确保输出目录存在
            if (!fs.existsSync(project.outputDir)) {
                fs.mkdirSync(project.outputDir, { recursive: true });
            }

            // 收集所有源文件（从分组中扁平化）
            const cFiles: string[] = [];
            const asmFiles: string[] = [];
            for (const group of project.groups) {
                for (const file of group.files) {
                    const ext = path.extname(file).toLowerCase();
                    if (ext === '.c') {
                        cFiles.push(file);
                    } else if (ext === '.a51' || ext === '.asm') {
                        asmFiles.push(file);
                    }
                }
            }

            // 构建共同的命令行参数
            const includeArgs = project.includePaths
                .map((inc) => `INCDIR(${inc})`)
                .join(' ');
            const defineArgs = project.defines.length > 0
                ? `DEFINE(${project.defines.join(', ')})`
                : '';

            // 步骤1: 编译 C 源文件 (C251.EXE)
            const objFiles: string[] = [];
            for (const cFile of cFiles) {
                const objFile = path.join(
                    project.outputDir,
                    path.basename(cFile, '.c') + '.obj'
                );
                objFiles.push(objFile);

                const miscArgs = project.c251Misc || 'DB OE MODC251';
                const args = [
                    cFile,
                    ...miscArgs.split(/\s+/),
                    includeArgs,
                    defineArgs,
                    `OBJECT(${objFile})`,
                ].filter((a) => a.length > 0);

                this.outputChannel.appendLine(
                    `[C251] 编译 ${path.basename(cFile)}...`
                );
                const result = await this.execTool(
                    path.join(toolchainPath, 'C251.EXE'),
                    args,
                    workspaceRoot
                );
                allOutput += result.stdout + '\n' + result.stderr + '\n';
                this.outputChannel.append(result.stdout);
                if (result.stderr) {
                    this.outputChannel.append(result.stderr);
                }
                if (result.exitCode !== 0) {
                    this.outputChannel.appendLine(
                        `[C251] 编译失败 (exit code: ${result.exitCode})`
                    );
                }
            }

            // 步骤2: 汇编 .a51/.asm 文件 (A251.EXE)
            for (const asmFile of asmFiles) {
                const objFile = path.join(
                    project.outputDir,
                    path.basename(asmFile, path.extname(asmFile)) + '.obj'
                );
                objFiles.push(objFile);

                const miscArgs = project.a251Misc || '';
                const args = [
                    asmFile,
                    ...miscArgs.split(/\s+/),
                    `OBJECT(${objFile})`,
                ].filter((a) => a.length > 0);

                this.outputChannel.appendLine(
                    `[A251] 汇编 ${path.basename(asmFile)}...`
                );
                const result = await this.execTool(
                    path.join(toolchainPath, 'A251.EXE'),
                    args,
                    workspaceRoot
                );
                allOutput += result.stdout + '\n' + result.stderr + '\n';
                this.outputChannel.append(result.stdout);
                if (result.stderr) {
                    this.outputChannel.append(result.stderr);
                }
                if (result.exitCode !== 0) {
                    this.outputChannel.appendLine(
                        `[A251] 汇编失败 (exit code: ${result.exitCode})`
                    );
                }
            }

            // 步骤3: 链接 (L251.EXE)
            if (objFiles.length > 0) {
                // 生成链接控制文件
                const linkFile = path.join(project.outputDir, 'project.lin');
                const linkContent = objFiles.map((f) => `"${f}"`).join(',\n')
                    + `\nTO "${path.join(project.outputDir, project.name)}.abs"`
                    + ` ${project.l251Misc || ''}`;
                fs.writeFileSync(linkFile, linkContent);

                this.outputChannel.appendLine('[L251] 链接...');
                const result = await this.execTool(
                    path.join(toolchainPath, 'L251.EXE'),
                    ['@' + linkFile],
                    workspaceRoot
                );
                allOutput += result.stdout + '\n' + result.stderr + '\n';
                this.outputChannel.append(result.stdout);
                if (result.stderr) {
                    this.outputChannel.append(result.stderr);
                }

                // 步骤4: 生成 HEX (OH251.EXE)
                const omfFile = path.join(project.outputDir, project.name);
                const hexFile = path.join(project.outputDir, project.name + '.hex');

                this.outputChannel.appendLine('[OH251] 生成 HEX...');
                const ohResult = await this.execTool(
                    path.join(toolchainPath, 'OH251.EXE'),
                    [omfFile, `HEXFILE(${hexFile})`],
                    workspaceRoot
                );
                allOutput += ohResult.stdout + '\n' + ohResult.stderr + '\n';
                this.outputChannel.append(ohResult.stdout);
                if (ohResult.stderr) {
                    this.outputChannel.append(ohResult.stderr);
                }
            }

            // 解析输出生成诊断
            this.diagnosticParser.parse(allOutput, workspaceRoot);

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const errorCount = this.countErrors(allOutput);
            if (errorCount > 0) {
                this.updateStatus(`$(error) 编译失败 (${elapsed}s)`);
                this.outputChannel.appendLine(
                    `\n=== 编译失败，${errorCount} 个错误，耗时 ${elapsed}s ===`
                );
                return false;
            } else {
                this.updateStatus(`$(pass) 编译成功 (${elapsed}s)`);
                this.outputChannel.appendLine(
                    `\n=== 编译成功，耗时 ${elapsed}s ===`
                );
                return true;
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`\n编译异常: ${msg}`);
            this.updateStatus('$(error) 编译异常');
            return false;
        }
    }

    /**
     * 单文件编译（快速语法检查）
     */
    async compileSingleFile(filePath: string): Promise<void> {
        const toolchainPath = this.getToolchainPath();
        if (!toolchainPath) {
            vscode.window.showErrorMessage('请先设置 Keil C251 工具链路径');
            return;
        }

        const c251 = path.join(toolchainPath, 'C251.EXE');
        if (!fs.existsSync(c251)) {
            vscode.window.showErrorMessage(`找不到 C251.EXE: ${c251}`);
            return;
        }

        this.outputChannel.clear();
        this.outputChannel.show(true);
        this.outputChannel.appendLine(`[C251] 编译 ${path.basename(filePath)}...`);

        const workspaceRoot = this.getWorkspaceRoot() || path.dirname(filePath);
        const result = await this.execTool(c251, [filePath, 'DB', 'OE', 'MODC251'], workspaceRoot);

        this.outputChannel.append(result.stdout);
        if (result.stderr) {
            this.outputChannel.append(result.stderr);
        }

        this.diagnosticParser.parse(result.stdout + '\n' + result.stderr, workspaceRoot);

        if (result.exitCode === 0) {
            this.outputChannel.appendLine('\n=== 编译通过 ===');
        } else {
            this.outputChannel.appendLine('\n=== 编译失败 ===');
        }
    }

    /**
     * 清理编译产物
     */
    clean(project: UvprojProject): void {
        const extensions = ['.obj', '.lst', '.omf', '.abs', '.hex', '.m51', '.lin'];
        const outputDir = project.outputDir;
        if (!fs.existsSync(outputDir)) {
            vscode.window.showInformationMessage('输出目录不存在，无需清理');
            return;
        }

        let count = 0;
        const files = fs.readdirSync(outputDir);
        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            if (extensions.includes(ext)) {
                fs.unlinkSync(path.join(outputDir, file));
                count++;
            }
            // 也删除无扩展名的编译产物（如 .abs 实际可能是无扩展名的 omf）
        }

        this.outputChannel.clear();
        this.outputChannel.show(true);
        this.outputChannel.appendLine(`清理完成，删除了 ${count} 个文件`);
        this.updateStatus('$(check) 已清理');
        setTimeout(() => this.statusBarItem.hide(), 3000);
    }

    /**
     * 获取输出通道
     */
    getOutputChannel(): vscode.OutputChannel {
        return this.outputChannel;
    }

    /**
     * 销毁资源
     */
    dispose(): void {
        this.outputChannel.dispose();
        this.diagnosticParser.dispose();
        this.statusBarItem.dispose();
    }

    // ================ 私有方法 ================

    private getToolchainPath(): string {
        return vscode.workspace
            .getConfiguration('stc-extension')
            .get<string>('toolchainPath') || '';
    }

    private getWorkspaceRoot(): string | undefined {
        const folders = vscode.workspace.workspaceFolders;
        return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
    }

    private checkTools(toolchainPath: string): boolean {
        const tools = ['C251.EXE', 'A251.EXE', 'L251.EXE', 'OH251.EXE'];
        const missing: string[] = [];
        for (const tool of tools) {
            const toolPath = path.join(toolchainPath, tool);
            if (!fs.existsSync(toolPath)) {
                missing.push(tool);
            }
        }
        if (missing.length > 0) {
            vscode.window.showErrorMessage(
                `找不到以下工具: ${missing.join(', ')}\n请检查工具链路径: ${toolchainPath}`
            );
            return false;
        }
        return true;
    }

    /**
     * 执行外部工具
     */
    private execTool(
        exePath: string,
        args: string[],
        cwd: string
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        return new Promise((resolve) => {
            let stdout = '';
            let stderr = '';

            const proc = spawn(exePath, args, {
                cwd,
                shell: true,
                stdio: 'pipe',
            } as SpawnOptions);

            proc.stdout?.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            proc.stderr?.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            proc.on('close', (code: number | null) => {
                resolve({
                    stdout,
                    stderr,
                    exitCode: code ?? -1,
                });
            });

            proc.on('error', (err: Error) => {
                resolve({
                    stdout,
                    stderr: err.message,
                    exitCode: -1,
                });
            });
        });
    }

    private updateStatus(text: string): void {
        this.statusBarItem.text = text;
        this.statusBarItem.show();
    }

    private countErrors(output: string): number {
        const matches = output.match(/^\*\*\*\s+ERROR\s+/gim);
        return matches ? matches.length : 0;
    }
}
