#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalOutputHash } from './_generated/questioner-hash.mjs';

async function main() {
  const [outputPath] = process.argv.slice(2);
  if (!outputPath) {
    throw new Error('Usage: node scripts/post-questioner-output.mjs ./questioner-output.json');
  }

  const contextUrl = requireEnv('TIK_QUESTIONER_CONTEXT_URL');
  const submitUrl = requireEnv('TIK_QUESTIONER_SUBMIT_URL');
  const token = requireEnv('TIK_QUESTIONER_TOKEN');
  const expectedHeadSha = process.env.TIK_EXPECTED_HEAD_SHA;
  const artifactPath = process.env.TIK_QUESTIONER_OUTPUT_PATH;
  const gitStatusAfter = gitStatus();
  const contextResponse = await fetchJson(contextUrl, token);
  const context = contextResponse.context || contextResponse;

  if (expectedHeadSha) {
    const actualHeadSha = gitHead();
    if (actualHeadSha && actualHeadSha !== expectedHeadSha) {
      const output = buildBlockingHeadMismatchOutput(contextResponse, {
        expectedHeadSha,
        actualHeadSha,
        artifactPath,
      });
      output.attestation.outputHash = canonicalOutputHash(output);
      await writeArtifactIfNeeded(output, artifactPath);
      const submitted = await postJson(submitUrl, token, { output, runtimeAudit: { gitStatusAfter } });
      console.log(JSON.stringify({
        action: 'questioner-output-submitted',
        questionerRunId: output.questionerRunId,
        questionerOutputId: output.id,
        verdict: output.verdict,
        outputHash: output.attestation.outputHash,
        headMismatch: {
          expectedHeadSha,
          actualHeadSha,
        },
        response: submitted,
      }, null, 2));
      return;
    }
  }

  const rawOutput = JSON.parse(await readFile(resolve(outputPath), 'utf-8'));
  const output = normalizeOutput(rawOutput, contextResponse, artifactPath);
  const contextForValidation = contextResponse.context || contextResponse;
  validateOutput(output, contextForValidation);
  output.attestation.outputHash = canonicalOutputHash(output);

  await writeArtifactIfNeeded(output, artifactPath);

  const submitted = await postJson(submitUrl, token, { output, runtimeAudit: { gitStatusAfter } });
  console.log(JSON.stringify({
    action: 'questioner-output-submitted',
    questionerRunId: output.questionerRunId,
    questionerOutputId: output.id,
    verdict: output.verdict,
    outputHash: output.attestation.outputHash,
    response: submitted,
  }, null, 2));
}

function buildBlockingHeadMismatchOutput(response, input) {
  const context = response.context || response;
  const runRecord = response.questionerRun || {};
  const run = context.run || {};
  const now = new Date().toISOString();
  const requiredCriteria = requiredCoverageEntries(context);
  const outputArtifactRef = runRecord.expectedOutputArtifactRef || input.artifactPath || '';
  return {
    schemaVersion: 'questioner-output.v2',
    id: `q_head_mismatch_${Date.now()}`,
    questionerRunId: run.questionerRunId,
    workflowId: run.workflowId,
    subtaskId: context.subtask?.id,
    intent: run.intent,
    source: 'claude-plugin',
    actor: {
      kind: 'claude-code-questioner',
      invocationId: run.invocationId,
      pluginName: 'agent-loop-claude-review',
      skillName: 'question-tik-agent-loop',
    },
    attestation: {
      headSha: run.headSha,
      contextArtifactRef: runRecord.contextArtifactRef || contextResponseRef(context),
      contextHash: run.contextHash,
      outputArtifactRef,
      outputHash: '',
      generatedAt: now,
    },
    references: {
      contractId: context.contract?.id,
      evaluationRunId: context.evaluation?.id,
      finalEvaluationRunId: context.finalEvaluation?.id,
    },
    verdict: 'questions_blocking',
    coverageMatrix: requiredCriteria.map((criterion) => ({
      criterionId: criterion.id,
      criterionText: criterion.text,
      required: true,
      status: 'missing',
      evidenceRefs: [],
      comment: `HEAD mismatch: Tik expected ${input.expectedHeadSha}, but Claude Code is running at ${input.actualHeadSha}.`,
    })),
    questions: [
      {
        id: 'q-head-mismatch',
        priority: 'blocking',
        category: 'head_mismatch',
        claim: `Claude Code is running at HEAD ${input.actualHeadSha}, but Tik expected ${input.expectedHeadSha}.`,
        evidenceRefs: [],
        requestedFix: 'Restart the Questioner on the expected Tik head before reviewing evidence.',
        status: 'open',
      },
    ],
    risks: [],
    missingTests: [],
    advisoryNotes: [],
  };
}

function normalizeOutput(output, response, artifactPath) {
  const context = response.context || response;
  const runRecord = response.questionerRun || {};
  const run = context.run || {};
  const now = new Date().toISOString();
  return {
    schemaVersion: 'questioner-output.v2',
    id: output.id || `q_${Date.now()}`,
    questionerRunId: output.questionerRunId || run.questionerRunId,
    workflowId: output.workflowId || run.workflowId,
    subtaskId: output.subtaskId ?? context.subtask?.id,
    intent: output.intent || run.intent,
    source: 'claude-plugin',
    actor: {
      kind: 'claude-code-questioner',
      invocationId: output.actor?.invocationId || run.invocationId,
      pluginName: 'agent-loop-claude-review',
      skillName: 'question-tik-agent-loop',
      model: output.actor?.model,
    },
    attestation: {
      headSha: output.attestation?.headSha || run.headSha,
      contextArtifactRef: output.attestation?.contextArtifactRef || runRecord.contextArtifactRef || contextResponseRef(context),
      contextHash: output.attestation?.contextHash || run.contextHash,
      outputArtifactRef: output.attestation?.outputArtifactRef || artifactPath || output.artifactRef || '',
      outputHash: '',
      generatedAt: output.attestation?.generatedAt || now,
    },
    references: {
      contractId: output.references?.contractId || output.contractId || context.contract?.id,
      evaluationRunId: output.references?.evaluationRunId || output.evaluationRunId || context.evaluation?.id,
      finalEvaluationRunId: output.references?.finalEvaluationRunId || output.finalEvaluationRunId || context.finalEvaluation?.id,
    },
    verdict: output.verdict || 'questions_blocking',
    coverageMatrix: output.coverageMatrix || [],
    questions: output.questions || [],
    risks: output.risks || [],
    missingTests: output.missingTests || [],
    advisoryNotes: output.advisoryNotes || [],
  };
}

function validateOutput(output, context) {
  const required = [
    ['questionerRunId', output.questionerRunId],
    ['workflowId', output.workflowId],
    ['intent', output.intent],
    ['actor.invocationId', output.actor?.invocationId],
    ['attestation.contextHash', output.attestation?.contextHash],
    ['attestation.outputArtifactRef', output.attestation?.outputArtifactRef],
  ];
  for (const [field, value] of required) {
    if (!value) throw new Error(`QuestionerOutputV2 missing ${field}`);
  }
  if (output.attestation.contextHash !== context.run?.contextHash) {
    throw new Error('QuestionerOutputV2 contextHash does not match fetched context.');
  }
  if (output.attestation.headSha !== context.run?.headSha) {
    throw new Error('QuestionerOutputV2 headSha does not match fetched context.');
  }
  if (!Array.isArray(output.coverageMatrix) || output.coverageMatrix.length === 0) {
    throw new Error('QuestionerOutputV2 coverageMatrix is required.');
  }
  const uncoveredRequired = output.coverageMatrix
    .filter((entry) => entry.required)
    .filter((entry) => entry.status !== 'covered' && entry.status !== 'not_applicable');
  if (
    uncoveredRequired.length > 0
    && (output.verdict === 'evidence_sufficient' || output.verdict === 'no_blocking_questions')
  ) {
    throw new Error('Sufficient verdict requires every required coverageMatrix entry to be covered.');
  }
}

async function writeArtifactIfNeeded(output, artifactPath) {
  if (!artifactPath) return;
  const resolvedArtifact = resolve(artifactPath);
  await mkdir(dirname(resolvedArtifact), { recursive: true });
  await writeFile(resolvedArtifact, `${JSON.stringify(output, null, 2)}\n`, 'utf-8');
}

function requiredCoverageEntries(context) {
  if (context.contract?.mustCriteria?.length) {
    return context.contract.mustCriteria.map((criterion) => ({
      id: criterion.id,
      text: criterion.statement,
    }));
  }
  if (context.finalEvaluation?.globalCriteriaCoverage?.length) {
    return context.finalEvaluation.globalCriteriaCoverage.map((criterion) => ({
      id: criterion.criterionId,
      text: criterion.evidence || criterion.criterionId,
    }));
  }
  return (context.workflow?.globalAcceptanceCriteria || []).map((criterion, index) => ({
    id: `global-ac-${index + 1}`,
    text: criterion,
  }));
}

function contextResponseRef(context) {
  return context.run?.contextArtifactRef || context.questionerRun?.contextArtifactRef || '';
}

function gitHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function gitStatus() {
  const result = spawnSync('git', ['status', '--porcelain=v1'], { encoding: 'utf-8' });
  return result.status === 0 ? result.stdout : '';
}

async function fetchJson(url, token) {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
  });
  return readJsonResponse(response, 'GET', url);
}

async function postJson(url, token, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return readJsonResponse(response, 'POST', url);
}

async function readJsonResponse(response, method, url) {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${method} ${url} failed (${response.status}): ${payload.error?.message || text}`);
  }
  return payload;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

await main();
