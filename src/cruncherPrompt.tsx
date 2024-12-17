import { RestEndpointMethodTypes } from '@octokit/rest';
import {
	BasePromptElementProps,
	PromptElement,
	PromptSizing,
	UserMessage
} from '@vscode/prompt-tsx';
import * as vscode from 'vscode';

export interface CruncherProps extends BasePromptElementProps {
	issue: RestEndpointMethodTypes['search']['issuesAndPullRequests']['response']['data']['items'][0];
	comments: RestEndpointMethodTypes['issues']['listComments']['response']['data'];
	request: vscode.ChatRequest;
	context: vscode.ChatContext;
}

export class CruncherPrompt extends PromptElement<CruncherProps, void> {
	render(_state: void, _sizing: PromptSizing) {
		return (
			<UserMessage>
				# Triage GitHub Issue<br />
				<br />
				Task:<br />
				- Summarize the following GitHub issue and its comments in a few sentences.<br />
				- Add then one of the labels 'bug', 'feature-request', 'question', 'upstream' or 'info-needed' to the issue.<br />
				<br />
				## Issue {this.props.issue.html_url} by @{this.props.issue.user?.login}<br />
				<br />
				Title: {this.props.issue.title}<br />
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
