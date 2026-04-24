/**
 * Tool Result Store (Phase 2.8)
 *
 * Prevents large tool outputs from polluting session messages and prompt.
 * When output exceeds threshold:
 * - Full result saved to .tik/tool-results/<taskId>/<toolCallId>.txt
 * - Session message replaced with preview + artifact reference
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolResultRef } from '@tik/shared';

const STORE_THRESHOLD = 2048; // 2KB
const PREVIEW_SIZE = 2048;    // 2KB preview

export class ToolResultStore {
  private baseDir: string;

  constructor(projectPath: string) {
    this.baseDir = path.join(projectPath, '.tik', 'tool-results');
  }

  /** Check if a tool result should be stored externally */
  shouldStore(output: string): boolean {
    return output.length > STORE_THRESHOLD;
  }

  /** Store large tool result and return a preview reference */
  async store(
    taskId: string,
    toolCallId: string,
    toolName: string,
    output: string,
    isError = false,
  ): Promise<ToolResultRef> {
    const dir = path.join(this.baseDir, taskId);
    await fs.mkdir(dir, { recursive: true });

    const filePath = path.join(dir, `${toolCallId}.txt`);
    await fs.writeFile(filePath, output, 'utf-8');

    const preview = output.slice(0, PREVIEW_SIZE);
    const truncated = output.length > PREVIEW_SIZE;

    return {
      toolCallId,
      toolName,
      preview,
      byteSize: Buffer.byteLength(output, 'utf-8'),
      truncated,
      isError,
    };
  }

  /** Retrieve full tool result from store */
  async retrieve(taskId: string, toolCallId: string): Promise<string | null> {
    try {
      const filePath = path.join(this.baseDir, taskId, `${toolCallId}.txt`);
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  /** Format a ToolResultRef as a message for session history */
  static formatPreview(ref: ToolResultRef): string {
    const header = ref.isError
      ? `[Tool Error: ${ref.toolName}]`
      : `[Tool Result: ${ref.toolName} — ${ref.byteSize} bytes${ref.truncated ? ', truncated' : ''}]`;
    return `${header}\n${ref.preview}`;
  }
}
