import type { WorkflowTemplate } from '@ai-office/contracts/template';
export type TemplateInvalid = {
  file: string;
  issues: { path: string; message: string }[];
};
export interface TemplateRepository {
  list(): Promise<{
    valid: WorkflowTemplate[];
    invalid: { file: string; issues: { path: string; message: string }[] }[];
  }>;
  get(id: string): Promise<WorkflowTemplate | TemplateInvalid | null>;
}
