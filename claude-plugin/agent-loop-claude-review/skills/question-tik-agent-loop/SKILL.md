---
name: question-tik-agent-loop
description: Use when Claude Code is launched by Tik as a read-only Questioner for requirements, contracts, evaluator evidence, or final workflow evidence.
---

# Question Tik Agent Loop

Use this skill only as the Claude Code side of a Tik-owned Questioner invocation. Tik provides the workflow, subtask, intent, contract/evaluation ids, head SHA, and artifact output path. Codex workflow decides how to act on your questions.

## Contract

Do:
- Read the workflow from `GET ${TIK_API_BASE_URL:-http://127.0.0.1:3300/api}/v1/multi-agent/workflows/:workflowId`.
- Inspect only the requirement, TaskGraph, SprintContract, evaluation result, final evidence, and repository context needed for the requested intent.
- Verify the current HEAD matches the head SHA provided by Tik.
- Submit exactly one structured `QuestionerOutput` to `POST /v1/multi-agent/workflows/:workflowId/questioner-outputs`.
- Set `source` to `claude-plugin` and include `actor.invocationId`, `headSha`, `artifactRef`, and the relevant `contractId` or `evaluationRunId`.

Do not:
- Edit files.
- Commit, push, merge, or approve externally.
- Mark subtasks or workflows complete.
- Record `evidence_sufficient` unless all blocking questions for the requested intent are resolved by cited evidence.

## QuestionerOutput JSON

For `question_requirement`, `question_task_graph`, `question_contract`, `question_evaluation`, or `question_final_evidence`, submit JSON matching:

```json
{
  "id": "q_123",
  "subtaskId": "st-api",
  "intent": "question_evaluation",
  "actor": {
    "kind": "claude-code-questioner",
    "invocationId": "claude-questioner-run-123"
  },
  "source": "claude-plugin",
  "headSha": "abc123",
  "evaluationRunId": "eval-123",
  "contractId": "contract-st-api-v1",
  "artifactRef": ".tik/multi-agent/workflows/wf_123/questioner/q_123.json",
  "verdict": "evidence_sufficient",
  "questions": [],
  "risks": [],
  "missingTests": [],
  "suggestedContractChanges": []
}
```

Use `verdict=need_clarification` when any blocking question remains. Use `verdict=risk_found` when evidence is present but material risk remains. Use `verdict=evidence_sufficient` or `no_blocking_questions` only when there are no blocking questions.

## Suggested Commands

```bash
export TIK_API_BASE_URL="${TIK_API_BASE_URL:-http://127.0.0.1:3300/api}"
curl -sS "$TIK_API_BASE_URL/v1/multi-agent/workflows/<workflowId>"
git -C "<effectiveProjectPath>" rev-parse HEAD
curl -sS -X POST "$TIK_API_BASE_URL/v1/multi-agent/workflows/<workflowId>/questioner-outputs" \
  -H 'Content-Type: application/json' \
  --data-binary @questioner-output.json
```

## Output To User

After submitting, report:
- Tik workflow id.
- Intent and subtask id, if any.
- Reviewed head SHA.
- Verdict.
- Number of blocking questions.
