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
    projectDir: string;         // 工程根目录（uvproj 文件所在目录或工作区根目录），工具链从此目录执行
    groups: FileGroup[];
    libraries: string[];        // .lib / .obj 文件，直接传给链接器，不需要编译
    defines: string[];
    includePaths: string[];
    outputDir: string;
    c251Misc: string;
    a251Misc: string;
    a251IncludePaths: string[];  // A251 汇编器 include 路径（从 Ax51 > VariousControls > IncludePath 提取）
    l251Misc: string;
    l251DisableWarnings: string;  // 屏蔽的 L251 警告编号，如 "15,16,57"
    l251Classes: string;          // CLASSES 内存布局指令，如 "EDATA (0x0-0xFFF), HDATA (0x0-0xFFF)"
    /** 从 uvproj 提取的独立 C251 编译设置（用于 VS Code 配置覆盖） */
    memoryModel: string;        // 'small' | 'xsmall' | 'compact' | 'large' | ''
    puMode: string;             // 'source' | 'binary' | ''
    romSize: string;            // 'small' | 'compact' | 'medium' | 'large' | 'huge' | ''
    xtalFrequency: number;      // MHz, 0 表示未设置
    optimLevel: string;         // '0'-'9' | ''
    optimEmphasis: string;      // 'SPEED' | 'SIZE' | ''
    c251MiscControls: string;   // 原始 MiscControls (Keil uVision 自由文本, 不含优化/内存模型等自动标志)
    /** 从 uvproj C251 节点提取的独立 XML 元素（非 MiscControls） */
    warningLevel: string;       // '0'-'3' Warnings 元素, 空字符串表示未设置 (对应 WARNINGLEVEL 控制字)
    browseInfo: boolean;        // BrowseInfo 元素, "1"=生成浏览信息 (对应 BROWSE 控制字)
    debugInfo: boolean;         // Debug 元素, "1"=生成调试信息 (对应 DEBUG 控制字)
    aliasChecking: boolean;     // AliasChecking 元素, "0"=禁用别名检查 (对应 NOALIAS 控制字), 默认开启
    hexFormat: string;          // 'HEX-80' | 'HEX-386', 从 TargetCommonOption 的 HexFormatSelection 提取
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

    async findProjectFile(): Promise<string | undefined> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return undefined;
        }

        const rootPath = workspaceFolders[0].uri.fsPath;
        const patterns = ['**/*.uvproj', '**/*.uvprojx'];
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

    parse(uvprojPath: string): UvprojProject | undefined {
        try {
            const xmlContent = fs.readFileSync(uvprojPath, 'utf-8');
            const parsed = this.xmlParser.parse(xmlContent);
            const projectDir = path.dirname(uvprojPath);

            // === 1. 找 Target 节点 ===
            // 格式1 (新版 uvproj): Project > Targets > Target
            // 格式2 (旧版 uvproj): Project > ProjectOpt > Target
            const targetsNode = this.findNode(parsed, 'Targets');
            let target: any;

            if (targetsNode) {
                const targetList = this.findNode(targetsNode, 'Target');
                if (!targetList) {
                    throw new Error('未找到 Target 节点');
                }
                target = Array.isArray(targetList) ? targetList[0] : targetList;
            } else {
                const projectOpt = this.findNode(parsed, 'ProjectOpt');
                if (!projectOpt) {
                    throw new Error('未找到 ProjectOpt 节点');
                }
                target = this.findNode(projectOpt, 'Target');
                if (!target) {
                    throw new Error('未找到 Target 节点');
                }
            }

            // === 2. 提取基本属性 ===
            const name = this.getText(target, 'TargetName') || 'UnknownProject';
            const device = this.getText(
                this.findNode(target, 'TargetOption'),
                'Device'
            ) || this.getText(target, 'Device') || 'STC32G12K128';

            // === 3. 提取 TargetCommonOption (输出目录等) ===
            const targetOption = this.findNode(target, 'TargetOption');
            const tco = targetOption
                ? this.findNode(targetOption, 'TargetCommonOption')
                : undefined;

            // 输出目录
            const outputDirRaw = this.getText(tco, 'OutputDirectory') || '.\\output\\';
            const outputDir = path.resolve(projectDir, outputDirRaw);

            // 提取 HEX 格式: HexFormatSelection: 0=HEX-80, 1=HEX-386
            let uvHexFormat = 'HEX-386';  // STC32G 默认使用 HEX-386
            const hexFormatSel = this.getText(tco, 'HexFormatSelection') || '';
            if (hexFormatSel === '0') { uvHexFormat = 'HEX-80'; }
            else if (hexFormatSel === '1') { uvHexFormat = 'HEX-386'; }

            // 从 TargetCommonOption 的 IncludePath 提取（如果 C251 下的为空则用它）
            const tcoIncludePathStr = this.getText(tco, 'IncludePath') || '';

            // === 4. 提取 C251/A251/L251 编译参数 ===
            // 实际结构: TargetOption > Target251 > C251/Ax51/Lx51
            const target251 = targetOption
                ? this.findNode(targetOption, 'Target251')
                : undefined;

            let c251Misc = '';
            let a251Misc = '';
            let l251Misc = '';
            let l251DisableWarnings = '';
            let l251Classes = '';
            let defines: string[] = [];
            let includePaths: string[] = [];
            let a251IncludePaths: string[] = [];

            // 独立设置字段（从 uvproj 提取，供 VS Code 配置覆盖）
            let uvMemoryModel = '';
            let uvPuMode = '';
            let uvRomSize = '';
            let uvXtalFrequency = 0;
            let uvOptimLevel = '';
            let uvOptimEmphasis = '';
            let uvC251MiscControls = '';
            let uvWarningLevel = '';
            let uvBrowseInfo = false;
            let uvDebugInfo = false;
            let uvAliasChecking = true;  // Keil 默认开启别名检查

            if (target251) {
                // C251 编译器参数
                const c251Node = this.findNode(target251, 'C251');
                if (c251Node) {
                    const c251VC = this.findNode(c251Node, 'VariousControls');
                    uvC251MiscControls = this.getText(c251VC, 'MiscControls') || '';
                    c251Misc = uvC251MiscControls;

                    const c251IncludePath = this.getText(c251VC, 'IncludePath') || '';
                    const c251Define = this.getText(c251VC, 'Define') || '';

                    includePaths = this.parseSemicolonList(
                        c251IncludePath || tcoIncludePathStr,
                        projectDir
                    );
                    defines = this.parseCommaList(c251Define);

                    // 提取 C251 优化设置: Optim(优化级别) + SizSpd(0=SIZE, 1=SPEED)
                    uvOptimLevel = this.getText(c251Node, 'Optim') || '';
                    const sizSpd = this.getText(c251Node, 'SizSpd') || '';
                    if (sizSpd === '0') { uvOptimEmphasis = 'SIZE'; }
                    else if (sizSpd === '1') { uvOptimEmphasis = 'SPEED'; }

                    if (uvOptimLevel) {
                        const emphasis = sizSpd === '0' ? 'size' : 'speed';
                        const optimFlag = `optimize(${uvOptimLevel}, ${emphasis})`;
                        c251Misc = optimFlag + (c251Misc ? ' ' + c251Misc : '');
                    }

                    // 提取 C251 独立 XML 设置（Keil 不放在 MiscControls 中的单独元素）
                    uvWarningLevel = this.getText(c251Node, 'Warnings') || '';
                    uvBrowseInfo = this.getText(c251Node, 'BrowseInfo') === '1';
                    uvDebugInfo = this.getText(c251Node, 'Debug') === '1';
                    uvAliasChecking = this.getText(c251Node, 'AliasChecking') !== '0';

                    // 将独立 XML 设置对应的控制字追加到 c251Misc
                    if (uvWarningLevel && /^[0-3]$/.test(uvWarningLevel)) {
                        c251Misc = c251Misc + ` warninglevel(${uvWarningLevel})`;
                    }
                    if (uvBrowseInfo) {
                        c251Misc = c251Misc + ' browse';
                    }
                    if (uvDebugInfo) {
                        c251Misc = c251Misc + ' debug';
                    }
                    if (!uvAliasChecking) {
                        c251Misc = c251Misc + ' noalias';
                    }
                }

                // A251 汇编器参数
                const ax51Node = this.findNode(target251, 'Ax51');
                if (ax51Node) {
                    const a251VC = this.findNode(ax51Node, 'VariousControls');
                    a251Misc = this.getText(a251VC, 'MiscControls') || '';
                    // 提取 A251 独立的 IncludePath
                    const a251IncludePath = this.getText(a251VC, 'IncludePath') || '';
                    a251IncludePaths = this.parseSemicolonList(a251IncludePath, projectDir);
                }

                // L251 链接器参数
                const lx51Node = this.findNode(target251, 'Lx51');
                if (lx51Node) {
                    l251Misc = this.getText(lx51Node, 'MiscControls') || '';
                    // 读取需要屏蔽的警告编号（如 15,16,57 对应 UNCALLED FUNCTION/SEGMENT）
                    l251DisableWarnings = this.getText(lx51Node, 'DisableWarningNumbers') || '';
                }

                // 从 Target251Misc 提取芯片配置和片上内存布局
                // 注意：C251 V5.60 所有控制字必须小写！
                const target251Misc = this.findNode(target251, 'Target251Misc');
                if (target251Misc) {
                    const memoryModel = this.getText(target251Misc, 'MemoryModel');
                    const uSrcBin = this.getText(target251Misc, 'uSrcBin');

                    // MemoryModel → C251 编译参数（小写）
                    // C251 映射: 0=small, 2=compact, 3=xsmall, 4=large
                    const modelFlags: Record<string, string> = {
                        '0': 'small', '2': 'compact', '3': 'xsmall', '4': 'large',
                    };

                    const flags: string[] = [];
                    if (memoryModel && modelFlags[memoryModel]) {
                        uvMemoryModel = modelFlags[memoryModel];
                        flags.push(uvMemoryModel);
                    }

                    // uSrcBin=0 表示 BINARY 模式 (需要 modbin 控制字)
                    // uSrcBin=1 表示 SOURCE 模式 (C251 默认，不需要额外控制字)
                    uvPuMode = (uSrcBin === '0') ? 'binary' : 'source';
                    if (uSrcBin === '0') {
                        flags.push('modbin');
                    }

                    // intr2: C251 中断向量格式（Keil 默认为 C251 项目添加）
                    flags.push('intr2');

                    const autoFlags = flags.join(' ');
                    c251Misc = autoFlags + (c251Misc ? ' ' + c251Misc : '');

                    // 提取 RomSize → C251 rom() 指令
                    const romSizeRaw = this.getText(target251Misc, 'RomSize');
                    const romSizeMap: Record<string, string> = {
                        '0': 'small', '1': 'compact', '2': 'medium', '3': 'large', '4': 'huge',
                    };
                    if (romSizeRaw && romSizeMap[romSizeRaw]) {
                        uvRomSize = romSizeMap[romSizeRaw];
                    }

                    // 提取 XTAL (晶振频率 MHz)
                    const xtalRaw = this.getText(target251Misc, 'XTAL');
                    if (xtalRaw) {
                        uvXtalFrequency = parseFloat(xtalRaw) || 0;
                    }

                    // 从 OnChipMemories 生成 L251 CLASSES 指令（内存布局）
                    // C251 架构中 EDATA 和 HDATA 都映射到内部 IRAM
                    const onChip = this.findNode(target251Misc, 'OnChipMemories');
                    if (onChip) {
                        const iram = this.findNode(onChip, 'IRAM');
                        if (iram) {
                            const start = this.getText(iram, 'StartAddress') || '0x0';
                            const size = this.getText(iram, 'Size');
                            if (size && parseInt(size, 16) > 0) {
                                const endAddr = '0x' + (parseInt(start, 16) + parseInt(size, 16) - 1).toString(16).toUpperCase();
                                const range = `${start}-${endAddr}`;
                                l251Classes = `EDATA (${range}), HDATA (${range})`;
                            }
                        }
                    }
                    // 注意：RomSize 只影响 C251 编译器参数，L251 通过设备数据库 (STC.CDB) 获取 ROM 配置
                    // 不向 l251Misc 添加 rom() 指令，因为 L251 不支持该指令
                }
            } else {
                // 回退：旧格式的 VariousControls
                const vc = this.findNode(parsed, 'VariousControls');
                if (vc) {
                    c251Misc = this.getText(vc, 'C251Misc') || '';
                    a251Misc = this.getText(vc, 'A251Misc') || '';
                    l251Misc = this.getText(vc, 'L251Misc') || '';
                    defines = this.parseCommaList(this.getText(vc, 'Define') || '');
                    includePaths = this.parseSemicolonList(
                        this.getText(vc, 'IncludePath') || '',
                        projectDir
                    );
                }
            }

            // 如果 C251Misc 为空，给安全的默认值
            if (!c251Misc) {
                c251Misc = 'large';
            }

            // === 5. 提取文件分组 ===
            // 实际结构: Target > Groups > Group > Files > File
            // FileType: 1=C源文件, 2=汇编, 3=目标文件(.obj), 4=库文件(.lib), 5=头文件
            const fileGroups: FileGroup[] = [];
            const libraryFiles: string[] = [];
            const groupsContainer = this.findNode(target, 'Groups');
            let groupNodes: any[] = [];

            if (groupsContainer) {
                const grp = this.findNode(groupsContainer, 'Group');
                if (grp) {
                    groupNodes = Array.isArray(grp) ? grp : [grp];
                }
            } else {
                // 回退：Group 可能在 ProjectOpt 下（旧格式）
                const projectOpt = this.findNode(parsed, 'ProjectOpt');
                if (projectOpt) {
                    const grp = this.findNode(projectOpt, 'Group');
                    if (grp) {
                        groupNodes = Array.isArray(grp) ? grp : [grp];
                    }
                }
            }

            for (const group of groupNodes) {
                const groupName = this.getText(group, 'GroupName') || 'Source Group';
                const files: string[] = [];
                const filesNode = this.findNode(group, 'Files');

                if (filesNode) {
                    let fileList = this.findNode(filesNode, 'File');
                    if (fileList) {
                        fileList = Array.isArray(fileList) ? fileList : [fileList];

                        for (const file of fileList) {
                            const filePath = this.getText(file, 'FilePath') || '';
                            const fileName = this.getText(file, 'FileName') || '';
                            const fileType = this.getText(file, 'FileType') || '1';

                            if (!filePath && !fileName) {
                                continue;
                            }

                            const realPath = this.resolveFilePath(
                                projectDir,
                                filePath,
                                fileName
                            );
                            if (!realPath) {
                                continue;
                            }

                            // FileType 3 (目标文件) 和 4 (库文件) → 直接传给链接器
                            if (fileType === '3' || fileType === '4') {
                                libraryFiles.push(realPath);
                            } else {
                                files.push(realPath);
                            }
                        }
                    }
                }
                // 即使空白分组也保留，以便树中显示
                fileGroups.push({ name: groupName, files });
            }

            return {
                name,
                device,
                toolchainPath: this.guessToolchainPath(),
                projectDir,
                groups: fileGroups,
                libraries: libraryFiles,
                defines,
                includePaths,
                outputDir,
                c251Misc,
                a251Misc,
                a251IncludePaths,
                l251Misc,
                l251DisableWarnings,
                l251Classes,
                memoryModel: uvMemoryModel,
                puMode: uvPuMode,
                romSize: uvRomSize,
                xtalFrequency: uvXtalFrequency,
                optimLevel: uvOptimLevel,
                optimEmphasis: uvOptimEmphasis,
                c251MiscControls: uvC251MiscControls,
                warningLevel: uvWarningLevel,
                browseInfo: uvBrowseInfo,
                debugInfo: uvDebugInfo,
                aliasChecking: uvAliasChecking,
                hexFormat: uvHexFormat,
            };
        } catch (error) {
            vscode.window.showErrorMessage(
                `解析 Keil 工程文件失败: ${error instanceof Error ? error.message : String(error)}`
            );
            return undefined;
        }
    }

    /**
     * 向 uvproj 工程文件中添加文件到指定分组
     * @returns 是否成功
     */
    async addFileToGroup(
        uvprojPath: string,
        groupName: string,
        filePath: string
    ): Promise<boolean> {
        try {
            const projectDir = path.dirname(uvprojPath);
            let xml = fs.readFileSync(uvprojPath, 'utf-8');

            // 计算相对路径（完整路径，含文件名，保持反斜杠与 Keil 格式一致）
            const relPath = path.relative(projectDir, filePath);
            const fileName = path.basename(filePath);
            const ext = path.extname(filePath).toLowerCase();

            // FileType 映射（与 Keil 一致）
            // 1=C源文件, 2=汇编, 4=库文件, 5=头文件
            const fileTypeMap: Record<string, string> = {
                '.c': '1', '.a51': '2', '.asm': '2',
                '.lib': '4', '.h': '5',
            };
            const fileType = fileTypeMap[ext] || '1';

            // 定位目标分组: <GroupName>groupName</GroupName>
            const escapedGroup = this.escapeRegex(groupName);
            const groupPattern = new RegExp(
                `(<GroupName>\\s*${escapedGroup}\\s*</GroupName>)`
            );
            const groupMatch = xml.match(groupPattern);
            if (!groupMatch || groupMatch.index === undefined) return false;

            const groupStart = groupMatch.index;
            // Groups 不嵌套，直接找下一个 </Group>
            const groupEnd = xml.indexOf('</Group>', groupStart);
            if (groupEnd < 0) return false;

            // 提取该分组内的文本片段
            const groupContent = xml.substring(groupStart, groupEnd);

            // 检查文件是否已在该分组中（只在当前分组内检查）
            const escapedName = this.escapeRegex(fileName);
            if (new RegExp(`<FileName>\\s*${escapedName}\\s*</FileName>`).test(groupContent)) {
                return true;
            }

            // 检测缩进风格（从 GroupName 所在行获取）
            const lineStart = xml.lastIndexOf('\n', groupStart) + 1;
            const indent1 = xml.substring(lineStart, lineStart + (groupStart - lineStart));
            const indent2 = indent1 + '\t';
            const indent3 = indent2 + '\t';
            const indent4 = indent3 + '\t';

            // 构造 File 节点（与 Keil 格式一致：FileName → FileType → FilePath）
            const fileEntry = [
                `${indent3}<File>`,
                `${indent4}<FileName>${this.xmlEscape(fileName)}</FileName>`,
                `${indent4}<FileType>${fileType}</FileType>`,
                `${indent4}<FilePath>${this.xmlEscape(relPath)}</FilePath>`,
                `${indent3}</File>`,
            ].join('\n');

            // 查找分组内的 <Files> 节点
            const filesMatch = groupContent.match(/<Files>/);
            let newXml: string;

            if (filesMatch) {
                // Files 节点存在，在 </Files> 之前插入新文件
                const filesStart = groupStart + filesMatch.index!;
                const filesEnd = xml.indexOf('</Files>', filesStart);
                if (filesEnd < 0) return false;

                newXml = xml.substring(0, filesEnd) + '\n' + fileEntry + '\n' + indent2 + xml.substring(filesEnd);
            } else {
                // 没有 Files 节点，在 </Group> 之前创建
                newXml =
                    xml.substring(0, groupEnd) +
                    '\n' + indent2 + '<Files>' +
                    '\n' + fileEntry + '\n' + indent2 + '</Files>\n' + indent1 +
                    xml.substring(groupEnd);
            }

            fs.writeFileSync(uvprojPath, newXml);
            return true;
        } catch (error) {
            vscode.window.showErrorMessage(
                `添加文件到分组失败: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
        }
    }

    /**
     * 向 uvproj 工程文件中添加新分组
     */
    async addGroup(
        uvprojPath: string,
        newGroupName: string
    ): Promise<boolean> {
        try {
            let xml = fs.readFileSync(uvprojPath, 'utf-8');

            // 检查分组是否已存在
            const escapedName = this.escapeRegex(newGroupName);
            const existPattern = new RegExp(
                `<GroupName>\\s*${escapedName}\\s*</GroupName>`
            );
            if (existPattern.test(xml)) {
                vscode.window.showWarningMessage(`分组 "${newGroupName}" 已存在`);
                return false;
            }

            // 定位 </Groups> 标签（在最后一个 </Group> 之后）
            const groupsEnd = xml.indexOf('</Groups>');
            if (groupsEnd < 0) return false;

            // 从 </Groups> 往前找最后一个 </Group> 来检测缩进
            const lastGroupEnd = xml.lastIndexOf('</Group>', groupsEnd);
            if (lastGroupEnd < 0) return false;

            // 检测缩进
            const lineStart = xml.lastIndexOf('\n', lastGroupEnd) + 1;
            const indent1 = xml.substring(lineStart, lineStart + (lastGroupEnd - lineStart));
            const indent2 = indent1 + '\t';
            const indent3 = indent2 + '\t';

            // 构造新分组（含空 Files 节点，与 Keil 格式一致）
            const newGroup = [
                `${indent1}<Group>`,
                `${indent2}<GroupName>${this.xmlEscape(newGroupName)}</GroupName>`,
                `${indent2}<Files>`,
                `${indent2}</Files>`,
                `${indent1}</Group>`,
            ].join('\n');

            // 在 </Groups> 之前插入新分组
            const newXml = xml.substring(0, groupsEnd) +
                newGroup + '\n' + indent1 +
                xml.substring(groupsEnd);

            fs.writeFileSync(uvprojPath, newXml);
            return true;
        } catch (error) {
            vscode.window.showErrorMessage(
                `添加分组失败: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
        }
    }

    /**
     * 从 uvproj 工程文件中删除指定分组中的文件（文本操作，保留原格式）
     */
    async removeFileFromGroup(
        uvprojPath: string,
        groupName: string,
        filePath: string
    ): Promise<boolean> {
        try {
            let xml = fs.readFileSync(uvprojPath, 'utf-8');
            const fileName = path.basename(filePath);
            const escapedName = this.escapeRegex(fileName);

            // 定位文件条目: <FileName>fileName</FileName>
            const namePattern = new RegExp(
                `<FileName>\\s*${escapedName}\\s*</FileName>`,
                'g'
            );
            const nameMatch = namePattern.exec(xml);
            if (!nameMatch || nameMatch.index === undefined) return false;

            // 找到包含该 FileName 的 <File>...</File> 块
            const fileNamePos = nameMatch.index;
            const fileStart = xml.lastIndexOf('<File>', fileNamePos);
            const fileEnd = xml.indexOf('</File>', fileNamePos);
            if (fileStart < 0 || fileEnd < 0) return false;

            // 包含 </File> 后的换行
            let endPos = fileEnd + '</File>'.length;
            if (xml[endPos] === '\r') endPos++;
            if (xml[endPos] === '\n') endPos++;

            const before = xml.substring(0, fileStart);
            const after = xml.substring(endPos);
            xml = before + after;

            fs.writeFileSync(uvprojPath, xml);
            return true;
        } catch (error) {
            vscode.window.showErrorMessage(
                `从分组删除文件失败: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
        }
    }

    /** 转义 XML 特殊字符 */
    private xmlEscape(s: string): string {
        return s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** 转义正则特殊字符 */
    private escapeRegex(s: string): string {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * 解析文件真实路径
     * FilePath 在 Keil uvproj 中通常已经是包含文件名的完整相对路径
     * 如: ..\..\Libraries\libraries\board.c
     */
    private resolveFilePath(
        projectDir: string,
        filePath: string,
        fileName: string
    ): string | undefined {
        filePath = filePath.trim().replace(/^["']|["']$/g, '');
        fileName = fileName.trim().replace(/^["']|["']$/g, '');

        const candidates: string[] = [];

        // 策略1: FilePath 本身就是完整路径（含文件名）
        // 大多数 Keil uvproj 中 FilePath 已经是完整相对路径
        if (filePath) {
            candidates.push(path.resolve(projectDir, filePath));
            // 如果 FilePath 是绝对路径
            if (path.isAbsolute(filePath)) {
                candidates.push(filePath);
            }
        }

        // 策略2: FilePath + FileName 拼接（FilePath 是目录的情况）
        if (filePath && fileName) {
            // 检查 filePath 是否以常见目录分隔符结尾
            if (filePath.endsWith('/') || filePath.endsWith('\\')) {
                candidates.push(path.resolve(projectDir, filePath, fileName));
            } else {
                // 检查 filePath 是否有扩展名，没有则可能是目录
                const ext = path.extname(filePath).toLowerCase();
                if (!ext) {
                    candidates.push(path.resolve(projectDir, filePath, fileName));
                }
            }
        }

        // 策略3: 只用 fileName 搜索
        if (fileName) {
            candidates.push(path.resolve(projectDir, fileName));
        }

        // 逐个验证
        const unique = [...new Set(candidates.map((p) => path.normalize(p)))];
        for (const fullPath of unique) {
            if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                return fullPath;
            }
        }

        // 回退：在 projectDir 下递归搜索同名文件
        if (fileName) {
            const searchName = path.basename(fileName);
            return this.searchFileRecursive(projectDir, searchName);
        }
        if (filePath) {
            const searchName = path.basename(filePath);
            return this.searchFileRecursive(projectDir, searchName);
        }

        return undefined;
    }

    private searchFileRecursive(dir: string, targetName: string, maxDepth = 5): string | undefined {
        return this._search(dir, targetName, maxDepth);
    }

    private _search(dir: string, targetName: string, maxDepth: number): string | undefined {
        if (maxDepth <= 0) return undefined;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (
                        entry.name.startsWith('.') ||
                        entry.name === 'node_modules' ||
                        entry.name === 'output' ||
                        entry.name === 'build'
                    ) {
                        continue;
                    }
                    const found = this._search(fullPath, targetName, maxDepth - 1);
                    if (found) return found;
                } else if (entry.isFile()) {
                    if (
                        entry.name === targetName ||
                        entry.name.toLowerCase() === targetName.toLowerCase()
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

    private parseSemicolonList(str: string, baseDir: string): string[] {
        if (!str) return [];
        const rawPaths = str
            .split(';')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);

        const result: string[] = [];
        for (const raw of rawPaths) {
            const resolved = path.resolve(baseDir, raw);
            if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
                result.push(resolved);
                continue;
            }

            // 目录不存在，尝试修正路径
            const fixed = this.fixIncludePath(baseDir, raw);
            if (fixed) {
                result.push(fixed);
            }
            // 如果修正也失败，仍然加入原始路径（C251 会报错但不会漏掉）
            else {
                result.push(resolved);
            }
        }
        return result;
    }

    /**
     * 尝试修正不存在的 include 路径
     * 例如: ..\USER\inc (相对 uvproj 的 Project 上级) → .\USER\inc (就在 uvproj 同级)
     */
    private fixIncludePath(baseDir: string, rawPath: string): string | undefined {
        // 把 rawPath 中的 ..\ 替换为 .\ 的各种组合，逐个尝试
        const normalized = rawPath.replace(/\\/g, '/');
        const segments = normalized.split('/');

        // 方法1: 把开头的 .. 替换为 .
        const altSegments = [...segments];
        for (let i = 0; i < altSegments.length; i++) {
            if (altSegments[i] === '..') {
                altSegments[i] = '.';
                const altPath = path.resolve(baseDir, altSegments.join(path.sep));
                if (fs.existsSync(altPath) && fs.statSync(altPath).isDirectory()) {
                    return altPath;
                }
                // 恢复，继续尝试下一个
                altSegments[i] = '..';
            }
        }

        // 方法2: 用路径最后一段名称在 baseDir 附近搜索同名目录
        const lastSegment = segments[segments.length - 1];
        if (lastSegment && lastSegment !== '.' && lastSegment !== '..') {
            const found = this.searchDirRecursive(baseDir, lastSegment, 3);
            if (found) {
                return found;
            }
        }

        return undefined;
    }

    /**
     * 搜索同名目录
     */
    private searchDirRecursive(dir: string, targetName: string, maxDepth: number): string | undefined {
        if (maxDepth <= 0) return undefined;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
                const fullPath = path.join(dir, entry.name);
                if (entry.name === targetName || entry.name.toLowerCase() === targetName.toLowerCase()) {
                    return fullPath;
                }
                const found = this.searchDirRecursive(fullPath, targetName, maxDepth - 1);
                if (found) return found;
            }
        } catch {
            // 忽略无权限目录
        }
        return undefined;
    }

    private parseCommaList(str: string): string[] {
        if (!str) return [];
        return str
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
    }

    // ==================== XML 遍历工具 ====================

    private findNode(obj: any, name: string): any {
        if (!obj || typeof obj !== 'object') return undefined;
        if (obj[name] !== undefined) return obj[name];
        for (const key of Object.keys(obj)) {
            const val = obj[key];
            if (typeof val === 'object' && !Array.isArray(val)) {
                const found = this.findNode(val, name);
                if (found !== undefined) return found;
            }
        }
        return undefined;
    }

    private getText(obj: any, name: string): string | undefined {
        const node = this.findNode(obj, name);
        if (!node) return undefined;
        if (typeof node === 'string') return node;
        if (typeof node === 'object') {
            if (node['#text'] !== undefined) return node['#text'];
            if (Object.keys(node).length === 0) return '';
            // 如果值是数字类型（如 FileType），直接转字符串
            const keys = Object.keys(node);
            if (keys.length === 1 && keys[0] === '#text') {
                return node['#text'];
            }
        }
        return String(node);
    }

    private guessToolchainPath(): string {
        return (
            vscode.workspace.getConfiguration('stc-extension').get<string>('toolchainPath') ||
            'F:\\MPU\\C251\\'
        );
    }
}
