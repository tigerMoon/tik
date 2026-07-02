import type { ArtifactKind, WorkbenchArtifactRecord, WorkbenchTaskRecord, WorkbenchTimelineItem } from '@tik/shared';
export type ArtifactTemplateName = 'task-review' | 'pr-walkthrough' | 'investigation-timeline' | 'option-comparison' | 'release-checklist' | 'tracker-attempt-report';
export interface RenderArtifactTemplateInput {
    template: ArtifactTemplateName;
    task: WorkbenchTaskRecord;
    timeline?: WorkbenchTimelineItem[];
    artifacts?: WorkbenchArtifactRecord[];
}
export interface RenderedArtifactTemplate {
    title: string;
    kind: ArtifactKind;
    contentType: string;
    extension: 'md';
    content: string;
    summary: string;
    tags: string[];
}
export declare const ARTIFACT_TEMPLATE_NAMES: ArtifactTemplateName[];
export declare function renderArtifactTemplate(input: RenderArtifactTemplateInput): RenderedArtifactTemplate;
//# sourceMappingURL=artifact-templates.d.ts.map