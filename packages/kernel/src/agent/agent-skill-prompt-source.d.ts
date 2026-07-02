export interface AgentInstalledSkillConfig {
    skillName?: string;
    skillPath?: string;
}
export interface AgentInstalledSkillPrompt {
    skillName: string;
    skillPath: string;
    description?: string;
    prompt: string;
}
export interface AgentInstalledSkillPromptSource {
    load(config: AgentInstalledSkillConfig): Promise<AgentInstalledSkillPrompt>;
}
export declare class LocalAgentSkillPromptSource implements AgentInstalledSkillPromptSource {
    private readonly options;
    constructor(options?: {
        codexHome?: string;
        agentSkillsRoot?: string;
    });
    load(config: AgentInstalledSkillConfig): Promise<AgentInstalledSkillPrompt>;
    private resolveSkillPath;
}
//# sourceMappingURL=agent-skill-prompt-source.d.ts.map