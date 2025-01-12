import { RestEndpointMethodTypes } from '@octokit/rest';
import {
	BasePromptElementProps,
	PromptElement,
	PromptSizing,
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
				Task: Summarize the following GitHub issue and its comments in a few sentences.<br />
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
				Task: Summarize the new comments on the following GitHub issue.<br />
				- What information do the new comments add to the issue?
				- Are there any additional points added by the new comments that can lead to the resolution of the issue?<br />
				<br />
				## Issue {this.props.issue.html_url} by @{this.props.issue.user?.login}{teamAssociations.includes(this.props.issue.author_association) ? <> (project member)</> : <> (community member)</>}<br />
				<br />
				Title: {this.props.issue.title}<br />
				<br />
				State: {this.props.issue.state}{this.props.issue.state_reason ? <> ({this.props.issue.state_reason})</> : ''}<br />
				<br />
				{this.props.comments.map(comment => (
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

export interface FindDuplicateProps extends BasePromptElementProps {
	issue: SearchIssue;
	summary: string;
	knownIssues: KnownIssue[];
	request: vscode.ChatRequest;
	context: vscode.ChatContext;
}

export class FindDuplicatePrompt extends PromptElement<FindDuplicateProps, void> {
	render(_state: void, _sizing: PromptSizing) {
		return (
			<UserMessage>
				# Find Duplicate Issue<br />
				<br />
				Task: Check if the current GitHub issue is already tracked in an existing issue and, if so, close the current issue as a duplicate of this existing original issue.<br />
				- Is one of the existing issues sufficiently similar to the current issue to consider them duplicates?<br />
				- Are the main points of one of the existing issues the same or very similar to the main points of the current issue?<br />
				<br />
				## Current Issue {this.props.issue.repository_url.split('/').slice(-2).join('/')}#{this.props.issue.number}<br />
				<br />
				{this.props.summary.replace(/(^|\n)#/g, '$1#')}<br />
				{this.props.knownIssues.filter(issue => issue.issue.url !== this.props.issue.url).map(issue => (
					<>
						<br />
						## Existing Issue {issue.issue.repository_url.split('/').slice(-2).join('/')}#{issue.issue.number}<br />
						<br />
						{issue.summary.replace(/(^|\n)#/g, '$1#')}<br />
					</>
				))}
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
				Task: Mark the notification with id {this.props.notification.id} as read.<br />
			</UserMessage>
		);
	}
}
