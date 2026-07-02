const DEFAULT_ENDPOINT = 'https://api.linear.app/graphql';
const ISSUE_FIELDS = `
  nodes {
    id
    identifier
    title
    description
    priority
    url
    createdAt
    updatedAt
    state { name type }
    labels { nodes { name } }
    relations {
      nodes {
        type
        relatedIssue {
          id
          identifier
          state { name type }
        }
      }
    }
  }
`;
export class LinearTaskImporter {
    options;
    activeStates;
    terminalStates;
    endpoint;
    fetchJson;
    constructor(options) {
        this.options = options;
        this.activeStates = options.activeStates || ['Todo', 'In Progress'];
        this.terminalStates = options.terminalStates || ['Done', 'Closed', 'Canceled', 'Cancelled'];
        this.endpoint = options.endpoint || DEFAULT_ENDPOINT;
        this.fetchJson = options.fetchJson || defaultFetchJson;
    }
    async listCandidateTasks() {
        return this.fetchTasksByStates(this.activeStates);
    }
    async fetchTasksByStates(stateNames) {
        const data = await this.request(`
      query TikIssuesByState($stateNames: [String!]${this.options.projectSlug ? ', $projectSlug: String!' : ''}) {
        issues(filter: ${this.issueStateFilter()}) {
          ${ISSUE_FIELDS}
        }
      }
    `, this.withProjectSlug({ stateNames }));
        return normalizeTaskNodes(data?.data?.issues?.nodes || [], this.terminalStates);
    }
    async fetchTaskStatesByIds(taskIds) {
        if (taskIds.length === 0)
            return [];
        const data = await this.request(`
      query TikIssuesById($issueIds: [ID!]) {
        issues(filter: { id: { in: $issueIds } }) {
          ${ISSUE_FIELDS}
        }
      }
    `, { issueIds: taskIds });
        return normalizeTaskNodes(data?.data?.issues?.nodes || [], this.terminalStates);
    }
    request(query, variables) {
        return this.fetchJson({
            endpoint: this.endpoint,
            headers: {
                Authorization: this.options.apiKey,
                'Content-Type': 'application/json',
            },
            body: { query, variables },
        });
    }
    issueStateFilter() {
        if (!this.options.projectSlug)
            return '{ state: { name: { in: $stateNames } } }';
        return '{ state: { name: { in: $stateNames } }, project: { slugId: { eq: $projectSlug } } }';
    }
    withProjectSlug(variables) {
        if (!this.options.projectSlug)
            return variables;
        return { ...variables, projectSlug: this.options.projectSlug };
    }
}
async function defaultFetchJson(input) {
    const response = await fetch(input.endpoint, {
        method: 'POST',
        headers: input.headers,
        body: JSON.stringify(input.body),
    });
    if (!response.ok) {
        throw new Error(`Linear request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
}
function normalizeTaskNodes(nodes, terminalStates) {
    return nodes.map((node) => {
        const stateName = node.state?.name || 'Unknown';
        return {
            id: node.id,
            shortIdentifier: node.identifier,
            title: node.title,
            description: node.description ?? null,
            priority: node.priority ?? null,
            state: stateName,
            stateKind: inferStateKind(node.state?.type, stateName, terminalStates),
            sourceUrl: node.url ?? null,
            labels: (node.labels?.nodes || []).map((label) => label.name.toLowerCase()),
            blockedBy: normalizeBlockers(node.relations?.nodes || []),
            createdAt: node.createdAt ?? null,
            updatedAt: node.updatedAt ?? null,
        };
    });
}
function normalizeBlockers(relations) {
    return relations
        .filter((relation) => relation.type === 'blocked_by' && relation.relatedIssue)
        .map((relation) => ({
        id: relation.relatedIssue.id ?? null,
        shortIdentifier: relation.relatedIssue.identifier ?? null,
        state: relation.relatedIssue.state?.name ?? null,
    }));
}
function inferStateKind(type, stateName, terminalStates) {
    if (type === 'completed' || type === 'canceled')
        return 'terminal';
    if (terminalStates.includes(stateName))
        return 'terminal';
    if (type === 'blocked')
        return 'blocked';
    return 'active';
}
//# sourceMappingURL=linear-tracker-client.js.map