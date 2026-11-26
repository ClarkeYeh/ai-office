/**
 * M5-T7 executor of T8's scripted owner policy (M5_PLAN §2.2.4). The table
 * itself (`ownerAction`, `releaseHeldAnswer`) lives in `scenario/`; this
 * module applies it to open gates over an injected port, so CI pins every
 * row without a backend. Anything the table does not cover is handed off
 * through the private status file; the final-PR gate is never decided here.
 * Records hold ids, kinds, counts and booleans only — never bodies.
 */
import {
  ownerAction,
  releaseHeldAnswer,
  reviseEdits,
  splitMatches,
  type OwnerAction,
} from './scenario/index.js';
import type { Json } from '../orca/t17/checks.js';

/** What the executor needs from the backend and the owner's side. */
export interface OwnerPort {
  /** Open gates of this workflow (list view). */
  openGates(): Promise<Json[]>;
  /** `GET /gates/{id}`. */
  gateDetail(gateId: string): Promise<Json>;
  /** `POST /gates/{id}/decision` with `expectedVersion` (and the conclusion hash). */
  decide(gate: Json, body: Json): Promise<{ status: number }>;
  /**
   * The asking item of an escalated question (`GET /questions`): escalation
   * gates carry the question id, not always the item key.
   */
  questionItem?: (questionId: string) => Promise<string | undefined>;
  /** `POST /questions/{id}/answer`. */
  answer(questionId: string, body: string): Promise<{ status: number }>;
  /**
   * The owner's `/approve` comment on the conclusion Issue (marker
   * `aio-test:owner`); undefined when the mode has no real Issue (T11b).
   */
  ownerApproveComment?: () => Promise<boolean>;
  /** Writes the private status file (`can-merge`, `needs-decision`). */
  handOff(status: Json): Promise<void>;
  /**
   * The final-PR gate: production waits for the owner's hand merge (W2);
   * T11 / T11b call the stand-in's explicit merge here.
   */
  finalPr(gate: Json): Promise<void>;
}

export interface OwnerPolicyRecord {
  conclusionApproved: number;
  /** The owner `/approve` comment changed nothing (gate still open, same version). */
  approveCommentNoEffect: boolean | 'n/a';
  splitApproved: number;
  splitRevised: number;
  /** Auto decisions per exception kind. */
  exceptions: Record<string, number>;
  escalation?: {
    gateId: string;
    openedAt: number;
    answeredAt?: number;
    releasedBy?: 'restart' | 'timeout';
  };
  handOffs: { gateId: string; reason: string }[];
  finalGate?: string;
}

export class OwnerPolicyExecutor {
  readonly record: OwnerPolicyRecord = {
    conclusionApproved: 0,
    approveCommentNoEffect: 'n/a',
    splitApproved: 0,
    splitRevised: 0,
    exceptions: {},
    handOffs: [],
  };
  private readonly handled = new Set<string>();
  private readonly commented = new Map<string, number>();
  private restartReadyAt: number | undefined;

  constructor(
    private readonly port: OwnerPort,
    private readonly options: { tag: string; now?: () => number },
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The restart drill's readiness releases a held escalation answer. */
  restartReady(at: number): void {
    this.restartReadyAt ??= at;
  }

  /** One pass over the open gates; returns the actions taken (kinds only). */
  async step(): Promise<OwnerAction['type'][]> {
    const taken: OwnerAction['type'][] = [];
    for (const gate of await this.port.openGates()) {
      if (gate.status !== 'open') continue;
      const key = `${gate.gateId}@${gate.version}`;
      if (this.handled.has(key)) continue;
      const questionId = gate.questionId ?? gate.content?.questionId;
      const itemKey =
        gate.content?.itemKey ??
        (gate.exceptionKind === 'question-escalation' &&
        typeof questionId === 'string'
          ? await this.port.questionItem?.(questionId)
          : undefined);
      const action = ownerAction(
        {
          kind: gate.kind,
          ...(gate.stageKind ? { stageKind: gate.stageKind } : {}),
          ...(gate.exceptionKind ? { exceptionKind: gate.exceptionKind } : {}),
          ...(itemKey ? { itemKey } : {}),
        },
        {
          seen:
            gate.exceptionKind === 'question-escalation'
              ? // Only the first escalation is held; any other one is handed off.
                this.record.escalation &&
                this.record.escalation.gateId !== gate.gateId
                ? 1
                : 0
              : (this.record.exceptions[gate.exceptionKind] ?? 0),
          ...(gate.stageKind === 'planning'
            ? {
                splitMatches: splitMatches(
                  (await this.port.gateDetail(gate.gateId)).workItems,
                  this.options.tag,
                ),
              }
            : {}),
        },
      );
      if (await this.apply(gate, action)) {
        this.handled.add(key);
        taken.push(action.type);
      }
    }
    return taken;
  }

  /** True when the gate needs no further attention at this version. */
  private async apply(gate: Json, action: OwnerAction): Promise<boolean> {
    switch (action.type) {
      case 'approve-conclusion': {
        if (this.port.ownerApproveComment) {
          // First pass: the owner comments `/approve`; the next pass checks
          // that nothing moved (§24 safety: comments never decide gates).
          const version = this.commented.get(gate.gateId);
          if (version === undefined) {
            // No conclusion Issue found: no comment, so nothing to judge.
            if (!(await this.port.ownerApproveComment())) {
              this.commented.set(gate.gateId, -1);
            } else {
              this.commented.set(gate.gateId, gate.version);
              return false;
            }
          } else
            this.record.approveCommentNoEffect =
              this.record.approveCommentNoEffect !== false &&
              version === gate.version;
        }
        if (await this.must(gate, { decision: 'approve' }))
          this.record.conclusionApproved++;
        return true;
      }
      case 'approve-split':
        if (await this.must(gate, { decision: 'approve' }))
          this.record.splitApproved++;
        return true;
      case 'revise-split':
        if (
          await this.must(gate, {
            decision: 'revise',
            edits: reviseEdits(this.options.tag),
          })
        )
          this.record.splitRevised++;
        return true;
      case 'await-owner-merge':
        if (this.record.finalGate === gate.gateId) return true;
        this.record.finalGate = gate.gateId;
        await this.port.finalPr(gate);
        return true;
      case 'hold-answer': {
        const now = this.now();
        const held = (this.record.escalation ??= {
          gateId: gate.gateId,
          openedAt: now,
        });
        const release = releaseHeldAnswer({
          gateOpenedAt: held.openedAt,
          now,
          ...(this.restartReadyAt === undefined
            ? {}
            : { restartReadyAt: this.restartReadyAt }),
        });
        if (!release) return false;
        const questionId = gate.questionId ?? gate.content?.questionId;
        if (typeof questionId !== 'string')
          return this.handOff(gate, 'escalation without questionId');
        const answered = await this.port.answer(questionId, action.answer);
        if (answered.status >= 300 && answered.status !== 409)
          throw new Error(`escalation answer ${answered.status}`);
        held.answeredAt = now;
        held.releasedBy =
          this.restartReadyAt !== undefined && this.restartReadyAt <= now
            ? 'restart'
            : 'timeout';
        this.record.exceptions['question-escalation'] = 1;
        return true;
      }
      case 'option': {
        if (
          await this.must(gate, {
            decision: 'option',
            optionId: action.optionId,
          })
        )
          this.record.exceptions[gate.exceptionKind] =
            (this.record.exceptions[gate.exceptionKind] ?? 0) + 1;
        return true;
      }
      case 'hand-off':
        return this.handOff(gate, action.reason);
    }
  }

  private async handOff(gate: Json, reason: string): Promise<boolean> {
    this.record.handOffs.push({ gateId: gate.gateId, reason });
    await this.port.handOff({
      phase: 'needs-decision',
      for: `${gate.gateId}@${gate.version}`,
      kind: gate.kind,
      ...(gate.stageKind ? { stageKind: gate.stageKind } : {}),
      ...(gate.exceptionKind ? { exceptionKind: gate.exceptionKind } : {}),
      reason,
    });
    return true;
  }

  /** True when applied; false on 409 (stale version: decided again next pass). */
  private async must(gate: Json, body: Json): Promise<boolean> {
    const { status } = await this.port.decide(gate, body);
    if (status === 409) return false;
    if (status >= 300) throw new Error(`gate decision ${status}`);
    return true;
  }
}
