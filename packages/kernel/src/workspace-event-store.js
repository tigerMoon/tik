import * as fs from 'node:fs';
import * as path from 'node:path';
export class WorkspaceEventStore {
    records = [];
    persistPath;
    constructor(options) {
        this.persistPath = options?.persistPath;
        if (this.persistPath) {
            this.loadPersistedRecords();
        }
    }
    record(event) {
        const record = {
            timestamp: new Date().toISOString(),
            ...event,
        };
        this.records.push(record);
        if (this.persistPath) {
            fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
            fs.appendFileSync(this.persistPath, `${JSON.stringify(record)}\n`, 'utf-8');
        }
        return record;
    }
    list(filter) {
        return this.records.filter((record) => {
            if (filter?.phase && record.phase !== filter.phase)
                return false;
            if (filter?.projectName && record.projectName !== filter.projectName)
                return false;
            return true;
        });
    }
    latest() {
        return this.records.at(-1);
    }
    snapshot() {
        return [...this.records];
    }
    count(filter) {
        return this.records.filter((record) => {
            if (filter?.phase && record.phase !== filter.phase)
                return false;
            if (filter?.projectName && record.projectName !== filter.projectName)
                return false;
            if (filter?.kind && record.kind !== filter.kind)
                return false;
            return true;
        }).length;
    }
    loadPersistedRecords() {
        try {
            const content = fs.readFileSync(this.persistPath, 'utf-8');
            for (const line of content.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed)
                    continue;
                this.records.push(JSON.parse(trimmed));
            }
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }
}
//# sourceMappingURL=workspace-event-store.js.map