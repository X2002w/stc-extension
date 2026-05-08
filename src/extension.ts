import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { StcProjectTreeProvider } from './projectTree';
import { UvprojParser } from './uvprojParser';
import { StcCompiler } from './compiler';
import { StcTaskProvider } from './taskProvider';

let projectTreeProvider: StcProjectTreeProvider;
let uvprojParser: UvprojParser;
let compiler: StcCompiler;
let taskProvider: vscode.Disposable | undefined;

/**
 * 扩展激活
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // 初始化模块
    projectTreeProvider = new StcProjectTreeProvider();
    uvprojParser = new UvprojParser();
    compiler = new StcCompiler();

    // 注册工程树视图
    const treeView = vscode.window.createTreeView('stcProjectExplorer', {
        treeDataProvider: projectTreeProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    // 注册任务提供者
    taskProvider = vscode.tasks.registerTaskProvider(
        'stc-build',
        new StcTaskProvider()
    );
    context.subscriptions.push(taskProvider);

    // 注册命令
    context.subscriptions.push(
        vscode.commands.registerCommand('stc-extension.build', () => handleBuild())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('stc-extension.rebuild', () => handleRebuild())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('stc-extension.clean', () => handleClean())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('stc-extension.refreshProject', () => {
            projectTreeProvider.refresh();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('stc-extension.setToolchainPath', () =>
            handleSetToolchainPath()
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('stc-extension.newProject', () =>
            handleNewProject()
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('stc-extension.compileSingleFile', (item) =>
            handleCompileSingleFile(item)
        )
    );

    // 自动检测并加载工程
    await autoLoadProject();

    // 监听配置文件变化
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('stc-extension.toolchainPath')) {
                vscode.window.showInformationMessage('Keil C251 工具链路径已更新');
            }
        })
    );

    vscode.window.showInformationMessage('STC Extension 已激活');
}

/**
 * 扩展停用
 */
export function deactivate(): void {
    if (compiler) {
        compiler.dispose();
    }
}

// ================ 命令处理 ================

async function handleBuild(): Promise<void> {
    const project = await ensureProject();
    if (!project) {
        return;
    }
    await compiler.build(project);
}

async function handleRebuild(): Promise<void> {
    const project = await ensureProject();
    if (!project) {
        return;
    }
    compiler.clean(project);
    await compiler.build(project);
}

async function handleClean(): Promise<void> {
    const project = await ensureProject();
    if (!project) {
        return;
    }
    compiler.clean(project);
}

async function handleCompileSingleFile(item?: any): Promise<void> {
    let filePath: string | undefined;

    if (item && item.filePath) {
        // 从工程树中点击
        filePath = item.filePath;
    } else {
        // 从当前编辑器获取
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            filePath = editor.document.uri.fsPath;
        }
    }

    if (!filePath) {
        vscode.window.showWarningMessage('请先打开一个 C 或汇编源文件');
        return;
    }

    const ext = filePath.toLowerCase();
    if (!ext.endsWith('.c') && !ext.endsWith('.a51') && !ext.endsWith('.asm')) {
        vscode.window.showWarningMessage('单文件编译仅支持 .c、.a51、.asm 文件');
        return;
    }

    await compiler.compileSingleFile(filePath);
}

async function handleSetToolchainPath(): Promise<void> {
    const currentPath = vscode.workspace
        .getConfiguration('stc-extension')
        .get<string>('toolchainPath') || '';

    const newPath = await vscode.window.showInputBox({
        title: '设置 Keil C251 工具链路径',
        prompt: '请输入 C251.EXE / A251.EXE / L251.EXE / OH251.EXE 所在目录',
        value: currentPath,
        placeHolder: '例如: F:\\MPU\\C251\\',
        ignoreFocusOut: true,
    });

    if (newPath !== undefined && newPath !== currentPath) {
        const config = vscode.workspace.getConfiguration('stc-extension');
        await config.update('toolchainPath', newPath, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`工具链路径已设置为: ${newPath}`);
    }
}

async function handleNewProject(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('请先打开一个文件夹作为工作区');
        return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;

    const projectName = await vscode.window.showInputBox({
        title: '新建 STC 工程',
        prompt: '请输入工程名称',
        value: 'MySTCProject',
        ignoreFocusOut: true,
    });

    if (!projectName) {
        return;
    }

    // 创建工程目录结构
    const srcDir = path.join(rootPath, 'src');
    const incDir = path.join(rootPath, 'include');
    const outDir = path.join(rootPath, 'output');

    if (!fs.existsSync(srcDir)) {
        fs.mkdirSync(srcDir, { recursive: true });
    }
    if (!fs.existsSync(incDir)) {
        fs.mkdirSync(incDir, { recursive: true });
    }
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    // 创建 stc-project.json
    const projectConfig = {
        name: projectName,
        toolchainPath: vscode.workspace
            .getConfiguration('stc-extension')
            .get<string>('toolchainPath') || 'F:\\MPU\\C251\\',
        sources: ['src/**/*.c'],
        headers: ['include/**/*.h'],
        assembler: [],
        libraries: [],
        defines: ['STC32G12K128', 'FOSC_24000000'],
        output: {
            name: 'output',
            hex: true,
        },
        linker: {
            ramSize: 256,
            codeSize: 256,
        },
    };

    const configPath = path.join(rootPath, 'stc-project.json');
    fs.writeFileSync(configPath, JSON.stringify(projectConfig, null, 2));

    // 创建 main.c 模板
    const mainTemplate = `#include "STC32G.h"
#include "intrins.h"

void main(void)
{
    // 系统初始化
    while (1)
    {
        // 主循环
    }
}
`;
    fs.writeFileSync(path.join(srcDir, 'main.c'), mainTemplate);

    vscode.window.showInformationMessage(
        `工程 "${projectName}" 创建成功！\n源文件目录: src/\n头文件目录: include/\n输出目录: output/`
    );

    // 刷新工程树
    projectTreeProvider.refresh();

    // 打开 main.c
    const mainDoc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(srcDir, 'main.c'))
    );
    await vscode.window.showTextDocument(mainDoc);
}

// ================ 内部辅助 ================

/**
 * 确保有可用的工程数据
 */
async function ensureProject(): Promise<
    import('./uvprojParser').UvprojProject | undefined
> {
    const project = projectTreeProvider.getProject();
    if (project) {
        return project;
    }

    // 尝试自动检测 uvproj
    const uvprojPath = await uvprojParser.findProjectFile();
    if (uvprojPath) {
        const parsed = uvprojParser.parse(uvprojPath);
        if (parsed) {
            projectTreeProvider.setProject(parsed, true);
            return parsed;
        }
    }

    vscode.window.showWarningMessage(
        '未找到工程文件。请打开包含 .uvproj 的 Keil 工程文件夹，或运行"新建 STC 工程"'
    );
    return undefined;
}

/**
 * 激活时自动加载工程
 */
async function autoLoadProject(): Promise<void> {
    const uvprojPath = await uvprojParser.findProjectFile();
    if (uvprojPath) {
        const parsed = uvprojParser.parse(uvprojPath);
        if (parsed) {
            projectTreeProvider.setProject(parsed, true);
            vscode.window.showInformationMessage(
                `已加载 Keil 工程: ${parsed.name} (${parsed.device})`
            );
            return;
        }
    }

    // 回退：尝试 stc-project.json
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        const rootPath = workspaceFolders[0].uri.fsPath;
        const configPath = path.join(rootPath, 'stc-project.json');
        if (fs.existsSync(configPath)) {
            try {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                const groups = [
                    {
                        name: '源文件',
                        files: config.sources
                            ? config.sources.flatMap((p: string) => {
                                // 简单 glob 匹配
                                const results: string[] = [];
                                const ext = path.extname(p);
                                const dir = path.join(rootPath, path.dirname(p));
                                if (fs.existsSync(dir)) {
                                    const files = fs.readdirSync(dir);
                                    for (const f of files) {
                                        if (f.endsWith(ext)) {
                                            results.push(path.join(dir, f));
                                        }
                                    }
                                }
                                return results;
                            })
                            : [],
                    },
                ];
                const project = {
                    name: config.name || 'STCProject',
                    device: config.device || 'STC32G12K128',
                    toolchainPath:
                        config.toolchainPath ||
                        vscode.workspace
                            .getConfiguration('stc-extension')
                            .get<string>('toolchainPath') ||
                        'F:\\MPU\\C251\\',
                    groups,
                    libraries: [],
                    defines: config.defines || [],
                    includePaths: config.headers
                        ? config.headers.map((h: string) => path.resolve(rootPath, h))
                        : [],
                    outputDir: config.output?.name
                        ? path.join(rootPath, config.output.name)
                        : path.join(rootPath, 'output'),
                    c251Misc: config.c251Misc || 'xsmall',
                    a251Misc: config.a251Misc || '',
                    l251Misc: config.linker
                        ? `RS(${config.linker.ramSize || 256}) PL(${config.linker.codeSize || 256})`
                        : '',
                    l251DisableWarnings: '',
                    l251Classes: '',
                };
                projectTreeProvider.setProject(project, false);
                return;
            } catch {
                // 配置文件解析失败，回退到自动扫描
            }
        }
    }

    // 最终回退：自动扫描模式
    projectTreeProvider.refresh();
}
