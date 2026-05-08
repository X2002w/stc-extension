import * as vscode from 'vscode';

/**
 * STC 编译任务提供者
 * 在 "终端 > 运行任务" 菜单中提供编译相关任务
 */
export class StcTaskProvider implements vscode.TaskProvider {
    /**
     * 提供任务列表
     */
    provideTasks(): vscode.Task[] {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return [];
        }

        const workspaceRoot = workspaceFolders[0];

        const buildTask = this.createTask(
            '编译 STC 工程',
            'build',
            workspaceRoot
        );
        const cleanTask = this.createTask(
            '清理 STC 工程',
            'clean',
            workspaceRoot
        );
        const rebuildTask = this.createTask(
            '重新编译 STC 工程',
            'rebuild',
            workspaceRoot
        );

        return [buildTask, cleanTask, rebuildTask];
    }

    /**
     * 解析任务（从 tasks.json 中读取的任务定义）
     */
    resolveTask(task: vscode.Task): vscode.Task | undefined {
        const command = task.definition.command;
        if (command && ['build', 'clean', 'rebuild'].includes(command)) {
            return this.createTask(
                task.name,
                command,
                task.scope as vscode.WorkspaceFolder
            );
        }
        return undefined;
    }

    /**
     * 创建 VS Code Task 对象
     */
    private createTask(
        name: string,
        command: string,
        folder: vscode.WorkspaceFolder
    ): vscode.Task {
        const task = new vscode.Task(
            { type: 'stc-build', command },
            folder,
            name,
            'STC Build',
            new vscode.ShellExecution(''), // 占位，实际由扩展命令处理
            []  // 不需要问题匹配器，扩展内部处理
        );

        task.group = vscode.TaskGroup.Build;
        task.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Dedicated,
            clear: true,
        };

        return task;
    }
}
