import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { generateId } from '@tik/shared';
import type {
  AgentRunRecord,
  DiffSummary,
  RunDiffSummary,
  RunProof,
  RunProofStatus,
  RunRiskLevel,
  TranscriptRef,
  WorkbenchArtifactRecord,
} from '@tik/shared';
import type { AppendArtifactVersionInput, ArtifactRegistry, CreateArtifactInput } from '../artifacts/artifact-registry.js';
import type { AgentRunCompletion, AgentRuntimeRunner } from './agent-runtime-runner.js';
import { renderRunReviewArtifact, type RunProofRenderTask } from './run-proof-renderer.js';
import { FileRunProofStore } from './run-proof-store.js';

const execFileAsync = promisify(execFile);

export interface RunProofCommandRunnerInput {
  command: string;
  cwd: string;
  timeoutMs?: number;
}

export interface RunProofCommandRunnerResult {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
}

export type RunProofCommandRunner = (input: RunProofCommandRunnerInput) => Promise<RunProofCommandRunnerResult>;

export interface RunProofServiceOptions {
  proofStore: FileRunProofStore;
  artifacts: ArtifactRegistry;
  runCommand?: RunProofCommandRunner;
  validationTimeoutMs?: number;
}

export interface RunProofCreateInput {
  task: RunProofRenderTask;
  run: AgentRunRecord;
  runner: AgentRuntimeRunner;
  completion: AgentRunCompletion;
  validationCommands?: string[];
  validationCwd?: string;
  now?: string;
}

export class RunProofService {
  constructor(private readonly options: RunProofServiceOptions) {}

  async createProof(input: RunProofCreateInput): Promise<RunProof> {
    const timestamp = input.now || new Date().toISOString();
    const collected = await this.collect(input);
    const transcriptArtifacts = await this.createTranscriptArtifacts(input, collected.transcripts);
    const diffArtifacts = await this.createDiffArtifacts(input, collected.diff);
    const validationRefs = await this.collectValidation(input);
    const status = this.classifyStatus(input.completion, collected.collectionError, collected.diff, validationRefs);
    const risk = this.classifyRisk(status, collected.diff, collected.collectionError);
    const summary = this.summarize(status, collected.diff, input.completion, collected.collectionError, validationRefs);
    const proof: RunProof = {
      id: `proof_${input.run.id}`,
      taskId: input.task.id,
      runId: input.run.id,
      attempt: input.run.attempt,
      status,
      risk,
      summary,
      transcriptArtifactIds: transcriptArtifacts.map((artifact) => artifact.id),
      diff: {
        filesChanged: collected.diff?.changedFiles.length || 0,
        insertions: collected.diff?.insertions,
        deletions: collected.diff?.deletions,
        changedFiles: collected.diff?.changedFiles || [],
        patchArtifactId: diffArtifacts.patch?.id,
        statArtifactId: diffArtifacts.stat?.id,
      },
      validationRefs,
      producedArtifactIds: [],
      failure: this.failureFor(input.completion, collected.collectionError, validationRefs),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const reviewArtifact = await this.createOrAppendRunArtifact({
      taskId: input.task.id,
      title: `Run Review: ${input.run.shortIdentifier} attempt ${input.run.attempt + 1}`,
      kind: 'run_review',
      status: 'needs_review',
      content: renderRunReviewArtifact({ task: input.task, run: input.run, proof }),
      contentType: 'text/markdown',
      extension: 'md',
      changedFiles: proof.diff.changedFiles,
      validationRefs: proof.validationRefs.map((ref) => ref.id),
      producedBy: {
        provider: input.run.runner,
        template: 'run-review',
      },
      summary: proof.summary,
      risks: proof.failure ? [proof.failure.message] : undefined,
      tags: ['run-review', 'review'],
    });
    const saved: RunProof = {
      ...proof,
      producedArtifactIds: [reviewArtifact.id],
      updatedAt: timestamp,
    };
    await this.options.proofStore.saveProof(saved);
    return saved;
  }

  private async collect(input: RunProofCreateInput): Promise<{
    transcripts: TranscriptRef[];
    diff?: DiffSummary;
    collectionError?: Error;
  }> {
    const transcripts = await input.runner.collectTranscript(input.run.id).catch(() => [] as TranscriptRef[]);
    try {
      return {
        transcripts,
        diff: await input.runner.collectDiff(input.run.id),
      };
    } catch (error) {
      return {
        transcripts,
        diff: { changedFiles: [] },
        collectionError: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  private async createTranscriptArtifacts(
    input: RunProofCreateInput,
    transcripts: TranscriptRef[],
  ): Promise<WorkbenchArtifactRecord[]> {
    if (transcripts.length === 0) return [];
    const contentParts: string[] = [];
    for (const transcript of transcripts) {
      const content = await fs.readFile(transcript.path, 'utf-8').catch(() => '');
      if (content) {
        contentParts.push(`## ${path.basename(transcript.path)}\n\n${content}`);
      }
    }
    if (contentParts.length === 0) return [];
    return [
      await this.createOrAppendRunArtifact({
        taskId: input.task.id,
        title: `Run Transcript: ${input.run.shortIdentifier} attempt ${input.run.attempt + 1}`,
        kind: 'transcript',
        status: 'needs_review',
        content: contentParts.join('\n\n'),
        contentType: 'text/plain',
        extension: 'txt',
        producedBy: {
          provider: input.run.runner,
          template: 'run-transcript',
        },
        tags: ['run-transcript'],
      }),
    ];
  }

  private async createDiffArtifacts(
    input: RunProofCreateInput,
    diff?: DiffSummary,
  ): Promise<{ patch?: WorkbenchArtifactRecord; stat?: WorkbenchArtifactRecord }> {
    if (!diff || diff.changedFiles.length === 0) return {};
    const patchContent = diff.patchPath
      ? await fs.readFile(diff.patchPath, 'utf-8').catch(() => '')
      : '';
    const statContent = renderDiffStat(diff);
    const patch = await this.createOrAppendRunArtifact({
      taskId: input.task.id,
      title: `Run Diff: ${input.run.shortIdentifier} attempt ${input.run.attempt + 1}`,
      kind: 'diff',
      status: 'needs_review',
      content: patchContent || statContent,
      contentType: 'text/x-diff',
      extension: 'diff',
      changedFiles: diff.changedFiles,
      producedBy: {
        provider: input.run.runner,
        template: 'run-diff',
      },
      tags: ['run-diff'],
    });
    const stat = await this.createOrAppendRunArtifact({
      taskId: input.task.id,
      title: `Run Diff Stat: ${input.run.shortIdentifier} attempt ${input.run.attempt + 1}`,
      kind: 'diff',
      status: 'needs_review',
      content: await this.readDiffStatContent(diff, statContent),
      contentType: 'text/plain',
      extension: 'txt',
      changedFiles: diff.changedFiles,
      producedBy: {
        provider: input.run.runner,
        template: 'run-diff-stat',
      },
      tags: ['run-diff', 'run-diff-stat'],
    });
    return { patch, stat };
  }

  private async readDiffStatContent(diff: DiffSummary, fallback: string): Promise<string> {
    if (!diff.statPath) return fallback;
    const content = await fs.readFile(diff.statPath, 'utf-8').catch(() => '');
    return content || fallback;
  }

  private async collectValidation(input: RunProofCreateInput): Promise<RunProof['validationRefs']> {
    const commands = (input.validationCommands || []).map((command) => command.trim()).filter(Boolean);
    if (commands.length === 0) return [];
    const refs: RunProof['validationRefs'] = [];
    for (const command of commands) {
      const cwd = input.validationCwd || input.run.projectPath;
      const startedAt = Date.now();
      const result = await this.runValidationCommand({
        command,
        cwd,
        timeoutMs: this.options.validationTimeoutMs,
      });
      const durationMs = result.durationMs ?? Date.now() - startedAt;
      const id = `validation_${generateId()}`;
      const stdoutArtifact = result.stdout
        ? await this.createValidationArtifact(input, {
            id,
            command,
            stream: 'stdout',
            content: result.stdout,
            exitCode: result.exitCode,
          })
        : undefined;
      const stderrArtifact = result.stderr
        ? await this.createValidationArtifact(input, {
            id,
            command,
            stream: 'stderr',
            content: result.stderr,
            exitCode: result.exitCode,
          })
        : undefined;
      refs.push({
        id,
        command,
        cwd,
        exitCode: result.exitCode,
        durationMs,
        stdoutArtifactId: stdoutArtifact?.id,
        stderrArtifactId: stderrArtifact?.id,
        summary: summarizeValidationOutput(result.stdout, result.stderr, result.exitCode),
      });
    }
    return refs;
  }

  private async runValidationCommand(input: RunProofCommandRunnerInput): Promise<RunProofCommandRunnerResult> {
    if (this.options.runCommand) {
      return this.options.runCommand(input);
    }
    return runShellCommand(input);
  }

  private async createValidationArtifact(
    input: RunProofCreateInput,
    validation: {
      id: string;
      command: string;
      stream: 'stdout' | 'stderr';
      content: string;
      exitCode: number | null;
    },
  ): Promise<WorkbenchArtifactRecord> {
    return this.createOrAppendRunArtifact({
      taskId: input.task.id,
      title: `Run Validation ${validation.stream.toUpperCase()}: ${input.run.shortIdentifier} attempt ${input.run.attempt + 1}`,
      kind: 'validation_log',
      status: 'needs_review',
      content: validation.content,
      contentType: 'text/plain',
      extension: 'txt',
      validationRefs: [validation.id],
      producedBy: {
        provider: input.run.runner,
        template: 'run-validation',
      },
      summary: `${validation.command} exited with ${validation.exitCode ?? 'unknown'}`,
      tags: ['run-validation', validation.stream],
    });
  }

  private async createOrAppendRunArtifact(input: CreateArtifactInput): Promise<WorkbenchArtifactRecord> {
    const existing = await this.findExistingRunArtifact(input);
    if (!existing) {
      return this.options.artifacts.create(input);
    }

    const appendInput: AppendArtifactVersionInput = {
      artifactId: existing.id,
      content: input.content,
      contentType: input.contentType,
      extension: input.extension,
      sourceEventIds: input.sourceEventIds,
      sourceEvidenceIds: input.sourceEvidenceIds,
      changedFiles: input.changedFiles,
      validationRefs: input.validationRefs,
      decisionIds: input.decisionIds,
      summary: input.summary,
    };
    return this.options.artifacts.appendVersion(appendInput);
  }

  private async findExistingRunArtifact(input: CreateArtifactInput): Promise<WorkbenchArtifactRecord | undefined> {
    const template = input.producedBy?.template;
    if (!template) return undefined;
    const artifacts = await this.options.artifacts.list({ taskId: input.taskId });
    return artifacts
      .filter((artifact) => (
        artifact.title === input.title
        && artifact.kind === input.kind
        && artifact.producedBy.template === template
      ))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  private classifyStatus(
    completion: AgentRunCompletion,
    collectionError: Error | undefined,
    diff: DiffSummary | undefined,
    validationRefs: RunProof['validationRefs'],
  ): RunProofStatus {
    if (completion.status === 'failed') return 'runner_failed';
    if (collectionError) return 'proof_incomplete';
    if (validationRefs.some((ref) => ref.exitCode !== 0)) return 'validation_failed';
    if (!diff || diff.changedFiles.length === 0) return 'no_change';
    return 'ready_for_review';
  }

  private classifyRisk(
    status: RunProofStatus,
    diff: DiffSummary | undefined,
    collectionError: Error | undefined,
  ): RunRiskLevel {
    if (collectionError || status === 'runner_failed' || status === 'validation_failed' || status === 'proof_incomplete') {
      return 'high';
    }
    if (!diff || diff.changedFiles.length === 0) return 'unknown';
    if (diff.changedFiles.length > 10) return 'medium';
    return 'low';
  }

  private summarize(
    status: RunProofStatus,
    diff: DiffSummary | undefined,
    completion: AgentRunCompletion,
    collectionError: Error | undefined,
    validationRefs: RunProof['validationRefs'],
  ): string {
    if (collectionError) {
      return `Run proof is incomplete because evidence collection failed: ${collectionError.message}`;
    }
    if (completion.status === 'failed') {
      return completion.error ? `Runner failed: ${completion.error}` : 'Runner failed before producing a reviewable result.';
    }
    if (!diff || diff.changedFiles.length === 0) {
      return 'Runner completed, but no file changes were detected.';
    }
    const failedValidation = validationRefs.find((ref) => ref.exitCode !== 0);
    if (failedValidation) {
      return `Runner completed with ${diff.changedFiles.length} changed file${diff.changedFiles.length === 1 ? '' : 's'}, but validation failed: ${failedValidation.command}.`;
    }
    return `Runner completed with ${diff.changedFiles.length} changed file${diff.changedFiles.length === 1 ? '' : 's'} and is ready for review.`;
  }

  private failureFor(
    completion: AgentRunCompletion,
    collectionError: Error | undefined,
    validationRefs: RunProof['validationRefs'],
  ): RunProof['failure'] | undefined {
    if (collectionError) {
      return {
        kind: 'collection_error',
        message: collectionError.message,
        retryable: true,
      };
    }
    const failedValidation = validationRefs.find((ref) => ref.exitCode !== 0);
    if (failedValidation) {
      return {
        kind: 'validation_error',
        message: `Validation command failed: ${failedValidation.command}`,
        retryable: true,
      };
    }
    if (completion.status !== 'failed') return undefined;
    return {
      kind: completion.error?.toLowerCase().includes('timeout') ? 'timeout' : 'runner_error',
      message: completion.error || 'Runtime runner failed.',
      retryable: true,
    };
  }
}

export function toRunDiffSummary(diff: DiffSummary | undefined): RunDiffSummary {
  return {
    filesChanged: diff?.changedFiles.length || 0,
    insertions: diff?.insertions,
    deletions: diff?.deletions,
    changedFiles: diff?.changedFiles || [],
  };
}

function renderDiffStat(diff: DiffSummary): string {
  return [
    `Files changed: ${diff.changedFiles.length}`,
    typeof diff.insertions === 'number' ? `Insertions: ${diff.insertions}` : undefined,
    typeof diff.deletions === 'number' ? `Deletions: ${diff.deletions}` : undefined,
    '',
    ...diff.changedFiles,
  ].filter((line): line is string => line !== undefined).join('\n');
}

async function runShellCommand(input: RunProofCommandRunnerInput): Promise<RunProofCommandRunnerResult> {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync('/bin/sh', ['-lc', input.command], {
      cwd: input.cwd,
      timeout: input.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      exitCode: 0,
      stdout,
      stderr,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      code?: number | string;
      signal?: string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      exitCode: typeof execError.code === 'number' ? execError.code : null,
      stdout: bufferToString(execError.stdout),
      stderr: bufferToString(execError.stderr) || execError.message,
      durationMs: Date.now() - startedAt,
    };
  }
}

function summarizeValidationOutput(stdout: string | undefined, stderr: string | undefined, exitCode: number | null): string {
  const output = [stderr, stdout].find((item) => item?.trim())?.trim();
  if (!output) return `Command exited with ${exitCode ?? 'unknown'}.`;
  return firstLine(output);
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim() || value.trim();
}

function bufferToString(value: string | Buffer | undefined): string {
  if (!value) return '';
  return Buffer.isBuffer(value) ? value.toString('utf-8') : value;
}
