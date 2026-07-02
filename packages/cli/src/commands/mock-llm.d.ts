/**
 * Mock LLM Provider
 *
 * Placeholder LLM provider for development/testing.
 * In production, replace with Claude/OpenAI API integration.
 */
import type { ILLMProvider, LLMPlanResponse, ChatMessage, ChatResponse, LLMToolDef, LLMCallOptions } from '@tik/shared';
export declare class MockLLMProvider implements ILLMProvider {
    name: string;
    plan(prompt: string, _context: string): Promise<LLMPlanResponse>;
    complete(prompt: string, _options?: LLMCallOptions): Promise<string>;
    chat(_messages: ChatMessage[], _tools?: LLMToolDef[]): Promise<ChatResponse>;
    chatWithContext(messages: ChatMessage[], _systemPrompt: string, _context: string, _tools?: LLMToolDef[]): Promise<ChatResponse>;
}
//# sourceMappingURL=mock-llm.d.ts.map