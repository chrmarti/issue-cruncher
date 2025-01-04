import { RestEndpointMethodTypes } from '@octokit/rest';
import {
	BasePromptElementProps,
	PromptElement,
	PromptSizing,
	UserMessage
} from '@vscode/prompt-tsx';
import * as vscode from 'vscode';

export type SearchIssue = RestEndpointMethodTypes['search']['issuesAndPullRequests']['response']['data']['items'][0];
export type IssueComment = RestEndpointMethodTypes['issues']['listComments']['response']['data'][0];

export interface KnownIssue {
	summary: string;
	issue: SearchIssue;
}

export interface SummarizationProps extends BasePromptElementProps {
	issue: SearchIssue;
	comments: IssueComment[];
	knownIssues: KnownIssue[];
	request: vscode.ChatRequest;
	context: vscode.ChatContext;
}

export class SummarizationPrompt extends PromptElement<SummarizationProps, void> {
	render(_state: void, _sizing: PromptSizing) {
		return (
			<UserMessage>
				# Summarize GitHub Issue<br />
				<br />
				Task: Summarize the following GitHub issue and its comments in a few sentences.<br />
				- What are the main points that could lead to the resolution of the issue?<br />
				- Is there any information missing that the author needs to supply to resolve the issue?<br />
				- What is the resolution of the issue?<br />
				<br />
				## Issue {this.props.issue.html_url} by @{this.props.issue.user?.login}<br />
				<br />
				Title: {this.props.issue.title}<br />
				<br />
				State: {this.props.issue.state}{this.props.issue.state_reason ? <> ({this.props.issue.state_reason})</> : ''}<br />
				<br />
				{this.props.issue.body?.replace(/(^|\n)#/g, '$1###')}<br />
				<br />
				{this.props.comments.map(comment => (
					<>
						### Comment by @{comment.user?.login}<br />
						<br />
						{comment.body?.replace(/(^|\n)#/g, '$1####')}<br />
						<br />
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
				<br />
				## Issue {this.props.issue.html_url} Summary<br />
				<br />
				{this.props.summary.replace(/(^|\n)#/g, '$1###')}<br />
			</UserMessage>
		);
	}
}

export interface TypeLabelProps extends BasePromptElementProps {
	typeLabels: string[];
	issue: SearchIssue;
	summary: string;
	request: vscode.ChatRequest;
	context: vscode.ChatContext;
}

export class TypeLabelPrompt extends PromptElement<TypeLabelProps, void> {
	render(_state: void, _sizing: PromptSizing) {
		const typeLabels = this.props.typeLabels;
		const typeLabelString = `${typeLabels.slice(0, -1).join(', ')} or ${typeLabels[typeLabels.length - 1]}`;
		return (
			<UserMessage>
				# Add Type Label to GitHub Issue<br />
				<br />
				Task: Add one of the labels {typeLabelString} to the issue.<br />
				<br />
				## Issue {this.props.issue.html_url} Summary<br />
				<br />
				{this.props.summary.replace(/(^|\n)#/g, '$1###')}<br />
			</UserMessage>
		);
	}
}
