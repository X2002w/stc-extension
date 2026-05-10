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
    /** 缓存已找到的工具实际路径 (工具名 → 完整路径) */
    private toolPaths: Map<string, string> = new Map();

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

            // 收集库文件和预编译目标文件（直接传给链接器）
            const linkOnlyFiles: string[] = (project.libraries || []).filter((f) => {
                // 过滤掉不存在的文件
                if (!fs.existsSync(f)) {
                    this.outputChannel.appendLine(`[警告] 库文件不存在，已跳过: ${f}`);
                    return false;
                }
                return true;
            });

            // 构建共同的命令行参数（每个 incdir/define 作为独立参数，C251 V5.60 要求小写）
            const includeArgs: string[] = project.includePaths.map((inc) => `incdir(${inc})`);
            const defineArgs: string[] = project.defines.length > 0
                ? [`define(${project.defines.join(', ')})`]
                : [];

            // 步骤1: 编译 C 源文件 (C251.EXE)
            const objFiles: string[] = [];
            for (const cFile of cFiles) {
                const objFile = path.join(
                    project.outputDir,
                    path.basename(cFile, '.c') + '.obj'
                );
                objFiles.push(objFile);

                const miscArgs = (project.c251Misc || 'xsmall').split(/\s+/).filter(Boolean);
                const args = [
                    cFile,
                    ...miscArgs,
                    ...includeArgs,
                    ...defineArgs,
                    `object(${objFile})`,
                ];

                this.outputChannel.appendLine(
                    `[C251] 编译 ${path.basename(cFile)}...`
                );
                const result = await this.execTool(
                    this.toolPaths.get('C251.EXE')!,
                    args,
                    workspaceRoot
                );
                allOutput += result.stdout + '\n' + result.stderr + '\n';
                this.outputChannel.append(result.stdout);
                if (result.stderr) {
                    this.outputChannel.append(result.stderr);
                }
                if (result.exitCode >= 2) {
                    this.outputChannel.appendLine(
                        `[C251] 编译失败 (exit code: ${result.exitCode})`
                    );
                } else if (result.exitCode === 1) {
                    this.outputChannel.appendLine(
                        `[C251] 编译成功（有警告）`
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
                    `object(${objFile})`,
                ].filter((a) => a.length > 0);

                this.outputChannel.appendLine(
                    `[A251] 汇编 ${path.basename(asmFile)}...`
                );
                const result = await this.execTool(
                    this.toolPaths.get('A251.EXE')!,
                    args,
                    workspaceRoot
                );
                allOutput += result.stdout + '\n' + result.stderr + '\n';
                this.outputChannel.append(result.stdout);
                if (result.stderr) {
                    this.outputChannel.append(result.stderr);
                }
                if (result.exitCode >= 2) {
                    this.outputChannel.appendLine(
                        `[A251] 汇编失败 (exit code: ${result.exitCode})`
                    );
                } else if (result.exitCode === 1) {
                    this.outputChannel.appendLine(
                        `[A251] 汇编成功（有警告）`
                    );
                }
            }

            // 步骤3: 链接 (L251.EXE)
            let linkFailed = false;
            if (objFiles.length > 0) {
                // 生成链接控制文件（包含编译生成的 .obj 和预编译库/目标文件）
                const allLinkFiles = [...objFiles, ...linkOnlyFiles];
                const linkFile = path.join(project.outputDir, 'project.lin');
                const absPath = path.join(project.outputDir, project.name + '.abs');
                const mapPath = path.join(project.outputDir, project.name + '.map');

                // 构建链接控制文件内容
                // 格式: obj列表 → TO → PRINT → CASE → DISABLEWARNING → WARNINGLEVEL → ... → CLASSES
                const linkLines: string[] = [];
                linkLines.push(allLinkFiles.map((f) => `"${f}"`).join(',\n'));
                linkLines.push(`TO "${absPath}"`);
                linkLines.push(`PRINT("${mapPath}")`);

                // CASE: 区分大小写链接（与 Keil uVision 行为一致）
                linkLines.push('CASE');

                // L251 警告等级（从 VS Code 用户设置读取）
                const l251WarnLevel = vscode.workspace.getConfiguration('stc-extension').get<string>('l251WarningLevel', 'DEFAULT');
                if (l251WarnLevel !== 'DEFAULT') {
                    linkLines.push(`WARNINGLEVEL(${l251WarnLevel})`);
                }

                // 屏蔽未调用函数/段的警告编号（如 57,16）
                if (project.l251DisableWarnings) {
                    linkLines.push(`DISABLEWARNING (${project.l251DisableWarnings.replace(/,/g, ', ')})`);
                }

                // 用户自定义的 L251 杂项控制（如 REMOVEUNUSED）
                if (project.l251Misc) {
                    linkLines.push(project.l251Misc);
                }

                // Use Memory Layout from Target Dialog → CLASSES 指令
                const useMemoryLayout = vscode.workspace.getConfiguration('stc-extension').get<boolean>('l251UseMemoryLayout', true);
                if (useMemoryLayout && project.l251Classes) {
                    linkLines.push(`CLASSES (${project.l251Classes})`);
                }

                const linkContent = linkLines.join('\n');
                fs.writeFileSync(linkFile, linkContent);

                this.outputChannel.appendLine('[L251] 链接...');
                const result = await this.execTool(
                    this.toolPaths.get('L251.EXE')!,
                    ['@' + linkFile],
                    workspaceRoot
                );
                allOutput += result.stdout + '\n' + result.stderr + '\n';
                this.outputChannel.append(result.stdout);
                if (result.stderr) {
                    this.outputChannel.append(result.stderr);
                }

                if (result.exitCode >= 2) {
                    this.outputChannel.appendLine(
                        `[L251] 链接失败 (exit code: ${result.exitCode})`
                    );
                    linkFailed = true;
                }

                // 步骤4: 生成 HEX (OH251.EXE) — 仅在链接成功时执行
                if (!linkFailed) {
                    // L251 生成 .abs 文件，OH251 需要精确的文件名
                    const omfFile = path.join(project.outputDir, project.name + '.abs');
                    const hexFile = path.join(project.outputDir, project.name + '.hex');

                    this.outputChannel.appendLine('[OH251] 生成 HEX...');
                    const ohResult = await this.execTool(
                        this.toolPaths.get('OH251.EXE')!,
                        [omfFile, `HEXFILE(${hexFile})`],
                        workspaceRoot
                    );
                    allOutput += ohResult.stdout + '\n' + ohResult.stderr + '\n';
                    this.outputChannel.append(ohResult.stdout);
                    if (ohResult.stderr) {
                        this.outputChannel.append(ohResult.stderr);
                    }
                }
            }

            // 解析输出生成诊断
            this.diagnosticParser.parse(allOutput, workspaceRoot);

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const errorCount = this.countErrors(allOutput);
            const warningCount = this.countWarnings(allOutput);

            // 提取 L251 的程序大小信息和 OH251 的 HEX 创建信息
            const programSize = this.extractProgramSize(allOutput);
            const hexStatus = this.extractHexStatus(allOutput);

            if (errorCount > 0) {
                this.updateStatus(`$(error) 编译失败 (${elapsed}s)`);
                this.outputChannel.appendLine(
                    `\n=== 编译失败，${errorCount} 个错误，耗时 ${elapsed}s ===`
                );
                return false;
            } else {
                this.updateStatus(`$(pass) 编译成功 (${elapsed}s)`);
                // Keil 风格编译摘要
                if (programSize) {
                    this.outputChannel.appendLine(`\n${programSize}`);
                }
                if (hexStatus) {
                    this.outputChannel.appendLine(hexStatus);
                }
                this.outputChannel.appendLine(
                    `\n".\\${path.relative(workspaceRoot, path.join(project.outputDir, project.name))}" - ${errorCount} Error(s), ${warningCount} Warning(s).`
                );
                this.outputChannel.appendLine(`Build Time Elapsed:  ${elapsed}s`);

                // 检测 L24 CPU 模式不兼容警告，提示解决方案
                this.appendCpuModeHint(allOutput);

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

        if (!this.checkTools(toolchainPath)) {
            return;
        }

        const c251Path = this.toolPaths.get('C251.EXE')!;

        this.outputChannel.clear();
        this.outputChannel.show(true);
        this.outputChannel.appendLine(`[C251] 编译 ${path.basename(filePath)}...`);

        const workspaceRoot = this.getWorkspaceRoot() || path.dirname(filePath);
        const result = await this.execTool(c251Path, [filePath, 'optimize(8)'], workspaceRoot);

        this.outputChannel.append(result.stdout);
        if (result.stderr) {
            this.outputChannel.append(result.stderr);
        }

        this.diagnosticParser.parse(result.stdout + '\n' + result.stderr, workspaceRoot);

        if (result.exitCode <= 1) {
            this.outputChannel.appendLine(
                result.exitCode === 0 ? '\n=== 编译通过 ===' : '\n=== 编译通过（有警告）==='
            );
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

        this.toolPaths.clear();

        for (const tool of tools) {
            // 先在配置路径直接查找
            const directPath = path.join(toolchainPath, tool);
            if (fs.existsSync(directPath)) {
                this.toolPaths.set(tool, directPath);
                continue;
            }

            // 递归搜索子目录（最多 3 层）
            const found = this.searchToolRecursive(toolchainPath, tool, 3);
            if (found) {
                this.toolPaths.set(tool, found);
                continue;
            }

            missing.push(tool);
        }

        if (missing.length > 0) {
            vscode.window.showErrorMessage(
                `找不到以下工具: ${missing.join(', ')}\n搜索路径: ${toolchainPath}（含 3 层子目录）`
            );
            return false;
        }

        // 输出找到的工具路径
        this.outputChannel.appendLine('--- 工具链路径 ---');
        for (const [tool, p] of this.toolPaths) {
            this.outputChannel.appendLine(`${tool}: ${p}`);
        }
        this.outputChannel.appendLine('');

        return true;
    }

    /**
     * 在目录下递归搜索指定名称的可执行文件
     */
    private searchToolRecursive(dir: string, exeName: string, maxDepth: number): string | undefined {
        if (maxDepth <= 0 || !fs.existsSync(dir)) {
            return undefined;
        }
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name.startsWith('.')) {
                        continue;
                    }
                    const found = this.searchToolRecursive(fullPath, exeName, maxDepth - 1);
                    if (found) {
                        return found;
                    }
                } else if (entry.isFile()) {
                    if (
                        entry.name === exeName ||
                        entry.name.toLowerCase() === exeName.toLowerCase()
                    ) {
                        return fullPath;
                    }
                }
            }
        } catch {
            // 忽略无权限目录
        }
        return undefined;
    }

    /**
     * 执行外部工具（自动为含空格的参数加引号）
     */
    private execTool(
        exePath: string,
        args: string[],
        cwd: string
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        return new Promise((resolve) => {
            let stdout = '';
            let stderr = '';

            // 为含空格的参数加双引号，防止命令行解析时路径被截断
            const quotedArgs = args.map((arg) => {
                if (arg.includes(' ') && !arg.startsWith('"')) {
                    return `"${arg}"`;
                }
                return arg;
            });

            const proc = spawn(exePath, quotedArgs, {
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

    private countWarnings(output: string): number {
        const matches = output.match(/^\*\*\*\s+WARNING\s+/gim);
        return matches ? matches.length : 0;
    }

    /** 从 L251 输出中提取程序大小信息 */
    private extractProgramSize(output: string): string | undefined {
        const match = output.match(/Program Size:\s*.+/i);
        return match ? match[0].trim() : undefined;
    }

    /** 从 OH251 输出中提取 HEX 创建状态 */
    private extractHexStatus(output: string): string | undefined {
        const match = output.match(/creating hex file from\s*.+/i);
        return match ? match[0].trim() : undefined;
    }

    /** 检测 L24 CPU 模式不兼容警告并给出说明 */
    private appendCpuModeHint(output: string): void {
        const l24Pattern = /\*\*\* WARNING L24: INCOMPATIBLE CPU MODE\s+MODULE:\s+(.+?)\s*\*\*\s+MODE:\s+BINARY MODE/gi;
        const matches = output.matchAll(l24Pattern);
        const binaryModules: string[] = [];
        for (const m of matches) {
            const moduleName = m[1]?.trim();
            if (moduleName && !binaryModules.includes(moduleName)) {
                binaryModules.push(moduleName);
            }
        }

        if (binaryModules.length > 0) {
            this.outputChannel.appendLine('');
            this.outputChannel.appendLine('ℹ️  CPU 模式说明 (L24)');
            this.outputChannel.appendLine('   以下文件由 A251 以 BINARY 模式汇编（STC32G 正常行为）：');
            for (const mod of binaryModules) {
                this.outputChannel.appendLine(`   - ${mod}`);
            }
            this.outputChannel.appendLine('');
            this.outputChannel.appendLine('   STC32G 的启动文件 (START251.A51) 使用 BINARY 模式汇编，');
            this.outputChannel.appendLine('   而 C 代码使用 SOURCE 模式编译。这种混合模式是 STC32G 的');
            this.outputChannel.appendLine('   正常设计，Keil uVision 中同样存在此警告，不影响程序运行。');
            this.outputChannel.appendLine('');
        }
    }
}
