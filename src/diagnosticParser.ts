import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Keil 工具输出的单条诊断信息
 */
interface ParsedMessage {
    filePath: string;
    line: number;
    column: number;
    severity: vscode.DiagnosticSeverity;
    code: string;
    message: string;
}

/**
 * 解析 Keil C251 / A251 / L251 编译输出，生成 VS Code Diagnostic 对象
 */
export class DiagnosticParser {
    private diagnosticCollection: vscode.DiagnosticCollection;

    // C251 格式: *** ERROR C202 IN LINE 42 OF main.c: 'identifier' undefined
    //           *** WARNING C206 IN LINE 5 OF src\main.c: missing function prototype
    private readonly c251Pattern =
        /^\*\*\*\s+(ERROR|WARNING)\s+(C\d+)\s+IN\s+LINE\s+(\d+)\s+OF\s+([^:]+):\s*(.+)$/i;

    // A251 格式: *** ERROR A45 IN 12 (main.a51, LINE 42): undefined symbol
    private readonly a251Pattern =
        /^\*\*\*\s+(ERROR|WARNING)\s+(A\d+)\s+IN\s+\d+\s+\(([^,]+),\s*LINE\s+(\d+)\):\s*(.+)$/i;

    // L251 格式: *** ERROR L121: UNRESOLVED EXTERNAL SYMBOL
    //           *** WARNING L2: REFERENCE MADE TO UNRESOLVED EXTERNAL
    private readonly l251Pattern =
        /^\*\*\*\s+(ERROR|WARNING)\s+(L\d+):\s*(.+)$/i;

    // 通用 fallback 格式: *** ERROR ...
    private readonly genericPattern =
        /^\*\*\*\s+(ERROR|WARNING)\s+(.+)$/i;

    constructor() {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('stc-build');
    }

    /**
     * 清除所有诊断
     */
    clear(): void {
        this.diagnosticCollection.clear();
    }

    /**
     * 解析编译输出文本，生成诊断信息
     */
    parse(output: string, workspaceRoot: string): void {
        const lines = output.split(/\r?\n/);
        const diagnosticsByFile = new Map<string, vscode.Diagnostic[]>();

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }

            const parsed = this.parseLine(trimmed, workspaceRoot);
            if (!parsed) {
                continue;
            }

            const fileUri = vscode.Uri.file(parsed.filePath).toString();
            const existing = diagnosticsByFile.get(fileUri) || [];

            const range = new vscode.Range(
                Math.max(0, parsed.line - 1),
                parsed.column,
                Math.max(0, parsed.line - 1),
                999  // 高亮整行
            );

            const diagnostic = new vscode.Diagnostic(
                range,
                parsed.message,
                parsed.severity
            );
            diagnostic.code = parsed.code;
            diagnostic.source = 'Keil C251';

            existing.push(diagnostic);
            diagnosticsByFile.set(fileUri, existing);
        }

        // 写入诊断集合
        this.diagnosticCollection.clear();
        for (const [fileUri, diagnostics] of diagnosticsByFile) {
            this.diagnosticCollection.set(vscode.Uri.parse(fileUri), diagnostics);
        }
    }

    /**
     * 解析单行输出
     */
    private parseLine(line: string, workspaceRoot: string): ParsedMessage | undefined {
        // 尝试 C251 格式
        let match = this.c251Pattern.exec(line);
        if (match) {
            const filePath = this.resolvePath(match[4].trim(), workspaceRoot);
            return {
                filePath,
                line: parseInt(match[3], 10),
                column: 0,
                severity: match[1].toUpperCase() === 'ERROR'
                    ? vscode.DiagnosticSeverity.Error
                    : vscode.DiagnosticSeverity.Warning,
                code: match[2],
                message: match[5].trim(),
            };
        }

        // 尝试 A251 格式
        match = this.a251Pattern.exec(line);
        if (match) {
            const filePath = this.resolvePath(match[3].trim(), workspaceRoot);
            return {
                filePath,
                line: parseInt(match[4], 10),
                column: 0,
                severity: match[1].toUpperCase() === 'ERROR'
                    ? vscode.DiagnosticSeverity.Error
                    : vscode.DiagnosticSeverity.Warning,
                code: match[2],
                message: match[5].trim(),
            };
        }

        // 尝试 L251 格式
        match = this.l251Pattern.exec(line);
        if (match) {
            return {
                filePath: workspaceRoot,  // 链接器错误关联到工作区根
                line: 0,
                column: 0,
                severity: match[1].toUpperCase() === 'ERROR'
                    ? vscode.DiagnosticSeverity.Error
                    : vscode.DiagnosticSeverity.Warning,
                code: match[2],
                message: match[3].trim(),
            };
        }

        // 尝试通用格式
        match = this.genericPattern.exec(line);
        if (match) {
            return {
                filePath: workspaceRoot,
                line: 0,
                column: 0,
                severity: match[1].toUpperCase() === 'ERROR'
                    ? vscode.DiagnosticSeverity.Error
                    : vscode.DiagnosticSeverity.Warning,
                code: '',
                message: match[2].trim(),
            };
        }

        return undefined;
    }

    /**
     * 解析文件路径（相对路径转绝对路径）
     */
    private resolvePath(filePath: string, workspaceRoot: string): string {
        if (path.isAbsolute(filePath)) {
            return filePath;
        }
        return path.resolve(workspaceRoot, filePath);
    }

    /**
     * 销毁诊断集合
     */
    dispose(): void {
        this.diagnosticCollection.dispose();
    }
}
