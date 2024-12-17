import {
	BasePromptElementProps,
	PromptElement,
	PromptSizing,
	UserMessage
} from '@vscode/prompt-tsx';
import * as vscode from 'vscode';

export interface CruncherProps extends BasePromptElementProps {
	prompt: string;
	request: vscode.ChatRequest;
	context: vscode.ChatContext;
}

export class CruncherPrompt extends PromptElement<CruncherProps, void> {
	render(_state: void, _sizing: PromptSizing) {
		return (
			<>
				<UserMessage>{this.props.prompt}</UserMessage>
			</>
		);
	}
}
