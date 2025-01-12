import * as vscode from 'vscode';
import * as chatUtils from '@vscode/chat-extension-utils';
import { Octokit } from '@octokit/rest';
import { renderPrompt } from '@vscode/prompt-tsx';
import { SearchIssue, KnownIssue, SummarizationPrompt, IssueComment, TypeLabelPrompt, InfoNeededLabelPrompt, FindDuplicatePrompt, UpdateSummarizationPrompt, CurrentUser } from './cruncherPrompt';
import { CloseAsDuplicateParameters } from './tools';

export function registerChatLibChatParticipant(context: vscode.ExtensionContext) {
    const handler: vscode.ChatRequestHandler = async (request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, cancellationToken: vscode.CancellationToken) => {
        if (request.command === 'next') {
            stream.progress('Fetching the next issue...');
            try {
                const octokit = new Octokit({
                    auth: (await vscode.authentication.getSession('github', ['repo'], { createIfNone: true })).accessToken
                });
                // const response = await octokit.rest.search.issuesAndPullRequests({
                //     q: 'repo:devcontainers/cli is:issue is:open -label:bug -label:feature-request -label:question -label:info-needed -label:under-discussion -label:debt -label:upstream -label:polish',
                //     sort: 'created',
                //     order: 'desc',
                //     per_page: 1
                // });
                // const issue = response.data.items[0];

                let issue: SearchIssue | undefined;
                let lastReadAt: string | undefined;
                const iterator = octokit.paginate.iterator(octokit.rest.activity.listNotificationsForAuthenticatedUser);
                outerLoop:
                for await (const res of iterator) {
                    for (const notification of res.data) {
                        if (notification.subject.type === 'Issue') {
                            const response = await octokit.rest.issues.get({
                                owner: notification.repository.owner.login,
                                repo: notification.repository.name,
                                issue_number: parseInt(notification.subject.url.split('/').pop()!),
                            });
                            issue = response.data;
                            lastReadAt = (notification.last_read_at?.localeCompare(issue.updated_at) ?? 0) < 0 ? notification.last_read_at! : issue.updated_at;
                            break outerLoop;
                        }
                    }
                }

                if (issue) {
                    const [owner, repo] = issue.repository_url.split('/').slice(-2);
                    const commentsResponse = await octokit.rest.issues.listComments({
                        owner,
                        repo,
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
                    const userResponse = await octokit.rest.users.getAuthenticated();
                    const currentUser = userResponse.data;
                    await summarizeUpdate(request, chatContext, stream, currentUser, issue, commentsResponse.data, lastReadAt, cancellationToken);

                    const closed = await findDuplicateIssue(request, chatContext, stream, issue, summary, knownIssues, cancellationToken);
                    if (closed) {
                        return;
                    }
                    await infoNeededLabelIssue(request, chatContext, stream, issue, summary, cancellationToken);
                    await typeLabelIssue(request, chatContext, stream, issue, summary, cancellationToken);

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
        stream.markdown(`## Existing Summary\n\n${knownIssue.summary}\n\n`);
        return knownIssue.summary;
    }
    stream.markdown(`## Computing Summary\n\n`);

    const options: vscode.LanguageModelChatRequestOptions = {
        justification: 'Summarizing issue for @cruncher',
    };
    const model = request.model;
    const result = await renderPrompt(
        SummarizationPrompt,
        {
            issue,
            comments,
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
    stream.markdown('\n\n');

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
        const [owner, repo] = issue.repository_url.split('/').slice(-2);
        const filePath = vscode.Uri.joinPath(workspaceFolder.uri, `${owner}-${repo}-${issue.number}.json`);
        const fileContent = JSON.stringify({ summary, issue, comments }, null, 2);
        await vscode.workspace.fs.writeFile(filePath, Buffer.from(fileContent, 'utf8'));
    }

    return summary;
}

async function summarizeUpdate(request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, currentUser: CurrentUser, issue: SearchIssue, comments: IssueComment[], lastReadAt: string | undefined, cancellationToken: vscode.CancellationToken) {
    if (!lastReadAt) {
        return;
    }
    stream.markdown(`## Summarizing Update\n\n`);
    const newComments = comments.filter(comment =>
        comment.user?.login !== currentUser.login &&
        lastReadAt.localeCompare(comment.created_at) <= 0
    );
    if (!newComments.length) {
        stream.markdown(`No new comments.\n\n`);
        return;
    }

    const options: vscode.LanguageModelChatRequestOptions = {
        justification: 'Summarizing update for @cruncher',
    };
    const model = request.model;
    const result = await renderPrompt(
        UpdateSummarizationPrompt,
        {
            issue,
            comments,
            newComments,
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

    await readResponse(response, stream);
    stream.markdown('\n\n');
}

async function findDuplicateIssue(request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, issue: SearchIssue, summary: string, knownIssues: KnownIssue[], cancellationToken: vscode.CancellationToken) {
    stream.markdown(`## Finding Duplicate\n\n`);
    if (!knownIssues.length) {
        stream.markdown(`No known issues to compare against.\n\n`);
        return false;
    }
    const tools = vscode.lm.tools.filter(tool => tool.name === 'chat-tools-sample_closeAsDuplicate');
    const options: vscode.LanguageModelChatRequestOptions = {
        justification: 'Finding duplicates for @cruncher',
        tools,
    };
    const model = request.model;
    const result = await renderPrompt(
        FindDuplicatePrompt,
        {
            issue,
            summary,
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

    const { calls } = await readResponse(response, stream);
    stream.markdown('\n\n');
    if (calls.length) {
        try {
            for (const call of calls) {
                const input = call.input as CloseAsDuplicateParameters;
                stream.markdown(`### Duplicate Issue\n\n${knownIssues.find(i => i.issue.url === `https://github.com/${input.original_issue_owner}/${input.original_issue_repo}/issues/${input.original_issue_number}`)?.summary}\n\n`);
                await vscode.lm.invokeTool(call.name, { input, toolInvocationToken: request.toolInvocationToken }, cancellationToken);
            }
            return true;
        } catch (err) {
            if (err?.name !== 'Canceled') {
                throw err;
            }
        }
    }
    return false;
}

async function infoNeededLabelIssue(request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, issue: SearchIssue, summary: string, cancellationToken: vscode.CancellationToken) {
    stream.markdown(`## Info Needed\n\n`);
    const infoNeededLabel = 'info-needed';
    if (issue.labels.some(label => (typeof label === 'string' ? label : label.name) === infoNeededLabel)) {
        stream.markdown(`Issue already has ${infoNeededLabel} label.\n\n`);
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
    stream.markdown('\n\n');
    try {
        for (const call of calls) {
            await vscode.lm.invokeTool(call.name, { input: call.input, toolInvocationToken: request.toolInvocationToken }, cancellationToken);
        }
    } catch (err) {
        if (err?.name !== 'Canceled') {
            throw err;
        }
    }
}

async function typeLabelIssue(request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, issue: SearchIssue, summary: string, cancellationToken: vscode.CancellationToken) {
    stream.markdown(`## Type Label\n\n`);
    const typeLabels = {
        bug: 'A problem or error in the software',
        'feature-request': 'A request for a new feature or enhancement',
        question: 'A question or inquiry about the software',
        upstream: 'An issue that originates from an upstream dependency',
        debt: 'Technical debt that needs to be addressed'
    };
    const existingTypeLabel = issue.labels.map(label => typeof label === 'string' ? label : label.name)
        .find(label => label && label in typeLabels);
    if (existingTypeLabel) {
        stream.markdown(`Issue already has type label: ${existingTypeLabel}\n\n`);
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
    stream.markdown('\n\n');
    try {
        for (const call of calls) {
            await vscode.lm.invokeTool(call.name, { input: call.input, toolInvocationToken: request.toolInvocationToken }, cancellationToken);
        }
    } catch (err) {
        if (err?.name !== 'Canceled') {
            throw err;
        }
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
