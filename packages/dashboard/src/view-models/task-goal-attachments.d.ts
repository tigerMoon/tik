export interface WorkbenchTaskGoalAttachment {
    id: string;
    kind: 'image' | 'markdown';
    name: string;
    markdown: string;
}
export interface WorkbenchTaskLaunchAttachmentValidation {
    valid: boolean;
    titleError: string | null;
    goalError: string | null;
}
export declare function validateWorkbenchTaskLaunchDraftWithAttachments(input: {
    title: string;
    goal: string;
    attachmentCount?: number;
}): WorkbenchTaskLaunchAttachmentValidation;
export declare function buildWorkbenchTaskGoalImageMarkdown(input: {
    name: string;
    type: string;
    dataUrl: string;
}): string;
export declare function buildWorkbenchTaskGoalMarkdownFileSection(input: {
    name: string;
    text: string;
}): string;
export declare function appendWorkbenchTaskGoalAttachments(goal: string, attachments: WorkbenchTaskGoalAttachment[]): string;
export declare function isSupportedWorkbenchTaskGoalFile(file: Pick<File, 'name' | 'type'>): boolean;
export declare function isWorkbenchTaskGoalImage(file: Pick<File, 'type'>): boolean;
export declare function isWorkbenchTaskGoalMarkdown(file: Pick<File, 'name' | 'type'>): boolean;
//# sourceMappingURL=task-goal-attachments.d.ts.map