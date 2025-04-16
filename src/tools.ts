import { Octokit } from '@octokit/rest';
import * as vscode from 'vscode';

export function registerChatTools(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.lm.registerTool('chat-tools-sample_tabCount', new TabCountTool()));
	context.subscriptions.push(vscode.lm.registerTool('chat-tools-sample_findFiles', new FindFilesTool()));
	context.subscriptions.push(vscode.lm.registerTool('chat-tools-sample_runInTerminal', new RunInTerminalTool()));
	context.subscriptions.push(vscode.lm.registerTool('chat-tools-sample_addLabelToIssue', new AddLabelToIssueTool()));
	context.subscriptions.push(vscode.lm.registerTool('chat-tools-sample_reassignIssue', new ReassignIssueTool()));
	context.subscriptions.push(vscode.lm.registerTool('chat-tools-sample_closeAsDuplicate', new CloseAsDuplicateTool()));
	context.subscriptions.push(vscode.lm.registerTool('chat-tools-sample_closeIssue', new CloseIssueTool()));
	context.subscriptions.push(vscode.lm.registerTool('chat-tools-sample_markNotificationRead', new MarkReadTool()));
}

interface ITabCountParameters {
	tabGroup?: number;
}

export class TabCountTool implements vscode.LanguageModelTool<ITabCountParameters> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ITabCountParameters>,
		_token: vscode.CancellationToken
	) {
		const params = options.input;
		if (typeof params.tabGroup === 'number') {
			const group = vscode.window.tabGroups.all[Math.max(params.tabGroup - 1, 0)];
			const nth =
				params.tabGroup === 1
					? '1st'
					: params.tabGroup === 2
						? '2nd'
						: params.tabGroup === 3
							? '3rd'
							: `${params.tabGroup}th`;
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`There are ${group.tabs.length} tabs open in the ${nth} tab group.`)]);
		} else {
			const group = vscode.window.tabGroups.activeTabGroup;
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`There are ${group.tabs.length} tabs open.`)]);
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<ITabCountParameters>,
		_token: vscode.CancellationToken
	) {
		const confirmationMessages = {
			title: 'Count the number of open tabs',
			message: new vscode.MarkdownString(
				`Count the number of open tabs?` +
				(options.input.tabGroup !== undefined
					? ` in tab group ${options.input.tabGroup}`
					: '')
			),
		};

		return {
			invocationMessage: 'Counting the number of tabs',
			confirmationMessages,
		};
	}
}

interface IFindFilesParameters {
	pattern: string;
}

export class FindFilesTool implements vscode.LanguageModelTool<IFindFilesParameters> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<IFindFilesParameters>,
		token: vscode.CancellationToken
	) {
		const params = options.input as IFindFilesParameters;
		const files = await vscode.workspace.findFiles(
			params.pattern,
			'**/node_modules/**',
			undefined,
			token
		);

		const strFiles = files.map((f) => f.fsPath).join('\n');
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Found ${files.length} files matching "${params.pattern}":\n${strFiles}`)]);
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<IFindFilesParameters>,
		_token: vscode.CancellationToken
	) {
		return {
			invocationMessage: `Searching workspace for "${options.input.pattern}"`,
		};
	}
}

interface IRunInTerminalParameters {
	command: string;
}

async function waitForShellIntegration(
	terminal: vscode.Terminal,
	timeout: number
): Promise<void> {
	let resolve: () => void;
	let reject: (e: Error) => void;
	const p = new Promise<void>((_resolve, _reject) => {
		resolve = _resolve;
		reject = _reject;
	});

	const timer = setTimeout(() => reject(new Error('Could not run terminal command: shell integration is not enabled')), timeout);

	const listener = vscode.window.onDidChangeTerminalShellIntegration((e) => {
		if (e.terminal === terminal) {
			clearTimeout(timer);
			listener.dispose();
			resolve();
		}
	});

	await p;
}

export class RunInTerminalTool
	implements vscode.LanguageModelTool<IRunInTerminalParameters> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<IRunInTerminalParameters>,
		_token: vscode.CancellationToken
	) {
		const params = options.input as IRunInTerminalParameters;

		const terminal = vscode.window.createTerminal('Language Model Tool User');
		terminal.show();
		try {
			await waitForShellIntegration(terminal, 5000);
		} catch (e) {
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart((e as Error).message)]);
		}

		const execution = terminal.shellIntegration!.executeCommand(params.command);
		const terminalStream = execution.read();

		let terminalResult = '';
		for await (const chunk of terminalStream) {
			terminalResult += chunk;
		}

		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(terminalResult)]);
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<IRunInTerminalParameters>,
		_token: vscode.CancellationToken
	) {
		const confirmationMessages = {
			title: 'Run command in terminal',
			message: new vscode.MarkdownString(
				`Run this command in a terminal?` +
				`\n\n\`\`\`\n${options.input.command}\n\`\`\`\n`
			),
		};

		return {
			invocationMessage: `Running command in terminal`,
			confirmationMessages,
		};
	}
}

interface AddLabelParameters {
	owner: string;
	repo: string;
	issue_number: number;
	label: string;
	comment?: string;
}

class AddLabelToIssueTool implements vscode.LanguageModelTool<AddLabelParameters> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<AddLabelParameters>,
		_token: vscode.CancellationToken
	) {
		const { owner, repo, issue_number, label, comment } = options.input;

		const octokit = new Octokit({
			auth: (await vscode.authentication.getSession('github', ['repo'], { createIfNone: true })).accessToken
		});
		if (comment) {
			await octokit.rest.issues.createComment({
				owner,
				repo,
				issue_number,
				body: comment
			});
		}
		await octokit.rest.issues.addLabels({
			owner,
			repo,
			issue_number,
			labels: [label]
		});

		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Added label \`${label}\`${comment ? ` and comment "${comment}"` : ''} to issue \`${owner}/${repo}#${issue_number}\``)]);
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<AddLabelParameters>,
		_token: vscode.CancellationToken
	) {
		const { owner, repo, issue_number, label, comment } = options.input;
		const confirmationMessages = {
			title: 'Update issue',
			message: new vscode.MarkdownString(`Issue: [${owner}/${repo}#${issue_number}](https://github.com/${owner}/${repo}/issues/${issue_number})
- Add label: \`${label}\`${comment ? `
- Add comment: \`${comment}\`` : ''}`
			),
		};

		return {
			invocationMessage: `Adding label \`${label}\`${comment ? ` and comment "${comment}"` : ''} to issue \`${owner}/${repo}#${issue_number}\``,
			confirmationMessages,
		};
	}
}


interface ReassignParameters {
	owner: string;
	repo: string;
	issue_number: number;
	old_owner?: string;
	new_owner: string;
	remove_label?: string;
}

class ReassignIssueTool implements vscode.LanguageModelTool<ReassignParameters> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ReassignParameters>,
		_token: vscode.CancellationToken
	) {
		const { owner, repo, issue_number, old_owner, new_owner, remove_label } = options.input;

		const octokit = new Octokit({
			auth: (await vscode.authentication.getSession('github', ['repo'], { createIfNone: true })).accessToken
		});
		if (old_owner) {
			await octokit.rest.issues.removeAssignees({
				owner,
				repo,
				issue_number,
				assignees: [old_owner]
			});
		}
		if (new_owner) {
			await octokit.rest.issues.addAssignees({
				owner,
				repo,
				issue_number,
				assignees: [new_owner]
			});
		}
		if (remove_label) {
			await octokit.rest.issues.removeLabel({
				owner,
				repo,
				issue_number,
				name: remove_label
			});
		}

		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Reassigned issue \`${owner}/${repo}#${issue_number}\` to \`@${new_owner}\``)]);
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<ReassignParameters>,
		_token: vscode.CancellationToken
	) {
		const { owner, repo, issue_number, old_owner, new_owner, remove_label } = options.input;
		const confirmationMessages = {
			title: 'Reassign issue',
			message: new vscode.MarkdownString(
				`Reassign issue \`${owner}/${repo}#${issue_number}\`${old_owner ? ` from \`@${old_owner}\`` : ''} to \`@${new_owner}\`${remove_label ? ` and remove label \`${remove_label}\`` : ''}?`
			),
		};

		return {
			invocationMessage: `Reassigning issue \`${owner}/${repo}#${issue_number}\`${old_owner ? ` from \`@${old_owner}\`` : ''} to \`@${new_owner}\`${remove_label ? ` and removing label \`${remove_label}\`` : ''}`,
			confirmationMessages,
		};
	}
}

export interface CloseAsDuplicateParameters {
	new_issue_owner: string;
	new_issue_repo: string;
	new_issue_number: number;
	existing_issue_owner: string;
	existing_issue_repo: string;
	existing_issue_number: number;
}

class CloseAsDuplicateTool implements vscode.LanguageModelTool<CloseAsDuplicateParameters> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<CloseAsDuplicateParameters>,
		_token: vscode.CancellationToken
	) {
		const { new_issue_owner, new_issue_repo, new_issue_number, existing_issue_owner, existing_issue_repo, existing_issue_number } = options.input;

		const octokit = new Octokit({
			auth: (await vscode.authentication.getSession('github', ['repo'], { createIfNone: true })).accessToken
		});
		await octokit.rest.issues.createComment({
			owner: new_issue_owner,
			repo: new_issue_repo,
			issue_number: new_issue_number,
			body: `Duplicate of ${existing_issue_owner}/${existing_issue_repo}#${existing_issue_number}`
		});
		await octokit.rest.issues.update({
			owner: new_issue_owner,
			repo: new_issue_repo,
			issue_number: new_issue_number,
			state: 'closed'
		});

		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Closed issue \`${new_issue_owner}/${new_issue_repo}#${new_issue_number}\` as a duplicate of \`${existing_issue_owner}/${existing_issue_repo}#${existing_issue_number}\``)]);
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<CloseAsDuplicateParameters>,
		_token: vscode.CancellationToken
	) {
		const { new_issue_owner, new_issue_repo, new_issue_number, existing_issue_owner, existing_issue_repo, existing_issue_number } = options.input;
		const confirmationMessages = {
			title: 'Close issue as duplicate',
			message: new vscode.MarkdownString(
				`Close issue [${new_issue_owner}/${new_issue_repo}#${new_issue_number}](https://github.com/${new_issue_owner}/${new_issue_repo}/issues/${new_issue_number}) as a duplicate of [${existing_issue_owner}/${existing_issue_repo}#${existing_issue_number}](https://github.com/${existing_issue_owner}/${existing_issue_repo}/issues/${existing_issue_number})?`
			),
		};

		return {
			invocationMessage: `Closing issue \`${new_issue_owner}/${new_issue_repo}#${new_issue_number}\` as a duplicate of \`${existing_issue_owner}/${existing_issue_repo}#${existing_issue_number}\``,
			confirmationMessages,
		};
	}
}

export interface CloseIssueParameters {
	issue_owner: string;
	issue_repo: string;
	issue_number: number;
	comment: string;
}

class CloseIssueTool implements vscode.LanguageModelTool<CloseIssueParameters> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<CloseIssueParameters>,
		_token: vscode.CancellationToken
	) {
		const { issue_owner, issue_repo, issue_number, comment } = options.input;

		const octokit = new Octokit({
			auth: (await vscode.authentication.getSession('github', ['repo'], { createIfNone: true })).accessToken
		});
		await octokit.rest.issues.createComment({
			owner: issue_owner,
			repo: issue_repo,
			issue_number: issue_number,
			body: comment
		});
		await octokit.rest.issues.update({
			owner: issue_owner,
			repo: issue_repo,
			issue_number: issue_number,
			state: 'closed'
		});

		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Closed issue \`${issue_owner}/${issue_repo}#${issue_number}\``)]);
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<CloseIssueParameters>,
		_token: vscode.CancellationToken
	) {
		const { issue_owner, issue_repo, issue_number, comment } = options.input;
		const confirmationMessages = {
			title: 'Close issue with comment',
			message: new vscode.MarkdownString(
				`Close issue [${issue_owner}/${issue_repo}#${issue_number}](https://github.com/${issue_owner}/${issue_repo}/issues/${issue_number}) with comment \`${comment}\`?`
			),
		};

		return {
			invocationMessage: `Closing issue \`${issue_owner}/${issue_repo}#${issue_number}\` with comment`,
			confirmationMessages,
		};
	}
}

export interface MarkReadParameters {
	notification_id: number;
}

class MarkReadTool implements vscode.LanguageModelTool<MarkReadParameters> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<MarkReadParameters>,
		_token: vscode.CancellationToken
	) {
		const { notification_id } = options.input;

		const octokit = new Octokit({
			auth: (await vscode.authentication.getSession('github', ['repo'], { createIfNone: true })).accessToken
		});
		await octokit.rest.activity.markThreadAsRead({ thread_id: notification_id });

		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Marked notification as read`)]);
	}

	async prepareInvocation(
		_options: vscode.LanguageModelToolInvocationPrepareOptions<MarkReadParameters>,
		_token: vscode.CancellationToken
	) {

		const confirmationMessages = {
			title: `Mark notification as read`,
			message: new vscode.MarkdownString(
				`Mark the notification as read?`
			),
		};

		return {
			invocationMessage: `Marking notification as read`,
			confirmationMessages,
		};
	}
}
