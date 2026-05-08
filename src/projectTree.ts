import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { FileGroup, UvprojProject } from './uvprojParser';

/**
 * 工程树节点
 */
export class StcTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string,
        public readonly filePath?: string,
        public children?: StcTreeItem[]
    ) {
        super(label, collapsibleState);

        if (filePath) {
            this.resourceUri = vscode.Uri.file(filePath);
            this.tooltip = filePath;
            this.command = {
                command: 'vscode.open',
                title: '打开文件',
                arguments: [vscode.Uri.file(filePath)],
            };
        }

        // 根据类型设置图标
        switch (contextValue) {
            case 'project':
                this.iconPath = new vscode.ThemeIcon('project');
                break;
            case 'group':
                this.iconPath = new vscode.ThemeIcon('folder');
                break;
            case 'cSource':
                this.iconPath = new vscode.ThemeIcon('file-code');
                break;
            case 'asmSource':
                this.iconPath = new vscode.ThemeIcon('file-binary');
                break;
            case 'headerFile':
                this.iconPath = new vscode.ThemeIcon('file');
                break;
            case 'libFile':
                this.iconPath = new vscode.ThemeIcon('library');
                break;
            case 'outputFile':
                this.iconPath = new vscode.ThemeIcon('file-text');
                break;
            case 'section':
                this.iconPath = new vscode.ThemeIcon('symbol-folder');
                break;
        }
    }
}

/**
 * 工程树数据提供者
 */
export class StcProjectTreeProvider implements vscode.TreeDataProvider<StcTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<StcTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private project: UvprojProject | undefined;
    private fromKeil = false;
    private workspaceRoot: string | undefined;

    /**
     * 设置工程数据（来自 uvproj 解析）
     */
    setProject(project: UvprojProject, fromKeil: boolean): void {
        this.project = project;
        this.fromKeil = fromKeil;
        this.refresh();
    }

    /**
     * 获取当前工程数据
     */
    getProject(): UvprojProject | undefined {
        return this.project;
    }

    /**
     * 是否来自 Keil 工程文件
     */
    isFromKeil(): boolean {
        return this.fromKeil;
    }

    /**
     * 刷新树
     */
    refresh(): void {
        const folders = vscode.workspace.workspaceFolders;
        this.workspaceRoot = folders && folders.length > 0
            ? folders[0].uri.fsPath
            : undefined;
        this._onDidChangeTreeData.fire(undefined);
    }

    /**
     * 获取树节点
     */
    getTreeItem(element: StcTreeItem): vscode.TreeItem {
        return element;
    }

    /**
     * 获取子节点
     */
    getChildren(element?: StcTreeItem): StcTreeItem[] {
        if (!this.workspaceRoot) {
            return [new StcTreeItem(
                '未打开工作区',
                vscode.TreeItemCollapsibleState.None,
                'info'
            )];
        }

        if (!element) {
            return this.getRootChildren();
        }

        if (element.children) {
            return element.children;
        }

        return [];
    }

    /**
     * 获取根级别的子节点
     */
    private getRootChildren(): StcTreeItem[] {
        const items: StcTreeItem[] = [];

        if (this.project) {
            // 来自 uvproj 解析结果
            const subtitle = this.fromKeil ? ' (from Keil)' : '';
            const rootItem = new StcTreeItem(
                `${this.project.name}${subtitle}`,
                vscode.TreeItemCollapsibleState.Expanded,
                'project'
            );

            // 按分组列出源文件
            const groupChildren: StcTreeItem[] = [];
            for (const group of this.project.groups) {
                const fileItems: StcTreeItem[] = [];
                for (const filePath of group.files) {
                    const ext = path.extname(filePath).toLowerCase();
                    const contextValue = (ext === '.a51' || ext === '.asm')
                        ? 'asmSource'
                        : 'cSource';
                    fileItems.push(new StcTreeItem(
                        path.basename(filePath),
                        vscode.TreeItemCollapsibleState.None,
                        contextValue,
                        filePath
                    ));
                }
                groupChildren.push(new StcTreeItem(
                    group.name,
                    fileItems.length > 0
                        ? vscode.TreeItemCollapsibleState.Expanded
                        : vscode.TreeItemCollapsibleState.None,
                    'group',
                    undefined,
                    fileItems
                ));
            }
            rootItem.children = groupChildren;

            // 额外分区：头文件、库文件
            const headerFiles = this.findFiles('**/*.h');
            const libFiles = this.findFiles('**/*.lib');

            if (headerFiles.length > 0) {
                groupChildren.push(new StcTreeItem(
                    '头文件',
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'section',
                    undefined,
                    headerFiles.map((f) => new StcTreeItem(
                        path.basename(f),
                        vscode.TreeItemCollapsibleState.None,
                        'headerFile',
                        f
                    ))
                ));
            }

            if (libFiles.length > 0) {
                groupChildren.push(new StcTreeItem(
                    '库文件',
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'section',
                    undefined,
                    libFiles.map((f) => new StcTreeItem(
                        path.basename(f),
                        vscode.TreeItemCollapsibleState.None,
                        'libFile',
                        f
                    ))
                ));
            }

            items.push(rootItem);
        } else {
            // 无工程数据，自动扫描
            const autoItem = new StcTreeItem(
                '自动扫描 (未检测到工程文件)',
                vscode.TreeItemCollapsibleState.Expanded,
                'project'
            );

            const cFiles = this.findFiles('**/*.c');
            const hFiles = this.findFiles('**/*.h');
            const asmFiles = [...this.findFiles('**/*.a51'), ...this.findFiles('**/*.asm')];
            const libFiles = this.findFiles('**/*.lib');

            const children: StcTreeItem[] = [];

            if (cFiles.length > 0) {
                children.push(new StcTreeItem(
                    'C 源文件',
                    vscode.TreeItemCollapsibleState.Expanded,
                    'section',
                    undefined,
                    cFiles.map((f) => new StcTreeItem(
                        path.relative(this.workspaceRoot!, f),
                        vscode.TreeItemCollapsibleState.None,
                        'cSource',
                        f
                    ))
                ));
            }
            if (asmFiles.length > 0) {
                children.push(new StcTreeItem(
                    '汇编文件',
                    vscode.TreeItemCollapsibleState.Expanded,
                    'section',
                    undefined,
                    asmFiles.map((f) => new StcTreeItem(
                        path.relative(this.workspaceRoot!, f),
                        vscode.TreeItemCollapsibleState.None,
                        'asmSource',
                        f
                    ))
                ));
            }
            if (hFiles.length > 0) {
                children.push(new StcTreeItem(
                    '头文件',
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'section',
                    undefined,
                    hFiles.map((f) => new StcTreeItem(
                        path.relative(this.workspaceRoot!, f),
                        vscode.TreeItemCollapsibleState.None,
                        'headerFile',
                        f
                    ))
                ));
            }
            if (libFiles.length > 0) {
                children.push(new StcTreeItem(
                    '库文件',
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'section',
                    undefined,
                    libFiles.map((f) => new StcTreeItem(
                        path.relative(this.workspaceRoot!, f),
                        vscode.TreeItemCollapsibleState.None,
                        'libFile',
                        f
                    ))
                ));
            }

            autoItem.children = children;
            items.push(autoItem);
        }

        return items;
    }

    /**
     * 在工作区中搜索匹配 glob 的文件
     */
    private findFiles(pattern: string): string[] {
        if (!this.workspaceRoot) {
            return [];
        }
        try {
            const results: string[] = [];
            this.searchRecursive(this.workspaceRoot, pattern, results);
            return results.sort();
        } catch {
            return [];
        }
    }

    /**
     * 递归搜索文件
     */
    private searchRecursive(dir: string, pattern: string, results: string[]): void {
        // 简单的后缀匹配实现，避免复杂的 glob 逻辑
        const ext = path.extname(pattern).toLowerCase();
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                // 跳过隐藏目录和 node_modules / out
                if (entry.isDirectory()) {
                    if (
                        entry.name.startsWith('.') ||
                        entry.name === 'node_modules' ||
                        entry.name === 'out' ||
                        entry.name === 'build' ||
                        entry.name === 'output'
                    ) {
                        continue;
                    }
                    this.searchRecursive(fullPath, pattern, results);
                } else if (entry.isFile() && entry.name.toLowerCase().endsWith(ext)) {
                    results.push(fullPath);
                }
            }
        } catch {
            // 忽略无权限目录
        }
    }
}
