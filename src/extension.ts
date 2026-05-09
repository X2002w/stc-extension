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
let currentUvprojPath: string | undefined;

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
    context.subscriptions.push(
        vscode.commands.registerCommand('stc-extension.configureC251', () =>
            vscode.commands.executeCommand(
                'workbench.action.openSettings',
                '@ext:stc-dev.stc-extension c251'
            )
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'stc-extension.addFileToGroup',
            (item) => handleAddFileToGroup(item)
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'stc-extension.createFileInGroup',
            (item) => handleCreateFileInGroup(item)
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'stc-extension.removeFileFromGroup',
            (item) => handleRemoveFileFromGroup(item)
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'stc-extension.addGroup',
            () => handleAddGroup()
        )
    );

    // 自动检测并加载工程
    const hasProject = await autoLoadProject();

    // 监听配置文件变化
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('stc-extension.toolchainPath')) {
                vscode.window.showInformationMessage('Keil C251 工具链路径已更新');
            }
        })
    );

    // 始终监听工程文件变化（用于自动加载 / 切换工程）
    setupProjectFileWatchers(context);

    // 仅在已有工程时启用轮询文件监听（避免大目录下持续高开销扫描）
    if (hasProject) {
        setupPollingWatcher(context);
    }

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

async function handleAddFileToGroup(item: any): Promise<void> {
    if (!currentUvprojPath) {
        vscode.window.showWarningMessage('此操作仅适用于 Keil 工程（.uvproj）');
        return;
    }

    const groupName: string = item?.label;
    if (!groupName) {
        return;
    }

    // 打开文件选择器
    const files = await vscode.window.showOpenDialog({
        title: `添加文件到分组 "${groupName}"`,
        canSelectMany: true,
        filters: {
            '源文件': ['c', 'h', 'a51', 'asm', 'lib'],
            '所有文件': ['*'],
        },
    });

    if (!files || files.length === 0) {
        return;
    }

    let success = 0;
    for (const file of files) {
        const ok = await uvprojParser.addFileToGroup(
            currentUvprojPath,
            groupName,
            file.fsPath
        );
        if (ok) {
            success++;
        }
    }

    if (success > 0) {
        // 重新解析工程以刷新树
        const parsed = uvprojParser.parse(currentUvprojPath);
        if (parsed) {
            projectTreeProvider.setProject(parsed, true);
        }
        vscode.window.showInformationMessage(
            `已添加 ${success} 个文件到分组 "${groupName}"`
        );
    }
}

async function handleAddGroup(): Promise<void> {
    if (!currentUvprojPath) {
        vscode.window.showWarningMessage('此操作仅适用于 Keil 工程（.uvproj）');
        return;
    }

    const groupName = await vscode.window.showInputBox({
        title: '新建分组',
        prompt: '请输入分组名称',
        placeHolder: 'new_group',
        validateInput: (value) => {
            if (!value.trim()) {
                return '分组名称不能为空';
            }
            return undefined;
        },
    });

    if (!groupName) {
        return;
    }

    const ok = await uvprojParser.addGroup(currentUvprojPath, groupName.trim());
    if (ok) {
        const parsed = uvprojParser.parse(currentUvprojPath);
        if (parsed) {
            projectTreeProvider.setProject(parsed, true);
        }
        vscode.window.showInformationMessage(`已创建分组 "${groupName.trim()}"`);
    }
}

async function handleCreateFileInGroup(item: any): Promise<void> {
    if (!currentUvprojPath) {
        vscode.window.showWarningMessage('此操作仅适用于 Keil 工程（.uvproj）');
        return;
    }

    const groupName: string = item?.label;
    if (!groupName) {
        return;
    }

    // 输入文件名
    const fileName = await vscode.window.showInputBox({
        title: `在分组 "${groupName}" 中新建文件`,
        prompt: '请输入文件名（如 led.c、isr.a51）',
        placeHolder: 'example.c',
        validateInput: (value) => {
            if (!value.trim()) {
                return '文件名不能为空';
            }
            const ext = path.extname(value).toLowerCase();
            if (!['.c', '.h', '.a51', '.asm'].includes(ext)) {
                return '仅支持 .c / .h / .a51 / .asm 文件';
            }
            return undefined;
        },
    });

    if (!fileName) {
        return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;
    const uvprojDir = path.dirname(currentUvprojPath);

    // 选择文件保存目录（默认 uvproj 所在目录）
    const dirs = await vscode.window.showOpenDialog({
        title: `选择 "${fileName}" 保存位置`,
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(uvprojDir),
    });

    if (!dirs || dirs.length === 0) {
        return;
    }

    const targetDir = dirs[0].fsPath;
    const fullPath = path.join(targetDir, fileName);

    // 检查是否已存在
    if (fs.existsSync(fullPath)) {
        const overwrite = await vscode.window.showWarningMessage(
            `文件 "${fileName}" 已存在，是否覆盖？`,
            { modal: true },
            '覆盖'
        );
        if (overwrite !== '覆盖') {
            return;
        }
    }

    // 头文件添加保护模板
    const ext = path.extname(fileName).toLowerCase();
    if (ext === '.h') {
        const guard = '__' + fileName.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_H__';
        fs.writeFileSync(fullPath, `#ifndef ${guard}\n#define ${guard}\n\n\n#endif\n`);
    } else {
        fs.writeFileSync(fullPath, '');
    }

    // 写入 uvproj 分组
    const ok = await uvprojParser.addFileToGroup(
        currentUvprojPath,
        groupName,
        fullPath
    );

    if (ok) {
        const parsed = uvprojParser.parse(currentUvprojPath);
        if (parsed) {
            projectTreeProvider.setProject(parsed, true);
        }
        vscode.window.showInformationMessage(
            `已在分组 "${groupName}" 中新建 "${fileName}"`
        );
        // 打开新文件
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
        await vscode.window.showTextDocument(doc);
    }
}

async function handleRemoveFileFromGroup(item: any): Promise<void> {
    if (!currentUvprojPath) {
        vscode.window.showWarningMessage('此操作仅适用于 Keil 工程（.uvproj）');
        return;
    }

    const filePath: string = item?.filePath;
    if (!filePath) {
        return;
    }

    // 获取当前工程数据以找到文件所属分组
    const project = projectTreeProvider.getProject();
    if (!project) {
        return;
    }

    let groupName: string | undefined;
    for (const group of project.groups) {
        if (group.files.includes(filePath)) {
            groupName = group.name;
            break;
        }
    }

    if (!groupName) {
        vscode.window.showWarningMessage('找不到文件所属的分组');
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        `从分组 "${groupName}" 中移除 "${path.basename(filePath)}"？\n（不会删除磁盘文件）`,
        { modal: true },
        '确认移除'
    );

    if (confirm !== '确认移除') {
        return;
    }

    const ok = await uvprojParser.removeFileFromGroup(
        currentUvprojPath,
        groupName,
        filePath
    );

    if (ok) {
        const parsed = uvprojParser.parse(currentUvprojPath);
        if (parsed) {
            projectTreeProvider.setProject(parsed, true);
        }
        vscode.window.showInformationMessage(
            `已从分组 "${groupName}" 中移除 "${path.basename(filePath)}"`
        );
    }
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
    const c251 = getC251Config();
    const projectConfig = {
        name: projectName,
        toolchainPath: vscode.workspace
            .getConfiguration('stc-extension')
            .get<string>('toolchainPath') || 'F:\\MPU\\C251\\',
        sources: ['src/**/*.c'],
        headers: c251.includePaths.map((p) => path.relative(rootPath, p).replace(/\\/g, '/') || p),
        assembler: [],
        libraries: [],
        defines: c251.defines,
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
            currentUvprojPath = uvprojPath;
            // 合并 VS Code 用户设置的额外头文件路径和宏定义
            const c251 = getC251Config();
            const mergedIncludePaths = [...new Set([...parsed.includePaths, ...c251.includePaths])];
            const mergedDefines = [...new Set([...parsed.defines, ...c251.defines])];
            // 如果用户配置了额外的 c251Misc，追加到 Keil 的 c251Misc 后面
            const extraMisc = vscode.workspace.getConfiguration('stc-extension').get<string>('c251Misc', '');
            if (extraMisc && !parsed.c251Misc.includes(extraMisc)) {
                parsed.c251Misc = parsed.c251Misc + ' ' + extraMisc;
            }
            parsed.includePaths = mergedIncludePaths;
            parsed.defines = mergedDefines;
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
 * 激活时自动加载工程，返回 true 表示成功加载了工程
 */
async function autoLoadProject(): Promise<boolean> {
    const uvprojPath = await uvprojParser.findProjectFile();
    if (uvprojPath) {
        const parsed = uvprojParser.parse(uvprojPath);
        if (parsed) {
            currentUvprojPath = uvprojPath;
            projectTreeProvider.setProject(parsed, true);
            vscode.window.showInformationMessage(
                `已加载 Keil 工程: ${parsed.name} (${parsed.device})`
            );
            return true;
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

                // 合并 VS Code 用户设置
                const c251 = getC251Config();
                const jsonDefines = config.defines || [];
                const jsonHeaders = (config.headers || []).map((h: string) => path.resolve(rootPath, h));
                const jsonMisc = config.c251Misc || '';

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
                    defines: [...new Set([...jsonDefines, ...c251.defines])],
                    includePaths: [...new Set([...jsonHeaders, ...c251.includePaths])],
                    outputDir: config.output?.name
                        ? path.join(rootPath, config.output.name)
                        : path.join(rootPath, 'output'),
                    c251Misc: jsonMisc || c251.controlString,
                    a251Misc: config.a251Misc || '',
                    l251Misc: config.linker
                        ? `RS(${config.linker.ramSize || 256}) PL(${config.linker.codeSize || 256})`
                        : '',
                    l251DisableWarnings: '',
                    l251Classes: '',
                };
                projectTreeProvider.setProject(project, false);
                return true;
            } catch {
                // 配置文件解析失败，回退到自动扫描
            }
        }
    }

    return false;
}

/**
 * 从 VS Code 用户设置读取 C251 编译配置
 */
function getC251Config(): {
    controlString: string;
    includePaths: string[];
    defines: string[];
} {
    const config = vscode.workspace.getConfiguration('stc-extension');
    const emphasis = config.get<string>('c251OptimizeEmphasis', 'SPEED');
    const memoryModel = config.get<string>('c251MemoryModel', 'XSMALL');
    const defines = config.get<string[]>('c251Defines', []);
    const extraMisc = config.get<string>('c251Misc', '');

    // 读取优化等级（DEFAULT 或 0-9）
    const optLevel = config.get<string>('c251OptimizeLevel', '0');

    // 读取警告等级（DEFAULT 或 0-3）
    const warnLevel = config.get<string>('c251WarningLevel', '3');

    // 解析 includePaths：支持 VS Code 配置数组和分号分隔字符串
    const rawPaths = config.get<string[]>('c251IncludePaths', []);
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const includePaths: string[] = [];
    for (const raw of rawPaths) {
        // 处理可能的合并路径（逗号或分号分隔）
        const parts = raw.split(/[;,]/).filter(Boolean);
        for (const part of parts) {
            const trimmed = part.trim().replace(/^["']|["']$/g, '');
            if (trimmed) {
                // 相对路径转绝对路径
                const absPath = path.isAbsolute(trimmed)
                    ? trimmed
                    : (workspaceRoot ? path.resolve(workspaceRoot, trimmed) : trimmed);
                includePaths.push(absPath);
            }
        }
    }

    // 构建 C251 控制字符串
    const controlParts = [memoryModel, 'INTR2'];

    // 警告等级：DEFAULT → 不生成；0-3 → WARNINGLEVEL(n)
    if (warnLevel !== 'DEFAULT') {
        controlParts.push(`WARNINGLEVEL(${warnLevel})`);
    }

    if (optLevel === 'DEFAULT') {
        // 默认优化：仅 SIZE 侧重时生成 OPTIMIZE(SIZE)；SPEED 不生成 OPTIMIZE
        if (emphasis === 'SIZE') {
            controlParts.push('OPTIMIZE(SIZE)');
        }
    } else {
        // 指定优化等级：生成 OPTIMIZE(n, emphasis)
        controlParts.push(`OPTIMIZE(${optLevel},${emphasis})`);
    }

    // 别名检查：关闭时生成 NOALIAS
    const aliasChecking = config.get<boolean>('c251AliasChecking', true);
    if (!aliasChecking) {
        controlParts.push('NOALIAS');
    }

    controlParts.push('BROWSE');
    if (extraMisc) {
        controlParts.push(extraMisc);
    }
    // 去重
    const controlString = [...new Set(controlParts)].join(' ');

    return { controlString, includePaths, defines };
}

/**
 * 监听工程文件（.uvproj / .uvprojx）的增删改，自动加载或切换工程
 * 使用 VS Code 原生 FileSystemWatcher，开销极低，始终启用
 */
function setupProjectFileWatchers(context: vscode.ExtensionContext): void {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return;
    }

    const onProjectChanged = (uri: vscode.Uri) => {
        currentUvprojPath = uri.fsPath;
        const parsed = uvprojParser.parse(uri.fsPath);
        if (parsed) {
            projectTreeProvider.setProject(parsed, true);
            // 如果之前没有工程（没有启动轮询），现在检测到了工程，启动轮询
            setupPollingWatcher(context);
        }
    };

    const onProjectCreated = (uri: vscode.Uri) => {
        // 工程文件新建时加载
        onProjectChanged(uri);
    };

    const onProjectDeleted = () => {
        currentUvprojPath = undefined;
        projectTreeProvider.clearProject();
    };

    const projectWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceFolders[0], '**/*.uvproj')
    );
    projectWatcher.onDidChange(onProjectChanged);
    projectWatcher.onDidCreate(onProjectCreated);
    projectWatcher.onDidDelete(onProjectDeleted);
    context.subscriptions.push(projectWatcher);

    const projectWatcher2 = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceFolders[0], '**/*.uvprojx')
    );
    projectWatcher2.onDidChange(onProjectChanged);
    projectWatcher2.onDidCreate(onProjectCreated);
    projectWatcher2.onDidDelete(onProjectDeleted);
    context.subscriptions.push(projectWatcher2);
}

let pollingWatcherSetup = false;

/**
 * 设置文件轮询，每 300ms 扫描项目目录检测文件增删，自动刷新工程树
 * 仅在已加载工程时启用，避免在无工程的大目录下持续高开销扫描
 */
function setupPollingWatcher(context: vscode.ExtensionContext): void {
    if (pollingWatcherSetup) {
        return;
    }
    pollingWatcherSetup = true;

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;
    const watchExts = ['.c', '.h', '.a51', '.asm', '.lib', '.obj'];
    let previousFiles = new Set(collectProjectFiles(rootPath, watchExts));

    const pollInterval = setInterval(() => {
        const currentFiles = new Set(collectProjectFiles(rootPath, watchExts));
        if (setsDiffer(previousFiles, currentFiles)) {
            previousFiles = currentFiles;
            if (currentUvprojPath) {
                const parsed = uvprojParser.parse(currentUvprojPath);
                if (parsed) {
                    projectTreeProvider.setProject(parsed, true);
                }
            } else {
                projectTreeProvider.refresh();
            }
        }
    }, 300);

    context.subscriptions.push({
        dispose: () => {
            clearInterval(pollInterval);
            pollingWatcherSetup = false;
        },
    });
}

/**
 * 递归扫描项目目录，收集所有匹配扩展名的文件路径
 */
function collectProjectFiles(dir: string, extensions: string[]): string[] {
    const results: string[] = [];
    const skipDirs = new Set(['node_modules', 'out', 'build', 'output', '.git', '.svn']);
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name.startsWith('.') || skipDirs.has(entry.name)) {
                    continue;
                }
                results.push(...collectProjectFiles(fullPath, extensions));
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (extensions.includes(ext)) {
                    results.push(fullPath);
                }
            }
        }
    } catch {
        // 忽略无权限目录
    }
    return results;
}

/**
 * 判断两个 Set 是否有差异
 */
function setsDiffer(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) {
        return true;
    }
    for (const item of a) {
        if (!b.has(item)) {
            return true;
        }
    }
    return false;
}
