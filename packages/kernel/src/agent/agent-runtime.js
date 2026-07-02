/**
 * Agent Runtime (Phase 2.7)
 *
 * Wraps ILLMProvider with AgentSpec to create an executable agent.
 * Implements the AgentRuntime interface from @tik/shared for compatibility.
 */
import { LocalAgentSkillPromptSource, } from './agent-skill-prompt-source.js';
/**
 * AgentRuntime binds an AgentSpec with an LLM provider.
 * Implements the legacy AgentRuntime interface for session compatibility.
 */
export class AgentRuntime {
    spec;
    options;
    /** Role identifier (from interface) */
    role;
    /** LLM provider (from interface) */
    llm;
    effectiveInstructions;
    constructor(spec, llm, options = {}) {
        this.spec = spec;
        this.options = options;
        this.role = spec.role;
        this.llm = llm;
    }
    /** System prompt (from interface) */
    get systemPrompt() {
        return this.effectiveInstructions ?? this.spec.instructions;
    }
    /**
     * Run a single turn of agent execution.
     * Handles both chatWithContext and fallback to chat.
     */
    async runTurn(input) {
        const instructions = await this.getEffectiveInstructions();
        // Prefer chatWithContext if available (Phase 2 addition)
        if (this.llm.chatWithContext) {
            return this.llm.chatWithContext(input.messages, instructions, input.context, input.tools, input.options);
        }
        // Fallback: inject system prompt + context as first message
        const messagesWithSystem = [
            {
                role: 'system',
                content: `${instructions}\n\n${input.context}`,
            },
            ...input.messages.filter(m => m.role !== 'system'),
        ];
        return this.llm.chat(messagesWithSystem, input.tools);
    }
    /**
     * Get the agent's ID.
     */
    get id() {
        return this.spec.id;
    }
    async getEffectiveInstructions() {
        if (this.effectiveInstructions)
            return this.effectiveInstructions;
        const base = this.spec.instructions;
        if (!this.spec.skillName && !this.spec.skillPath) {
            this.effectiveInstructions = base;
            return base;
        }
        try {
            const promptSource = this.options.skillPromptSource ?? new LocalAgentSkillPromptSource();
            const skill = await promptSource.load({
                skillName: this.spec.skillName,
                skillPath: this.spec.skillPath,
            });
            this.effectiveInstructions = [
                base,
                '',
                'Installed skill overlay:',
                `- Skill: ${skill.skillName}`,
                `- Skill path: ${skill.skillPath}`,
                ...(skill.description ? [`- Skill description: ${skill.description}`] : []),
                '- Treat this installed skill as additional methodology guidance for the current agent profile.',
                '- Use the installed skill to sharpen workflow, validation, and frontend delivery discipline without ignoring the agent-specific tool boundaries.',
                '',
                'Installed skill instructions:',
                skill.prompt,
            ].join('\n');
            return this.effectiveInstructions;
        }
        catch (err) {
            if (this.spec.skillOptional === false) {
                throw err;
            }
            this.effectiveInstructions = base;
            return base;
        }
    }
}
//# sourceMappingURL=agent-runtime.js.map