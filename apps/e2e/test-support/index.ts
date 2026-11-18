import { expect, test } from '@playwright/test';
import { Office, type OfficeOptions } from './office.js';

export { Office, ROOT, type Scenario, type StopResult } from './office.js';
export * from './workflow.js';

/**
 * One office process per spec file: started in beforeAll, stopped in
 * afterAll, which also fails the file if the process group survived or the
 * backend skipped its graceful shutdown. Call at the top of a spec file.
 */
export function useOffice(options: OfficeOptions): () => Office {
  let office: Office | undefined;
  test.beforeAll(async () => {
    office = await Office.start(options);
  });
  test.afterAll(async () => {
    const running = office;
    office = undefined;
    if (!running) return;
    const result = await running.stop();
    expect(result.runtimeRemoved, running.log).toBe(true);
  });
  return () => {
    if (!office) throw new Error('useOffice: the office is not running');
    return office;
  };
}
