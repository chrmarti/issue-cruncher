import * as vscode from 'vscode';
import * as chatUtils from '@vscode/chat-extension-utils';
import { Octokit } from '@octokit/rest';
import { renderPrompt } from '@vscode/prompt-tsx';
import { SearchIssue, KnownIssue, SummarizationPrompt, IssueComment, TypeLabelPrompt, InfoNeededLabelPrompt } from './cruncherPrompt';

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

                    stream.markdown(`Triaging issue: [#${issue.number}](${issue.html_url}) - ${issue.title} by [@${issue.user?.login}](${issue.user?.html_url})\n\n`);

                    const knownIssues: KnownIssue[] = [];
                    const files = await vscode.workspace.findFiles('*.json', undefined, 100);
                    for (const file of files) {
                        const content = await vscode.workspace.fs.readFile(file);
                        knownIssues.push(JSON.parse(content.toString()));
                    }

                    const summary = await summarizeIssue(request, chatContext, stream, issue, commentsResponse.data, knownIssues, cancellationToken);
                    if (summary.trim()) {
                        await infoNeededLabelIssue(request, chatContext, stream, issue, summary, cancellationToken);
                        await typeLabelIssue(request, chatContext, stream, issue, summary, cancellationToken);
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

async function summarizeIssue(request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, issue: SearchIssue, comments: IssueComment[], knownIssues: KnownIssue[], cancellationToken: vscode.CancellationToken) {
    const knownIssue = knownIssues.find(knownIssue => knownIssue.issue.url === issue.url);
    if (knownIssue?.issue.updated_at === issue.updated_at) {
        stream.markdown(`Known issue with summary:\n\n${knownIssue.summary}\n\n`);
        return knownIssue.summary;
    }

    const options: vscode.LanguageModelChatRequestOptions = {
        justification: 'Summarizing issue for @cruncher',
    };
    const model = request.model;
    const result = await renderPrompt(
        SummarizationPrompt,
        {
            issue,
            comments,
            knownIssues,
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

    const { text: summary } = await readResponse(response, stream);

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (summary.trim() && workspaceFolder) {
        stream.markdown('\n\n');
        const filePath = vscode.Uri.joinPath(workspaceFolder.uri, `devcontainers-cli-${issue.number}.json`);
        const fileContent = JSON.stringify({ summary, issue }, null, 2);
        await vscode.workspace.fs.writeFile(filePath, Buffer.from(fileContent, 'utf8'));
    }

    return summary;
}

async function infoNeededLabelIssue(request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, issue: SearchIssue, summary: string, cancellationToken: vscode.CancellationToken) {
    const infoNeededLabel = 'info-needed';
    if (issue.labels.some(label => label.name === infoNeededLabel)) {
        stream.markdown(`Issue already has ${infoNeededLabel} label.`);
        return;
    }

    const tools = vscode.lm.tools.filter(tool => tool.name === 'chat-tools-sample_addLabelToIssue');
    const options: vscode.LanguageModelChatRequestOptions = {
        justification: 'Checking if more information is needed for @cruncher',
        tools,
    };
    const model = request.model;
    const result = await renderPrompt(
        InfoNeededLabelPrompt,
        {
            infoNeededLabel,
            issue,
            summary,
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

    const { calls } = await readResponse(response, stream);
    for (const call of calls) {
        await vscode.lm.invokeTool(call.name, { input: call.input, toolInvocationToken: request.toolInvocationToken }, cancellationToken);
    }
}

async function typeLabelIssue(request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, issue: SearchIssue, summary: string, cancellationToken: vscode.CancellationToken) {
    const typeLabels = ['bug', 'feature-request', 'question', 'upstream'];
    const existingTypeLabel = issue.labels.find(label => label.name && typeLabels.includes(label.name));
    if (existingTypeLabel) {
        stream.markdown(`Issue already has type label: ${existingTypeLabel.name}`);
        return;
    }

    const tools = vscode.lm.tools.filter(tool => tool.name === 'chat-tools-sample_addLabelToIssue');
    const options: vscode.LanguageModelChatRequestOptions = {
        justification: 'Choosing type label for @cruncher',
        tools,
    };
    const model = request.model;
    const result = await renderPrompt(
        TypeLabelPrompt,
        {
            typeLabels,
            issue,
            summary,
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

    const { calls } = await readResponse(response, stream);
    for (const call of calls) {
        await vscode.lm.invokeTool(call.name, { input: call.input, toolInvocationToken: request.toolInvocationToken }, cancellationToken);
    }
}

async function readResponse(response: vscode.LanguageModelChatResponse, stream: vscode.ChatResponseStream) {
    // Stream text output and collect tool calls from the response
    const calls: vscode.LanguageModelToolCallPart[] = [];
    let text = '';
    for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
            stream.markdown(part.value);
            text += part.value;
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
            calls.push(part);
        }
    }
    return { text, calls };
}
