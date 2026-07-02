/**
 * Session Types
 *
 * Session is the internal runtime container for AgentLoop.
 * It provides multi-turn continuity and multi-agent collaboration
 * without replacing the external Task/Event contract.
 *
 * Key constraints:
 * - Task.status is the external lifecycle (visible to CLI/API/Dashboard)
 * - Session.loopState is internal control only
 * - EventBus remains SSOT; Session is working memory
 * - Multi-agent roles share one taskId, one sessionId, one event stream
 */
export {};
//# sourceMappingURL=session.js.map