/**
 * OpenAI LLM Provider
 *
 * Uses OpenAI-compatible Chat Completions API over fetch.
 * Supports:
 *   OPENAI_API_KEY for auth
 *   OPENAI_BASE_URL for custom endpoints
 *   TIK_MODEL for model selection
 */
import type { ILLMProvider, LLMPlanResponse, ChatMessage, ChatResponse, LLMToolDef, LLMCallOptions } from '@tik/shared';
export declare function hasOpenAICredentials(): boolean;
export declare class OpenAILLMProvider implements ILLMProvider {
    name: string;
    private readonly apiKey;
    private readonly baseURL;
    private readonly model;
    constructor(model?: string);
    plan(prompt: string, context: string): Promise<LLMPlanResponse>;
    complete(prompt: string, _options?: LLMCallOptions): Promise<string>;
    chat(messages: ChatMessage[], tools?: LLMToolDef[]): Promise<ChatResponse>;
    chatWithContext(messages: ChatMessage[], systemPrompt: string, context: string, tools?: LLMToolDef[]): Promise<ChatResponse>;
    private toOpenAIMessages;
    private createChatCompletion;
    private toChatResponse;
    private extractText;
    private normalizeContent;
    private parseArguments;
    private parseJsonResponse;
}
//# sourceMappingURL=openai-llm.d.ts.map