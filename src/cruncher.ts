import * as vscode from 'vscode';
import * as chatUtils from '@vscode/chat-extension-utils';
import { Octokit } from '@octokit/rest';
import { renderPrompt } from '@vscode/prompt-tsx';
import { CruncherPrompt } from './cruncherPrompt';

export function registerChatLibChatParticipant(context: vscode.ExtensionContext) {
    const handler: vscode.ChatRequestHandler = async (request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, cancellationToken: vscode.CancellationToken) => {
        if (request.command === 'next') {
            stream.progress('Fetching the most recent open issue...');
            try {
                const octokit = new Octokit({
                    auth: (await vscode.authentication.getSession('github', ['repo'], { createIfNone: true })).accessToken
                });
                const response = await octokit.rest.search.issuesAndPullRequests({
                    q: 'repo:devcontainers/cli is:issue is:open -label:bug -label:feature-request -label:question -label:info-needed -label:under-discussion -label:debt -label:upstream -label:polish',
                    sort: 'created',
                    order: 'desc',
                    per_page: 1
                });

                const issue = response.data.items[0];
                if (issue) {
                    const commentsResponse = await octokit.rest.issues.listComments({
                        owner: 'devcontainers',
                        repo: 'cli',
                        issue_number: issue.number
                    });

                    stream.markdown(`Summarizing issue: [#${issue.number}](${issue.html_url}) - ${issue.title}\n\n`);

                    const comments = commentsResponse.data.map(comment => `## Comment by @${comment.user?.login}\n\n${comment.body}`).join('\n\n');
                    const fullIssueText = `# Issue ${issue.html_url} by @${issue.user?.login}: ${issue.title}\n\n${issue.body}\n\n${comments}`;
                    const prompt = `Task: Summarize the following GitHub issue and its comments in a few sentences. Add then one of the labels 'bug', 'feature-request', 'question', 'upstream' or 'info-needed' to the issue.\n\n${fullIssueText}`;

                    const tools = vscode.lm.tools.filter(tool => tool.name === 'chat-tools-sample_addLabelToIssue');

                    const options: vscode.LanguageModelChatRequestOptions = {
                        justification: 'To make a request to @cruncher',
                        tools,
                    };
                    const model = request.model;
                    const result = await renderPrompt(
                        CruncherPrompt,
                        {
                            prompt,
                            context: chatContext,
                            request,
                        },
                        { modelMaxPromptTokens: model.maxInputTokens },
                        model);
                    result.references.forEach(ref => {
                        if (ref.anchor instanceof vscode.Uri || ref.anchor instanceof vscode.Location) {
                            stream.reference(ref.anchor);
                        }
                    });
                    const response = await model.sendRequest(result.messages, options, cancellationToken);

                    // Stream text output and collect tool calls from the response
                    const toolCalls: vscode.LanguageModelToolCallPart[] = [];
                    let summary = '';
                    for await (const part of response.stream) {
                        if (part instanceof vscode.LanguageModelTextPart) {
                            stream.markdown(part.value);
                            summary += part.value;
                        } else if (part instanceof vscode.LanguageModelToolCallPart) {
                            toolCalls.push(part);
                        }
                    }

                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                    if (workspaceFolder) {
                        const filePath = vscode.Uri.joinPath(workspaceFolder.uri, `devcontainers-cli-${issue.number}.json`);
                        const fileContent = JSON.stringify({ summary, issue }, null, 2);
                        await vscode.workspace.fs.writeFile(filePath, Buffer.from(fileContent, 'utf8'));
                    }

                    for (const toolCall of toolCalls) {
                        await vscode.lm.invokeTool(toolCall.name, { input: toolCall.input, toolInvocationToken: request.toolInvocationToken }, cancellationToken);
                    }
                } else {
                    stream.markdown('No open issues found.');
                }
            } catch (error) {
                stream.markdown(`Error fetching issues: ${error?.message}`);
            }
            return;
        }

        const tools = vscode.lm.tools.filter(tool => tool.tags.includes('chat-tools-sample'));

        const libResult = chatUtils.sendChatParticipantRequest(
            request,
            chatContext,
            {
                prompt: 'You are a cat! Answer as a cat.',
                responseStreamOptions: {
                    stream,
                    references: true,
                    responseText: true
                },
                tools
            },
            cancellationToken);

        return await libResult.result;
    };

    const chatLibParticipant = vscode.chat.createChatParticipant('chat-tools-sample.catTools', handler);
    chatLibParticipant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'cat.jpeg');
    context.subscriptions.push(chatLibParticipant);
}