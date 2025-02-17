import * as vscode from 'vscode';
import * as chatUtils from '@vscode/chat-extension-utils';
import { Octokit } from '@octokit/rest';
import { renderPrompt } from '@vscode/prompt-tsx';
import { SearchIssue, KnownIssue, SummarizationPrompt, IssueComment, TypeLabelPrompt, InfoNeededLabelPrompt, FindDuplicatePrompt, UpdateSummarizationPrompt, CurrentUser, Notification, MarkReadPrompt, CheckResolutionPrompt, CustomInstructionsPrompt } from './cruncherPrompt';
import { CloseAsDuplicateParameters } from './tools';

const enableCheckResolution = false;
const enableFindDuplicateIssue = false;
const enableInfoNeededLabel = false;
const enableTypeLabel = false;

export function registerChatLibChatParticipant(context: vscode.ExtensionContext) {
    const handler: vscode.ChatRequestHandler = async (request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, cancellationToken: vscode.CancellationToken) => {
        if (request.command === 'next') {
            if (!vscode.workspace.workspaceFolders?.[0]) {
                stream.markdown('No workspace folder open for storing summaries.');
                return;
            }

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
                let notification: Notification | undefined;
                let newCommentCreatedAt: string | undefined;
                const iterator = octokit.paginate.iterator(octokit.rest.activity.listNotificationsForAuthenticatedUser);
                outerLoop:
                for await (const res of iterator) {
                    for (const current of res.data) {
                        if (current.subject.type === 'Issue') {
                            notification = current;
                            const response = await octokit.rest.issues.get({
                                owner: notification.repository.owner.login,
                                repo: notification.repository.name,
                                issue_number: parseInt(notification.subject.url.split('/').pop()!),
                            });
                            issue = response.data;
                            const segments = notification.subject.latest_comment_url.split('/');
                            if (segments[segments.length - 2] === 'comments') {
                                const commentResponse = await octokit.rest.issues.getComment({ owner: segments[segments.length - 5], repo: segments[segments.length - 4], comment_id: parseInt(segments[segments.length - 1]) });
                                newCommentCreatedAt = commentResponse.data.created_at;
                            }
                            break outerLoop;
                        }
                    }
                }

                if (issue) {
                    const userResponse = await octokit.rest.users.getAuthenticated();
                    const currentUser = userResponse.data;

                    const [owner, repo] = issue.repository_url.split('/').slice(-2);
                    const comments: IssueComment[] = await octokit.paginate(octokit.issues.listComments, {
                        owner,
                        repo,
                        issue_number: issue.number,
                      });

                    const lastReadAt = notification?.last_read_at;
                    const since = lastReadAt && newCommentCreatedAt ? (lastReadAt < newCommentCreatedAt ? lastReadAt : newCommentCreatedAt) : (lastReadAt || newCommentCreatedAt);
                    const newComments = since ? comments.filter(comment =>
                        comment.user?.login !== currentUser.login &&
                        since.localeCompare(comment.created_at) <= 0
                    ) : [];

                    stream.markdown(`> Issue: [${owner}/${repo}#${issue.number}](${issue.html_url})
> - State: ${issue.state}
> - Labels: ${issue.labels?.map(label => typeof label === 'string' ? label : label.name).map(label => `\`${label}\``).join(', ') || '-'}
> - Assignee: ${issue.assignees?.map(assignee => `[@${assignee.login}](${assignee.html_url})`).join(', ') || '-'}
> - New Comment: ${newComments.length ? new Date(newComments[0].created_at).toLocaleDateString() : '-'}
> - Title: ${issue.title}
> - Author: [@${issue.user?.login}](${issue.user?.html_url})
> - Created: ${new Date(issue.created_at).toLocaleDateString()}
\n`);

                    // Not entirely new issue?
                    if (notification?.last_read_at) {
                        if (!newComments.length) {
                            stream.markdown(`No new comments.\n\n`);
                            await markAsRead(request, chatContext, stream, notification, cancellationToken);
                            return;
                        }
                        if (newComments.every(comment => comment.user?.type === 'Bot')) {
                            stream.markdown(`Only bot comments.\n\n`);
                            await markAsRead(request, chatContext, stream, notification, cancellationToken);
                            return;
                        }
                    }

                    const knownIssues: KnownIssue[] = [];
                    const files = await vscode.workspace.findFiles('*.json', undefined, 100);
                    for (const file of files) {
                        const content = await vscode.workspace.fs.readFile(file);
                        knownIssues.push(JSON.parse(content.toString()));
                    }

                    const updateSummary = await summarizeUpdate(request, chatContext, stream, currentUser, issue, comments, newComments, cancellationToken);
                    const summary = await summarizeIssue(request, chatContext, stream, currentUser, issue, comments, knownIssues, cancellationToken);

                    if (issue.assignees?.find(a => a.login === currentUser.login)) {
                        let closed = enableCheckResolution && await checkResolution(request, chatContext, stream, issue, summary, cancellationToken);
                        closed ||= enableFindDuplicateIssue && await findDuplicateIssue(request, chatContext, stream, issue, summary, knownIssues, cancellationToken);
                        if (!closed) {
                            await applyCustomInstructions(request, chatContext, stream, currentUser, issue, newComments, summary, updateSummary, cancellationToken);
                            if (enableInfoNeededLabel) {
                                await infoNeededLabelIssue(request, chatContext, stream, issue, summary, cancellationToken);
                            }
                            if (enableTypeLabel) {
                                await typeLabelIssue(request, chatContext, stream, issue, summary, cancellationToken);
                            }
                        }
                    }

                    if (notification) {
                        await markAsRead(request, chatContext, stream, notification, cancellationToken);
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

async function summarizeIssue(request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, currentUser: CurrentUser, issue: SearchIssue, comments: IssueComment[], knownIssues: KnownIssue[], cancellationToken: vscode.CancellationToken) {
    const knownIssue = knownIssues.find(knownIssue => knownIssue.issue.url === issue.url);
    if (knownIssue?.issue.updated_at === issue.updated_at) {
        stream.markdown(`## Summary\n\n${knownIssue.summary}\n\n`);
        return knownIssue.summary;
    }
    stream.markdown(`## Summary\n\n`);

    const options: vscode.LanguageModelChatRequestOptions = {
        justification: 'Summarizing issue for @cruncher',
    };
    const model = await getFastModel(request.model);
    const result = await renderPrompt(
        SummarizationPrompt,
        {
            currentUser,
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

async function summarizeUpdate(request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, currentUser: CurrentUser, issue: SearchIssue, comments: IssueComment[], newComments: IssueComment[], cancellationToken: vscode.CancellationToken) {
    if (!newComments.length) {
        return;
    }
    stream.markdown(`## Summarizing Update\n\n`);

    const options: vscode.LanguageModelChatRequestOptions = {
        justification: 'Summarizing update for @cruncher',
    };
    const model = await getFastModel(request.model);
    const result = await renderPrompt(
        UpdateSummarizationPrompt,
        {
            currentUser,
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

    const { text: summary } = await readResponse(response, stream);
    stream.markdown('\n\n');
    return summary;
}

async function checkResolution(request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, issue: SearchIssue, summary: string, cancellationToken: vscode.CancellationToken) {
    if (issue.state === 'closed') {
        return true;
    }
    stream.markdown(`## Checking Resolution\n\n`);
    const tools = vscode.lm.tools.filter(tool => tool.name === 'chat-tools-sample_closeIssue');
    const options: vscode.LanguageModelChatRequestOptions = {
        justification: 'Checking issue resolution for @cruncher',
        tools,
    };
    const model = request.model;
    const result = await renderPrompt(
        CheckResolutionPrompt,
        {
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
    if (calls.length) {
        try {
            for (const call of calls) {
                await vscode.lm.invokeTool(call.name, { input: call.input, toolInvocationToken: request.toolInvocationToken }, cancellationToken);
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
                const duplicateURL = `https://github.com/${input.existing_issue_owner}/${input.existing_issue_repo}/issues/${input.existing_issue_number}`;
                const duplicateIssue = knownIssues.find(i => i.issue.html_url === duplicateURL);
                if (duplicateIssue) {
                    stream.markdown(`### Duplicate Issue\n\n${duplicateIssue.summary}\n\n`);
                }
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

async function applyCustomInstructions(request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, currentUser: CurrentUser, issue: SearchIssue, newComments: IssueComment[], summary: string, updateSummary: string | undefined, cancellationToken: vscode.CancellationToken) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return;
    }
    const instructionsUri = vscode.Uri.joinPath(workspaceFolder.uri, 'issue_triage.md');
    let instructions;
    try {
        instructions = await vscode.workspace.fs.readFile(instructionsUri);
    } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code !== 'FileNotFound') {
            stream.markdown(`Error reading instructions file: ${error.message}`);
        }
        return;
    }

    stream.markdown(`## Applying Custom Instructions\n\n`);

    const tools = vscode.lm.tools.filter(tool => [
        'chat-tools-sample_addLabelToIssue',
        'chat-tools-sample_closeIssue',
        'chat-tools-sample_reassignIssue',
    ].includes(tool.name));
    const options: vscode.LanguageModelChatRequestOptions = {
        justification: 'Applying custom instructions with @cruncher',
        tools,
    };
    const model = request.model;
    const result = await renderPrompt(
        CustomInstructionsPrompt,
        {
            currentUser,
            instructions: instructions.toString(),
            issue,
            newComments,
            summary,
            updateSummary,
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

async function infoNeededLabelIssue(request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, issue: SearchIssue, summary: string, cancellationToken: vscode.CancellationToken) {
    const infoNeededLabel = 'info-needed';
    if (issue.labels.some(label => (typeof label === 'string' ? label : label.name) === infoNeededLabel)) {
        return;
    }

    stream.markdown(`## Info Needed\n\n`);

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
        return;
    }

    stream.markdown(`## Type Label\n\n`);

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

async function markAsRead(request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, notification: Notification, cancellationToken: vscode.CancellationToken) {
    stream.markdown(`## Mark As Read\n\n`);
    const tools = vscode.lm.tools.filter(tool => tool.name === 'chat-tools-sample_markNotificationRead');
    const options: vscode.LanguageModelChatRequestOptions = {
        justification: 'Marking notification as read for @cruncher',
        tools,
    };
    const model = await getFastModel(request.model);
    const result = await renderPrompt(
        MarkReadPrompt,
        {
            notification,
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

async function getFastModel(model: vscode.LanguageModelChat) {
    if (model.vendor === 'copilot' && /^o\d+/.test(model.family)) {
        // The o1 models do not currently support tools
        const models = await vscode.lm.selectChatModels({
            vendor: 'copilot',
            family: 'gpt-4o'
        });
        return models[0] ?? model;
    }
    return model;
}