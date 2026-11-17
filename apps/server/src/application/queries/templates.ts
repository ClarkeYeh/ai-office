import type { TemplateRepository } from '../../ports/template.js';

/** Read afresh on each request so edited and invalid templates stay visible. */
export class TemplateQueries {
  constructor(private readonly templates: TemplateRepository) {}
  listTemplates() {
    return this.templates.list();
  }
  async getTemplate(id: string) {
    const template = await this.templates.get(id);
    if (template === null) return null;
    return 'issues' in template
      ? { valid: [], invalid: [template] }
      : { valid: [template], invalid: [] };
  }
}
