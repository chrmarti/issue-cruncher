import { Octokit } from '@octokit/rest';
import * as vscode from 'vscode';

export function registerChatTools(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.lm.registerTool('chat-tools-sample_tabCount', new TabCountTool()));
	context.subscriptions.push(vscode.lm.registerTool('chat-tools-sample_findFiles', new FindFilesTool()));
	context.subscriptions.push(vscode.lm.registerTool('chat-tools-sample_runInTerminal', new RunInTerminalTool()));
	context.subscriptions.push(vscode.lm.registerTool('chat-tools-sample_addLabelToIssue', new AddLabelToIssueTool()));
	context.subscriptions.push(vscode.lm.registerTool('chat-tools-sample_closeAsDuplicate', new CloseAsDuplicateTool()));
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
}

class AddLabelToIssueTool implements vscode.LanguageModelTool<AddLabelParameters> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<AddLabelParameters>,
		_token: vscode.CancellationToken
	) {
		const { owner, repo, issue_number, label } = options.input;

		const octokit = new Octokit({
			auth: (await vscode.authentication.getSession('github', ['repo'], { createIfNone: true })).accessToken
		});
		await octokit.rest.issues.addLabels({
			owner,
			repo,
			issue_number,
			labels: [label]
		});

		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Added label \`${label}\` to issue \`${owner}/${repo}#${issue_number}\``)]);
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<AddLabelParameters>,
		_token: vscode.CancellationToken
	) {
		const { owner, repo, issue_number, label } = options.input;
		const confirmationMessages = {
			title: 'Add label to issue',
			message: new vscode.MarkdownString(
				`Add the label \`${label}\` to issue \`${owner}/${repo}#${issue_number}\`?`
			),
		};

		return {
			invocationMessage: `Adding label \`${label}\` to issue \`${owner}/${repo}#${issue_number}\``,
			confirmationMessages,
		};
	}
}

interface CloseAsDuplicateParameters {
	current_issue_owner: string;
	current_issue_repo: string;
	current_issue_number: number;
	original_issue_owner: string;
	original_issue_repo: string;
	original_issue_number: number;
}

class CloseAsDuplicateTool implements vscode.LanguageModelTool<CloseAsDuplicateParameters> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<CloseAsDuplicateParameters>,
		_token: vscode.CancellationToken
	) {
		const { current_issue_owner, current_issue_repo, current_issue_number, original_issue_owner, original_issue_repo, original_issue_number } = options.input;

		const octokit = new Octokit({
			auth: (await vscode.authentication.getSession('github', ['repo'], { createIfNone: true })).accessToken
		});
		await octokit.rest.issues.createComment({
			owner: current_issue_owner,
			repo: current_issue_repo,
			issue_number: current_issue_number,
			body: `Duplicate of ${original_issue_owner}/${original_issue_repo}#${original_issue_number}`
		});
		await octokit.rest.issues.update({
			owner: current_issue_owner,
			repo: current_issue_repo,
			issue_number: current_issue_number,
			state: 'closed'
		});

		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Closed issue \`${current_issue_owner}/${current_issue_repo}#${current_issue_number}\` as a duplicate of \`${original_issue_owner}/${original_issue_repo}#${original_issue_number}\``)]);
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<CloseAsDuplicateParameters>,
		_token: vscode.CancellationToken
	) {
		const { current_issue_owner, current_issue_repo, current_issue_number, original_issue_owner, original_issue_repo, original_issue_number } = options.input;
		const confirmationMessages = {
			title: 'Close issue as duplicate',
			message: new vscode.MarkdownString(
				`Close issue [${current_issue_owner}/${current_issue_repo}#${current_issue_number}](https://github.com/${current_issue_owner}/${current_issue_repo}/issues/${current_issue_number}) as a duplicate of [${original_issue_owner}/${original_issue_repo}#${original_issue_number}](https://github.com/${original_issue_owner}/${original_issue_repo}/issues/${original_issue_number})?`
			),
		};

		return {
			invocationMessage: `Closing issue \`${current_issue_owner}/${current_issue_repo}#${current_issue_number}\` as a duplicate of \`${original_issue_owner}/${original_issue_repo}#${original_issue_number}\``,
			confirmationMessages,
		};
	}
}
