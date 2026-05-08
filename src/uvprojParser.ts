import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { XMLParser } from 'fast-xml-parser';

export interface FileGroup {
    name: string;
    files: string[];
}

export interface UvprojProject {
    name: string;
    device: string;
    toolchainPath: string;
    groups: FileGroup[];
    defines: string[];
    includePaths: string[];
    outputDir: string;
    c251Misc: string;
    a251Misc: string;
    l251Misc: string;
}

export class UvprojParser {
    private xmlParser: XMLParser;

    constructor() {
        this.xmlParser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: '',
            textNodeName: '#text',
            parseTagValue: false,
            trimValues: true,
        });
    }

    /**
     * 在工作区根目录下扫描 .uvproj / .uvprojx 文件
     */
    async findProjectFile(): Promise<string | undefined> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return undefined;
        }

        const rootPath = workspaceFolders[0].uri.fsPath;
        const patterns = ['*.uvproj', '*.uvprojx'];
        for (const pattern of patterns) {
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(rootPath, pattern),
                undefined,
                1
            );
            if (files.length > 0) {
                return files[0].fsPath;
            }
        }
        return undefined;
    }

    /**
     * 解析 .uvproj / .uvprojx 文件
     */
    parse(uvprojPath: string): UvprojProject | undefined {
        try {
            const xmlContent = fs.readFileSync(uvprojPath, 'utf-8');
            const parsed = this.xmlParser.parse(xmlContent);

            const projectDir = path.dirname(uvprojPath);

            // .uvproj 结构: Project -> ProjectOpt -> Target / Group[]
            // .uvprojx 结构: Project -> Targets -> Target -> Groups -> Group
            // 先尝试查找 Targets 节点 (.uvprojx)，没有则查找 ProjectOpt (.uvproj)
            const targets = this.findNode(parsed, 'Targets');
            let target: any;
            let groups: any[];

            if (targets) {
                // .uvprojx 格式
                const targetList = this.findNode(targets, 'Target');
                if (!targetList) {
                    throw new Error('未找到 Target 节点');
                }
                target = Array.isArray(targetList) ? targetList[0] : targetList;
                groups = this.getAllNodes(target, 'Group');
            } else {
                // .uvproj 格式
                const projectOpt = this.findNode(parsed, 'ProjectOpt');
                if (!projectOpt) {
                    throw new Error('未找到 ProjectOpt 节点');
                }
                target = this.findNode(projectOpt, 'Target');
                if (!target) {
                    throw new Error('未找到 Target 节点');
                }
                groups = this.getAllNodes(projectOpt, 'Group');
            }

            // 提取工程名
            const name = this.getText(target, 'TargetName') || 'UnknownProject';

            // 提取芯片型号
            const device = this.getText(target, 'Device') || 'STC32G12K128';

            // 提取文件分组
            const fileGroups: FileGroup[] = [];
            if (groups) {
                for (const group of groups) {
                    const groupName = this.getText(group, 'GroupName') || 'Source Group';
                    const filesNode = this.findNode(group, 'Files');
                    const files: string[] = [];

                    if (filesNode) {
                        const fileList = this.getAllNodes(filesNode, 'File');
                        if (fileList) {
                            for (const file of fileList) {
                                let fileName = this.getText(file, 'FileName');
                                let filePath = this.getText(file, 'FilePath') || '';
                                if (fileName) {
                                    // 拼接完整路径
                                    const fullPath = path.resolve(projectDir, filePath, fileName);
                                    files.push(fullPath);
                                }
                            }
                        }
                    }
                    fileGroups.push({ name: groupName, files });
                }
            }

            // 提取 VariousControls（编译控制项）
            // 可能位于 Project -> TargetDriver -> VariousControls
            // 或 Project -> ProjectOpt -> Target -> VariousControls
            // 或 Targets -> Target -> TargetOption -> TargetCommonOption -> Cads -> VariousControls
            const variousControls = this.findVariousControls(parsed, target);

            // 提取宏定义
            const defineStr = this.getText(variousControls, 'Define') || '';
            const defines = defineStr
                .split(',')
                .map((d: string) => d.trim())
                .filter((d: string) => d.length > 0);

            // 提取包含路径
            const includePathStr = this.getText(variousControls, 'IncludePath') || '';
            const includePaths = includePathStr
                .split(';')
                .map((p: string) => p.trim())
                .filter((p: string) => p.length > 0)
                .map((p: string) => path.resolve(projectDir, p));

            // 提取输出目录
            const outputDirRaw = this.getText(variousControls, 'OutputDirectory') || '.\\output\\';
            const outputDir = path.resolve(projectDir, outputDirRaw);

            // 提取编译器/汇编器/链接器的额外参数
            const c251Misc = this.getText(variousControls, 'C251Misc') || '';
            const a251Misc = this.getText(variousControls, 'A251Misc') || '';
            const l251Misc = this.getText(variousControls, 'L251Misc') || '';

            return {
                name,
                device,
                toolchainPath: this.guessToolchainPath(parsed, projectDir),
                groups: fileGroups,
                defines,
                includePaths,
                outputDir,
                c251Misc,
                a251Misc,
                l251Misc,
            };
        } catch (error) {
            vscode.window.showErrorMessage(
                `解析 Keil 工程文件失败: ${error instanceof Error ? error.message : String(error)}`
            );
            return undefined;
        }
    }

    /**
     * 在解析后的 XML 对象中递归查找指定名称的节点
     */
    private findNode(obj: any, name: string): any {
        if (!obj || typeof obj !== 'object') {
            return undefined;
        }
        if (obj[name] !== undefined) {
            return obj[name];
        }
        for (const key of Object.keys(obj)) {
            const val = obj[key];
            if (typeof val === 'object' && !Array.isArray(val)) {
                const found = this.findNode(val, name);
                if (found !== undefined) {
                    return found;
                }
            }
        }
        return undefined;
    }

    /**
     * 获取所有匹配名称的节点（返回数组）
     */
    private getAllNodes(obj: any, name: string): any[] {
        const node = this.findNode(obj, name);
        if (!node) {
            return [];
        }
        return Array.isArray(node) ? node : [node];
    }

    /**
     * 从 XML 节点获取文本内容（处理 textNodeName 包装）
     */
    private getText(obj: any, name: string): string | undefined {
        const node = this.findNode(obj, name);
        if (!node) {
            return undefined;
        }
        if (typeof node === 'string') {
            return node;
        }
        if (typeof node === 'object') {
            if (node['#text'] !== undefined) {
                return node['#text'];
            }
            // 有些字段没有 #text 包装，直接是值
            if (typeof node === 'object' && Object.keys(node).length === 0) {
                return '';
            }
        }
        return String(node);
    }

    /**
     * 尝试从解析结果中查找 VariousControls
     */
    private findVariousControls(parsed: any, target: any): any {
        // 尝试路径 1: Target -> TargetOption -> TargetCommonOption -> Cads -> VariousControls
        const targetOption = this.findNode(target, 'TargetOption');
        if (targetOption) {
            const targetCommonOption = this.findNode(targetOption, 'TargetCommonOption');
            if (targetCommonOption) {
                const cads = this.findNode(targetCommonOption, 'Cads');
                if (cads) {
                    const vc = this.findNode(cads, 'VariousControls');
                    if (vc) {
                        return vc;
                    }
                }
            }
        }

        // 尝试路径 2: Project -> TargetDriver -> VariousControls
        const targetDriver = this.findNode(parsed, 'TargetDriver');
        if (targetDriver) {
            const vc = this.findNode(targetDriver, 'VariousControls');
            if (vc) {
                return vc;
            }
        }

        // 尝试路径 3: 全局查找 VariousControls
        const vc = this.findNode(parsed, 'VariousControls');
        if (vc) {
            return vc;
        }

        return {};
    }

    /**
     * 推测工具链路径
     */
    private guessToolchainPath(_parsed: any, _projectDir: string): string {
        // 先从 uvproj 中查找可能的路径
        // 如果找不到，使用默认配置
        const configPath = vscode.workspace.getConfiguration('stc-extension').get<string>('toolchainPath');
        return configPath || 'F:\\MPU\\C251\\';
    }
}
