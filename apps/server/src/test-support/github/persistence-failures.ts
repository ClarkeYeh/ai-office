import { TapeLeakError } from './tape-normalization.js';

/** Safe, actionable reasons only: never include raw errors or fixture contents. */
export function refusalReason(error: unknown): string {
  if (error instanceof TapeLeakError) return 'tape leak scan';
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (
    ['EEXIST', 'EACCES', 'EPERM', 'ENOSPC', 'ENOENT', 'EROFS', 'EIO'].includes(
      code ?? '',
    )
  )
    return `filesystem ${code}`;
  if (
    error instanceof Error &&
    error.message === 'Refusing to publish before successful cleanup'
  )
    return 'cleanup incomplete';
  return 'unclassified persistence refusal';
}

/** Report after all cases have had their cleanup opportunity. */
export class PersistenceFailures {
  private readonly cases: { name: string; reason: string }[] = [];
  private readonly withheld: { name: string; count: number }[] = [];
  recordWithheld(name: string, count: number): void {
    if (count > 0) this.withheld.push({ name, count });
  }
  async capture(name: string, persist: () => Promise<void>): Promise<void> {
    try {
      await persist();
    } catch (error) {
      this.cases.push({ name, reason: refusalReason(error) });
    }
  }
  assertSuccess(): void {
    const count = this.withheld.reduce((sum, row) => sum + row.count, 0);
    if (count)
      console.error(
        `WITHHELD ${count} response(s): ${this.withheld.map((row) => `${row.name} (${row.count})`).join(', ')}`,
      );
    if (this.cases.length)
      throw new Error(
        `Tape persistence failed for ${this.cases.length} case(s): ${this.cases.map((row) => `${row.name} [${row.reason}]`).join(', ')}`,
      );
  }
}
