---
name: question-tik-agent-loop
description: Use when Claude Code is launched by Tik as a read-only Questioner for requirements, contracts, evaluator evidence, or final workflow evidence.
---

# Question Tik Agent Loop

Use this skill only as the Claude Code side of a Tik-owned Questioner invocation. Tik provides a token-scoped QuestionerRun context, expected head SHA, and submit URL. Codex workflow decides how to act on your questions.

## Contract

Do:
- Read the scoped context from `TIK_QUESTIONER_CONTEXT_URL` with `Authorization: Bearer $TIK_QUESTIONER_TOKEN`.
- Inspect only the requirement, TaskGraph, SprintContract, evaluation result, final evidence, and repository context needed for the requested intent.
- Verify the current HEAD matches the head SHA provided by Tik.
- Submit exactly one structured `QuestionerOutputV2` to `TIK_QUESTIONER_SUBMIT_URL`.
- Set `source=claude-plugin`, `actor.pluginName=agent-loop-claude-review`, `actor.skillName=question-tik-agent-loop`, and include run/context/output attestation.
- Use `node scripts/post-questioner-output.mjs ./questioner-output.json` to validate, hash, write the output artifact, and submit.
- Treat Tik server validation as authoritative: direct POSTs are rejected unless `attestation.outputHash`, `attestation.contextHash`, head SHA, referenced contract/evaluation ids, and `coverageMatrix` match the token-scoped QuestionerRun context.
- Do not include a top-level `createdAt` field in QuestionerOutputV2. The Tik server strips it before hashing; hand-computing `outputHash` with that field included will mismatch.
- If HEAD does not match the head SHA provided by Tik, submit a V2 output with `verdict=questions_blocking`, a blocking `head_mismatch` question, and no `evidence_sufficient` claim.

Do not:
- Edit files.
- Commit, push, merge, or approve externally.
- Mark subtasks or workflows complete.
- Record `evidence_sufficient` unless all required criteria are covered by cited evidence and no blocking/evidence_needed questions remain.

## Evidence Challenge Rubric

For each must criterion:
1. Identify the evaluator evidence that proves it.
2. If no evidence exists, create a blocking or evidence_needed question.
3. If evidence exists but is stale/head-mismatched, create a blocking question.
4. If a test only covers the happy path and the criterion requires an edge case, add `missingTests`.
5. If an artifact cannot be reproduced, create an `artifact_gap` question.

Do not mark `evidence_sufficient` unless:
- all must criteria are present in `coverageMatrix`;
- each required criterion is `covered` with concrete `evidenceRefs`;
- head SHA and evaluation/final evaluation ids match the context;
- no blocking or evidence_needed questions remain;
- attestation references the context hash and output artifact.

## QuestionerOutputV2 JSON

Submit JSON matching:

```json
{
  "schemaVersion": "questioner-output.v2",
  "id": "q_123",
  "questionerRunId": "qr_123",
  "workflowId": "wf_123",
  "subtaskId": "st-api",
  "intent": "question_evaluation",
  "source": "claude-plugin",
  "actor": {
    "kind": "claude-code-questioner",
    "invocationId": "inv_123",
    "pluginName": "agent-loop-claude-review",
    "skillName": "question-tik-agent-loop"
  },
  "attestation": {
    "headSha": "abc123",
    "contextArtifactRef": ".tik/multi-agent/workflows/wf_123/questioner-runs/qr_123/context.json",
    "contextHash": "sha256:...",
    "outputArtifactRef": ".tik/multi-agent/workflows/wf_123/questioner-runs/qr_123/output.json",
    "outputHash": "",
    "generatedAt": "2026-07-03T12:00:00.000Z"
  },
  "references": {
    "evaluationRunId": "eval-123",
    "contractId": "contract-st-api-v1"
  },
  "verdict": "evidence_sufficient",
  "coverageMatrix": [
    {
      "criterionId": "ac-1",
      "criterionText": "API returns the expected response.",
      "required": true,
      "status": "covered",
      "evidenceRefs": ["eval-123:criteria:ac-1", "cmd-test"],
      "comment": "Evaluator passed the criterion and cited the targeted command."
    }
  ],
  "questions": [],
  "risks": [],
  "missingTests": [],
  "advisoryNotes": []
}
```

The helper fills `attestation.outputHash` after canonical hashing. Keep it empty in your draft file unless you have computed the canonical hash exactly.

Use `verdict=questions_blocking` when any blocking question remains. Use `verdict=evidence_needed` when code may be fine but proof is missing. Use `verdict=risk_found` when evidence is present but material risk remains. Use `verdict=evidence_sufficient` or `no_blocking_questions` only when there are no blocking or evidence_needed questions.

Tik v1 loop gates actively consume `question_contract`, `question_evaluation`,
and `question_final_evidence`. `question_requirement` and
`question_task_graph` are informational hookpoints unless the Codex workflow
driver explicitly asks for them.

## Suggested Commands

```bash
export TIK_API_BASE_URL="${TIK_API_BASE_URL:-http://127.0.0.1:3300/api}"
curl -sS "$TIK_QUESTIONER_CONTEXT_URL" \
  -H "Authorization: Bearer $TIK_QUESTIONER_TOKEN"
git -C "<effectiveProjectPath>" rev-parse HEAD
node scripts/post-questioner-output.mjs ./questioner-output.json
```

## Output To User

After submitting, report:
- Tik workflow id.
- Intent and subtask id, if any.
- Reviewed head SHA.
- Verdict.
- Number of blocking questions.
