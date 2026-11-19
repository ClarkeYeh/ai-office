/** Persistence failures are reported after all cases have had their cleanup opportunity. */
export class PersistenceFailures {
  private readonly cases: string[] = [];
  async capture(name: string, persist: () => Promise<void>): Promise<void> {
    try {
      await persist();
    } catch {
      // Never include thrown filesystem errors or raw fixture data in diagnostics.
      this.cases.push(name);
    }
  }
  assertSuccess(): void {
    if (this.cases.length)
      throw new Error(
        `Tape persistence failed for ${this.cases.length} case(s): ${this.cases.join(', ')}`,
      );
  }
}
