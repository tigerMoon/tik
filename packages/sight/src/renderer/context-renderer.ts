/**
 * Context Renderer (Phase 2.8)
 *
 * Replaces JSON.stringify(context) with section-based, role-aware rendering.
 * Each agent role gets a different "evidence pack" tailored to its decision.
 *
 * Section ordering follows claw-code-main's prompt.rs pattern:
 * 1. Environment (always)
 * 2. Instructions (if any)
 * 3. Spec (strong for planner)
 * 4. Repo (strong for planner)
 * 5. Git diff (strong for coder/reviewer)
 * 6. Run context (strong for reviewer)
 * 7. Strategy/constraints
 * 8. Conversation summary (if compacted)
 */

import type {
  RuntimeContextEnvelope,
  BootstrapContext,
  ContextFile,
  EnvironmentContext,
  SpecContext,
  RepoContext,
  RunContext,
  ConversationContext,
} from '@tik/shared';
import type { RepoCandidateMatch } from '../context/repo-candidate-finder.js';

const MAX_SECTION_CHARS = 6_000;

type RepoContextWithCandidates = RepoContext & {
  candidates?: RepoCandidateMatch[];
};

export class ContextRenderer {
  /**
   * Render a RuntimeContextEnvelope into a formatted string for LLM consumption.
   */
  render(envelope: RuntimeContextEnvelope): string {
    const agent = envelope.meta.agent;
    const sections: string[] = [];

    // 1. Environment (always present)
    sections.push(this.renderEnvironment(envelope.bootstrap));

    // 2. Instructions
    if (envelope.bootstrap.instructionFiles?.length) {
      sections.push(this.renderInstructions(envelope.bootstrap.instructionFiles));
    }

    // 3. Environment pack
    if (envelope.execution.environment) {
      sections.push(this.renderEnvironmentPack(envelope.execution.environment, agent));
    }

    // 4. Task & Strategy
    sections.push(this.renderMeta(envelope));

    // 5. Spec context
    if (envelope.execution.spec) {
      const rendered = this.renderSpec(envelope.execution.spec, agent);
      if (rendered) sections.push(rendered);
    }

    // 6. Repo context
    if (envelope.execution.repo) {
      const rendered = this.renderRepo(envelope.execution.repo, agent);
      if (rendered) sections.push(rendered);
    }

    const searchGuidance = this.renderSearchGuidance(envelope.execution.repo, agent);
    if (searchGuidance) {
      sections.push(searchGuidance);
    }

    // 7. Git diff (coder and reviewer)
    if (envelope.bootstrap.gitDiff && agent !== 'planner') {
      sections.push(`# Git Changes\n\`\`\`\n${envelope.bootstrap.gitDiff}\n\`\`\``);
    }

    // 8. Run context
    if (envelope.execution.run) {
      const rendered = this.renderRun(envelope.execution.run, agent);
      if (rendered) sections.push(rendered);
    }

    // 9. Session memory / conversation summary
    if (envelope.conversation.compactSummary) {
      sections.push(this.renderConversation(envelope.conversation));
    }

    return sections.join('\n\n---\n\n');
  }

  // ─── Section Renderers ────────────────────────────────────

  private renderEnvironment(bootstrap: BootstrapContext): string {
    const lines = [
      '# Environment',
      `- Working Directory: ${bootstrap.cwd}`,
      `- Date: ${bootstrap.currentDate}`,
    ];
    if (bootstrap.os) lines.push(`- OS: ${bootstrap.os}`);
    if (bootstrap.gitStatus) {
      lines.push(`- Git Status:\n\`\`\`\n${bootstrap.gitStatus}\n\`\`\``);
    }
    return lines.join('\n');
  }

  private renderInstructions(files: ContextFile[]): string {
    const lines = ['# Project Instructions'];
    for (const file of files) {
      lines.push(`## ${file.path} (${file.scope})`);
      lines.push(file.content);
    }
    return lines.join('\n');
  }

  private renderMeta(envelope: RuntimeContextEnvelope): string {
    return [
      '# Current Task',
      `- Task ID: ${envelope.meta.taskId}`,
      `- Strategy: ${envelope.meta.strategy}`,
      `- Agent Role: ${envelope.meta.agent}`,
      `- Iteration: ${envelope.meta.iteration}`,
    ].join('\n');
  }

  private renderEnvironmentPack(environment: EnvironmentContext, agent: string): string {
    const pack = environment.activePack;
    const parts = [
      '# Environment Pack',
      `- Active Pack: ${pack.name} (${pack.id})`,
      `- Version: ${pack.version}`,
      `- Description: ${pack.description}`,
      `- Available Packs: ${environment.availablePackIds.join(', ')}`,
    ];

    if (pack.tools.length > 0 && agent !== 'reviewer') {
      parts.push(`## Tools\n- ${pack.tools.join('\n- ')}`);
    }

    if (pack.skills.length > 0) {
      parts.push(`## Skills\n- ${pack.skills.join('\n- ')}`);
    }

    if (pack.knowledge.length > 0) {
      parts.push(`## Knowledge Sources\n${pack.knowledge.map((source) => `- ${source.label} [${source.kind}]`).join('\n')}`);
    }

    if (pack.policies.length > 0) {
      parts.push(`## Policies\n- ${pack.policies.join('\n- ')}`);
    }

    if (pack.workflowBindings.length > 0 && agent === 'planner') {
      parts.push(`## Workflow Bindings\n${pack.workflowBindings.map((binding) => `- ${binding.workflow}: ${Object.entries(binding.phases).map(([phase, skills]) => `${phase}=[${skills.join(', ')}]`).join('; ')}`).join('\n')}`);
    }

    if (pack.evaluators.length > 0 && agent === 'reviewer') {
      parts.push(`## Evaluators\n- ${pack.evaluators.join('\n- ')}`);
    }

    return parts.join('\n\n');
  }

  private renderSpec(spec: SpecContext, agent: string): string | null {
    const parts: string[] = ['# Specification'];

    // Planner gets full spec; coder gets plan+tasks; reviewer gets summary
    if (spec.spec) {
      if (agent === 'planner') {
        parts.push(`## Feature Spec\n${this.truncate(spec.spec, MAX_SECTION_CHARS)}`);
      } else if (agent === 'coder') {
        parts.push(`## Feature Spec (summary)\n${this.truncate(spec.spec, 1500)}`);
      }
      // reviewer: skip full spec
    }

    if (spec.plan) {
      if (agent === 'reviewer') {
        parts.push(`## Plan (summary)\n${this.truncate(spec.plan, 1500)}`);
      } else {
        parts.push(`## Plan\n${this.truncate(spec.plan, MAX_SECTION_CHARS)}`);
      }
    }

    if (spec.tasks && (agent === 'coder' || agent === 'planner')) {
      parts.push(`## Tasks\n${this.truncate(spec.tasks, MAX_SECTION_CHARS)}`);
    }

    if (spec.checklist && agent === 'reviewer') {
      parts.push(`## Checklist\n${this.truncate(spec.checklist, MAX_SECTION_CHARS)}`);
    }

    return parts.length > 1 ? parts.join('\n\n') : null;
  }

  private renderRepo(repo: RepoContext, agent: string): string | null {
    // Only planner and coder benefit from repo structure
    if (agent === 'reviewer') return null;

    const repoWithCandidates = repo as RepoContextWithCandidates;
    const parts: string[] = ['# Repository'];

    if (repoWithCandidates.candidates?.length) {
      const candidateList = repoWithCandidates.candidates
        .map((candidate) => `- ${candidate.path} [${candidate.kind}] score=${candidate.score}: ${candidate.reason}`)
        .join('\n');
      parts.push(`## Likely Target Paths\n${candidateList}`);
    }

    if (repo.modules?.length) {
      const moduleList = repo.modules
        .map(m => `- ${m.name} (${m.type}) at ${m.path}`)
        .join('\n');
      parts.push(`## Modules\n${moduleList}`);
    }

    if (repo.patterns?.length) {
      const patternList = repo.patterns
        .map(p => `- ${p.type}: ${p.examples.slice(0, 3).join(', ')}`)
        .join('\n');
      parts.push(`## Patterns\n${patternList}`);
    }

    return parts.length > 1 ? parts.join('\n\n') : null;
  }

  private renderSearchGuidance(repo: RepoContext | undefined, agent: string): string | null {
    const repoWithCandidates = repo as RepoContextWithCandidates | undefined;
    const candidates = repoWithCandidates?.candidates || [];
    if (candidates.length === 0) return null;

    const lines = [
      '# Search Guidance',
      '- The user may reference partial module or directory names. Treat the likely target paths above as path completions, not just loose suggestions.',
      '- Inspect likely target paths first before widening search to the whole repository.',
      '- Prefer structured search tools (`glob`, `grep`, `read_file`) over broad shell search.',
      '- If a likely target path is a directory, use `glob`/`grep` inside that directory before attempting `read_file`.',
    ];

    if (agent !== 'reviewer') {
      lines.push('- Avoid repeated repo-wide `bash find` loops once a likely module has been identified.');
    }

    return lines.join('\n');
  }

  private renderRun(run: RunContext, agent: string): string | null {
    const parts: string[] = ['# Execution History'];

    // Reviewer gets more run detail; planner gets summary; coder gets failures
    if (run.history?.length) {
      const recent = agent === 'reviewer' ? run.history.slice(-5) : run.history.slice(-2);
      const historyStr = recent
        .map(h => `- Iter ${h.iteration}: fitness=${h.fitness.toFixed(3)}, drift=${h.drift.toFixed(2)}`)
        .join('\n');
      parts.push(`## Recent Iterations\n${historyStr}`);
    }

    if (run.failures?.length) {
      const recent = run.failures.slice(-5);
      const failStr = recent
        .map(f => `- [${f.type}] ${f.message}`)
        .join('\n');
      parts.push(`## Recent Failures\n${failStr}`);
    }

    if (run.patterns?.length && agent === 'reviewer') {
      const patternStr = run.patterns
        .map(p => `- ${p.description} (confidence: ${p.confidence.toFixed(2)})`)
        .join('\n');
      parts.push(`## Learned Patterns\n${patternStr}`);
    }

    return parts.length > 1 ? parts.join('\n\n') : null;
  }

  private renderConversation(conversation: ConversationContext): string {
    const parts = ['# Session Memory'];

    if (conversation.sessionMemory) {
      const memory = conversation.sessionMemory;
      const lines: string[] = [];

      if (memory.goal) lines.push(`- Goal: ${memory.goal}`);
      if (memory.currentAgent) lines.push(`- Current agent: ${memory.currentAgent}`);
      if (typeof memory.step === 'number') lines.push(`- Step: ${memory.step}`);
      if (memory.keyFiles?.length) lines.push(`- Key files: ${memory.keyFiles.join(', ')}`);
      if (memory.recentActions?.length) lines.push(`- Recent actions: ${memory.recentActions.join(', ')}`);
      if (memory.pendingWork?.length) lines.push(`- Pending work: ${memory.pendingWork.join(' | ')}`);
      if (memory.currentWork) lines.push(`- Current work: ${memory.currentWork}`);
      if (memory.blockers?.length) lines.push(`- Blockers: ${memory.blockers.join(' | ')}`);
      if (typeof memory.implementationReady === 'boolean') {
        lines.push(`- Implementation ready: ${memory.implementationReady ? 'yes' : 'no'}`);
      }
      if (memory.currentFocus) lines.push(`- Current focus: ${memory.currentFocus}`);

      if (lines.length > 0) {
        parts.push(lines.join('\n'));
      }
    }

    if (conversation.compactSummary) {
      parts.push('## Previous Context');
      parts.push(conversation.compactSummary);
    }

    return parts.join('\n\n');
  }

  // ─── Helpers ──────────────────────────────────────────────

  private truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + '\n[... truncated]';
  }
}
