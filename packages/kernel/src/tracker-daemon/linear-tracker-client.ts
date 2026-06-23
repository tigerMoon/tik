import type {
  TrackedTask,
  TrackedTaskBlocker,
  TrackedTaskImporter,
  TrackedTaskStateKind,
} from './types.js';

export interface LinearTaskImporterOptions {
  apiKey: string;
  activeStates?: string[];
  terminalStates?: string[];
  endpoint?: string;
  projectSlug?: string;
  fetchJson?: (input: {
    endpoint: string;
    headers: Record<string, string>;
    body: { query: string; variables: Record<string, unknown> };
  }) => Promise<any>;
}

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

export class LinearTaskImporter implements TrackedTaskImporter {
  private readonly activeStates: string[];
  private readonly terminalStates: string[];
  private readonly endpoint: string;
  private readonly fetchJson: NonNullable<LinearTaskImporterOptions['fetchJson']>;

  constructor(private readonly options: LinearTaskImporterOptions) {
    this.activeStates = options.activeStates || ['Todo', 'In Progress'];
    this.terminalStates = options.terminalStates || ['Done', 'Closed', 'Canceled', 'Cancelled'];
    this.endpoint = options.endpoint || DEFAULT_ENDPOINT;
    this.fetchJson = options.fetchJson || defaultFetchJson;
  }

  async listCandidateTasks(): Promise<TrackedTask[]> {
    return this.fetchTasksByStates(this.activeStates);
  }

  async fetchTasksByStates(stateNames: string[]): Promise<TrackedTask[]> {
    const data = await this.request(`
      query TikIssuesByState($stateNames: [String!]${this.options.projectSlug ? ', $projectSlug: String!' : ''}) {
        issues(filter: ${this.issueStateFilter()}) {
          ${ISSUE_FIELDS}
        }
      }
    `, this.withProjectSlug({ stateNames }));
    return normalizeTaskNodes(data?.data?.issues?.nodes || [], this.terminalStates);
  }

  async fetchTaskStatesByIds(taskIds: string[]): Promise<TrackedTask[]> {
    if (taskIds.length === 0) return [];
    const data = await this.request(`
      query TikIssuesById($issueIds: [ID!]) {
        issues(filter: { id: { in: $issueIds } }) {
          ${ISSUE_FIELDS}
        }
      }
    `, { issueIds: taskIds });
    return normalizeTaskNodes(data?.data?.issues?.nodes || [], this.terminalStates);
  }

  private request(query: string, variables: Record<string, unknown>): Promise<any> {
    return this.fetchJson({
      endpoint: this.endpoint,
      headers: {
        Authorization: this.options.apiKey,
        'Content-Type': 'application/json',
      },
      body: { query, variables },
    });
  }

  private issueStateFilter(): string {
    if (!this.options.projectSlug) return '{ state: { name: { in: $stateNames } } }';
    return '{ state: { name: { in: $stateNames } }, project: { slugId: { eq: $projectSlug } } }';
  }

  private withProjectSlug(variables: Record<string, unknown>): Record<string, unknown> {
    if (!this.options.projectSlug) return variables;
    return { ...variables, projectSlug: this.options.projectSlug };
  }
}

async function defaultFetchJson(input: {
  endpoint: string;
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, unknown> };
}): Promise<any> {
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

function normalizeTaskNodes(nodes: any[], terminalStates: string[]): TrackedTask[] {
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
      labels: (node.labels?.nodes || []).map((label: { name: string }) => label.name.toLowerCase()),
      blockedBy: normalizeBlockers(node.relations?.nodes || []),
      createdAt: node.createdAt ?? null,
      updatedAt: node.updatedAt ?? null,
    };
  });
}

function normalizeBlockers(relations: any[]): TrackedTaskBlocker[] {
  return relations
    .filter((relation) => relation.type === 'blocked_by' && relation.relatedIssue)
    .map((relation) => ({
      id: relation.relatedIssue.id ?? null,
      shortIdentifier: relation.relatedIssue.identifier ?? null,
      state: relation.relatedIssue.state?.name ?? null,
    }));
}

function inferStateKind(type: string | undefined, stateName: string, terminalStates: string[]): TrackedTaskStateKind {
  if (type === 'completed' || type === 'canceled') return 'terminal';
  if (terminalStates.includes(stateName)) return 'terminal';
  if (type === 'blocked') return 'blocked';
  return 'active';
}
