import { RestEndpointMethodTypes } from '@octokit/rest';
import {
	BasePromptElementProps,
	PromptElement,
	PromptSizing,
	TextChunk,
	UserMessage
} from '@vscode/prompt-tsx';
import * as vscode from 'vscode';

export type CurrentUser = RestEndpointMethodTypes['users']['getAuthenticated']['response']['data'];
export type SearchIssue = RestEndpointMethodTypes['issues']['get']['response']['data'] | RestEndpointMethodTypes['search']['issuesAndPullRequests']['response']['data']['items'][0];
export type Notification = RestEndpointMethodTypes['activity']['listNotificationsForAuthenticatedUser']['response']['data'][0];
export type IssueComment = RestEndpointMethodTypes['issues']['listComments']['response']['data'][0];

export interface KnownIssue {
	summary: string;
	issue: SearchIssue;
}

export interface SummarizationProps extends BasePromptElementProps {
	currentUser: CurrentUser;
	issue: SearchIssue;
	comments: IssueComment[];
	request: vscode.ChatRequest;
	context: vscode.ChatContext;
}

export class SummarizationPrompt extends PromptElement<SummarizationProps, void> {
	render(_state: void, _sizing: PromptSizing) {
		const teamAssociations = ['MEMBER', 'OWNER'];
		return (
			<UserMessage>
				# Summarize GitHub Issue<br />
				<br />
				Task: Summarize the following GitHub issue and its comments in a few sentences for @{this.props.currentUser.login}.<br />
				- What are the main points that could lead to the resolution of the issue?<br />
				- Is there any information missing that the author needs to supply to resolve the issue? Information asked for by a project member is important.<br />
				- What is the resolution of the issue?<br />
				<br />
				## Issue {this.props.issue.html_url} by @{this.props.issue.user?.login}{teamAssociations.includes(this.props.issue.author_association) ? <> (project member)</> : <> (community member)</>}<br />
				<br />
				Title: {this.props.issue.title}<br />
				<br />
				State: {this.props.issue.state}{this.props.issue.state_reason ? <> ({this.props.issue.state_reason})</> : ''}<br />
				<br />
				{this.props.issue.body?.replace(/(^|\n)#/g, '$1###')}<br />
				<br />
				{this.props.comments.map(comment => (
					<>
						### Comment by @{comment.user?.login}{teamAssociations.includes(comment.author_association) ? <> (project member)</> : <> (community member)</>}<br />
						<br />
						{comment.body?.replace(/(^|\n)#/g, '$1####')}<br />
						<br />
					</>
				))}
			</UserMessage>
		);
	}
}

export interface UpdateSummarizationProps extends BasePromptElementProps {
	currentUser: CurrentUser;
	issue: SearchIssue;
	comments: IssueComment[];
	newComments: IssueComment[];
	request: vscode.ChatRequest;
	context: vscode.ChatContext;
}

export class UpdateSummarizationPrompt extends PromptElement<UpdateSummarizationProps, void> {
	render(_state: void, _sizing: PromptSizing) {
		const teamAssociations = ['MEMBER', 'OWNER'];
		return (
			<UserMessage>
				# Summarize GitHub Comments<br />
				<br />
				Task: Summarize the new comments on the following GitHub issue for @{this.props.currentUser.login}.<br />
				- What information do the new comments add to the issue?
				- Are there any additional points added by the new comments that can lead to the resolution of the issue?<br />
				<br />
				## Issue {this.props.issue.html_url} by @{this.props.issue.user?.login}{teamAssociations.includes(this.props.issue.author_association) ? <> (project member)</> : <> (community member)</>}<br />
				<br />
				Title: {this.props.issue.title}<br />
				<br />
				State: {this.props.issue.state}{this.props.issue.state_reason ? <> ({this.props.issue.state_reason})</> : ''}<br />
				<br />
				{this.props.newComments.map(comment => (
					<>
						### {this.props.newComments.indexOf(comment) !== -1 ? 'New' : 'Old'} Comment by @{comment.user?.login}{teamAssociations.includes(comment.author_association) ? <> (project member)</> : <> (community member)</>}<br />
						<br />
						{comment.body?.replace(/(^|\n)#/g, '$1####')}<br />
						<br />
					</>
				))}
			</UserMessage>
		);
	}
}

export interface CheckResolutionProps extends BasePromptElementProps {
	issue: SearchIssue;
	summary: string;
	request: vscode.ChatRequest;
	context: vscode.ChatContext;
}

export class CheckResolutionPrompt extends PromptElement<CheckResolutionProps, void> {
	render(_state: void, _sizing: PromptSizing) {
		return (
			<UserMessage>
				# Check for Issue Resolution<br />
				<br />
				<ToolsReminder />
				<br />
				Task: Check if the current GitHub issue has a resolution and can be closed.<br />
				- If the issue can be closed, close it with the comment "Closing as resolved. Thanks!".<br />
				<br />
				## Current Issue {this.props.issue.repository_url.split('/').slice(-2).join('/')}#{this.props.issue.number}<br />
				<br />
				{this.props.summary.replace(/(^|\n)#/g, '$1#')}<br />
			</UserMessage>
		);
	}
}

export interface FindDuplicateProps extends BasePromptElementProps {
	issue: SearchIssue;
	summary: string;
	knownIssues: KnownIssue[];
	request: vscode.ChatRequest;
	context: vscode.ChatContext;
}

export class FindDuplicatePrompt extends PromptElement<FindDuplicateProps, void> {
	render(_state: void, _sizing: PromptSizing) {
		const knownIssues = this.props.knownIssues.filter(issue => issue.issue.url !== this.props.issue.url);
		knownIssues.sort((a, b) => a.issue.updated_at < b.issue.updated_at ? 1 : -1);
		return (
			<UserMessage>
				# Find Duplicate Issue<br />
				<br />
				<ToolsReminder />
				<br />
				Task: Check if the new GitHub issue is already tracked in an existing issue and, if so, close the new issue as a duplicate of this existing original issue.<br />
				- Are the details of one of the existing issues the same or very similar to the details of the new issue?<br />
				- Make a convincing case for closing the new issue as a duplicate of the existing original issue.<br />
				<br />
				## New Issue {this.props.issue.repository_url.split('/').slice(-2).join('/')}#{this.props.issue.number}<br />
				<br />
				{this.props.summary.replace(/(^|\n)#/g, '$1#')}<br />
				{knownIssues.map((issue, i) => (
					<TextChunk priority={knownIssues.length - i}>
						<br />
						## Existing Issue {issue.issue.repository_url.split('/').slice(-2).join('/')}#{issue.issue.number}<br />
						<br />
						{issue.summary.replace(/(^|\n)#/g, '$1#')}<br />
					</TextChunk>
				))}
			</UserMessage>
		);
	}
}

export interface CustomInstructionsProps extends BasePromptElementProps {
	currentUser: CurrentUser;
	instructions: string;
	issue: SearchIssue;
	newComments: IssueComment[];
	summary: string;
	updateSummary: string | undefined;
	request: vscode.ChatRequest;
	context: vscode.ChatContext;
}

export class CustomInstructionsPrompt extends PromptElement<CustomInstructionsProps, void> {
	render(_state: void, _sizing: PromptSizing) {
		const { issue, newComments } = this.props;
		const [owner, repo] = issue.repository_url.split('/').slice(-2);
		return (
			<UserMessage>
				# Handle GitHub Issue<br />
				<br />
				<ToolsReminder />
				<br />
				Task: Apply to following instructions to the below issue on behalf of @{this.props.currentUser.login}. Use the available tools when appropriate.<br />
				<br />
				## Instructions<br />
				<br />
				{this.props.instructions.replace(/(^|\n)#/g, '$1###')}<br />
				<br />
				## Issue Overview<br />
				<br />
				Issue: {owner}/{repo}#{issue.number}<br />
				- State: {issue.state}<br />
				- Labels: {issue.labels?.map(label => typeof label === 'string' ? label : label.name).map(label => `\`${label}\``).join(', ') || '-'}<br />
				- Assignee: {issue.assignees?.map(assignee => `@${assignee.login}`).join(', ') || '-'}<br />
				- New Comment: {newComments.length ? new Date(newComments[0].created_at).toLocaleDateString() : '-'}<br />
				- Title: {issue.title}<br />
				- Author: @{issue.user?.login}<br />
				- Created: {new Date(issue.created_at).toLocaleDateString()}<br />
				{this.props.updateSummary && (
					<>
						<br />
						## Issue Update Summary<br />
						<br />
						{this.props.updateSummary.replace(/(^|\n)#/g, '$1###')}<br />
					</>
				)}
				<br />
				## Issue Summary<br />
				<br />
				{this.props.summary.replace(/(^|\n)#/g, '$1###')}<br />
			</UserMessage>
		);
	}
}

export interface InfoNeededLabelProps extends BasePromptElementProps {
	infoNeededLabel: string;
	issue: SearchIssue;
	summary: string;
	request: vscode.ChatRequest;
	context: vscode.ChatContext;
}

export class InfoNeededLabelPrompt extends PromptElement<InfoNeededLabelProps, void> {
	render(_state: void, _sizing: PromptSizing) {
		return (
			<UserMessage>
				# Add {this.props.infoNeededLabel} Label If Needed<br />
				<br />
				<ToolsReminder />
				<br />
				Task: Check if the GitHub issue summary indicates that more information is needed to resolve the issue and, if so, add the {this.props.infoNeededLabel} label.<br />
				- E.g., information asked for by a project member.<br />
				<br />
				## Issue {this.props.issue.html_url} Summary<br />
				<br />
				{this.props.summary.replace(/(^|\n)#/g, '$1###')}<br />
			</UserMessage>
		);
	}
}

export interface TypeLabelProps extends BasePromptElementProps {
	typeLabels: Record<string, string>;
	issue: SearchIssue;
	summary: string;
	request: vscode.ChatRequest;
	context: vscode.ChatContext;
}

export class TypeLabelPrompt extends PromptElement<TypeLabelProps, void> {
	render(_state: void, _sizing: PromptSizing) {
		const typeLabels = Object.keys(this.props.typeLabels);
		const typeLabelStrings = typeLabels.map(label => `\`${label}\``);
		const typeLabelsString = `${typeLabelStrings.slice(0, -1).join(', ')} or ${typeLabelStrings[typeLabelStrings.length - 1]}`;
		return (
			<UserMessage>
				# Add Type Label to GitHub Issue<br />
				<br />
				<ToolsReminder />
				<br />
				Task: Add one of the labels {typeLabelsString} to the issue.<br />
				{typeLabels.map(label => (
					<>- `{label}`: {this.props.typeLabels[label]}<br /></>
				))}
				<br />
				## Issue {this.props.issue.html_url} Summary<br />
				<br />
				{this.props.summary.replace(/(^|\n)#/g, '$1###')}<br />
			</UserMessage>
		);
	}
}

export interface MarkReadProps extends BasePromptElementProps {
	notification: Notification;
	request: vscode.ChatRequest;
	context: vscode.ChatContext;
}

export class MarkReadPrompt extends PromptElement<MarkReadProps, void> {
	render(_state: void, _sizing: PromptSizing) {
		return (
			<UserMessage>
				# Mark Notification As Read<br />
				<br />
				<ToolsReminder />
				<br />
				Task: Mark the notification with id {this.props.notification.id} as read.<br />
			</UserMessage>
		);
	}
}

class ToolsReminder extends PromptElement {
	render(_state: void, _sizing: PromptSizing) {
		return (<>
			Remember that you can call multiple tools in one response.<br />
			When using a tool, follow the json schema very carefully and make sure to include ALL required properties.<br />
			Always output valid JSON when using a tool.<br />
			If a tool exists to do a task, use the tool instead of asking the user to manually take an action.<br />
			If you say that you will take an action, then go ahead and use the tool to do it. No need to ask permission.<br />
			Never use multi_tool_use.parallel or any tool that does not exist. Use tools using the proper procedure, DO NOT write out a json codeblock with the tool inputs.<br />
			Never say the name of a tool to a user.<br />
		</>);
	}
}
