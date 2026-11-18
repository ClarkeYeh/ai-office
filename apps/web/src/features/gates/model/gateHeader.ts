import type { ReadModel } from '@ai-office/projection';
import type { Translator } from '../../../shared/lib/i18n/index.js';

/** The gate's workflow read model, re-exported so connect needs no projection import. */
export type WorkflowModel = ReadModel;
export type GateView = ReadModel['gates'][number];
export type GateStatus = GateView['status'];

/** Attempt states that cannot be running anymore (§8.1: exited or released). */
const GONE = new Set(['exited', 'lost']);

export interface GateFact {
  id: 'waited' | 'version' | 'reruns' | 'after';
  label: string;
  value: string;
}
export interface GateQuiet {
  /** Stage gates only: every attempt of the workflow has exited or been released. */
  clear: boolean;
  text: string;
}
export interface GateHeaderViewModel {
  gateId: string;
  workflowId: string;
  title: string;
  heading: string;
  open: boolean;
  status: GateStatus;
  statusLabel: string;
  facts: GateFact[];
  quiet: GateQuiet | null;
  /** "n 個階段關卡的第 i 個", stage gates only. */
  stageOrdinal: string | null;
  /** Remaining reruns, or null when the gate kind has none (exception gates). */
  rerunsLeft: number | null;
  decidedNote: string | null;
}
export interface GateHeaderArgs {
  now: number;
  t: Translator;
}

/** Whole elapsed time between two instants, seconds kept below ten minutes (G7). */
export function formatWaited(t: Translator, ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return t('office.elapsed.hours', { h, m });
  if (m === 0) return t('office.elapsed.seconds', { s });
  if (m < 10) return t('office.elapsed.minutesSeconds', { m, s });
  return t('office.elapsed.minutes', { m });
}

const stageName = (t: Translator, kind: string) =>
  t(`stage.${kind}` as Parameters<Translator>[0]);

/**
 * Reruns left for a stage gate: meeting/planning count `rerun` runs against
 * `defaults.maxReruns`; final PR counts `revision` runs against `maxRevisions`.
 */
export function rerunsLeft(
  gate: GateView,
  model: ReadModel | null,
): number | null {
  if (gate.kind !== 'stage' || !model) return null;
  const stage = model.stages.find((s) => s.stageId === gate.stageId);
  if (!stage) return null;
  if (gate.stageKind === 'final-pr') {
    const config = model.template.stages.find((s) => s.id === gate.stageId);
    if (config?.kind !== 'final-pr') return null;
    const used = stage.runs.filter((r) => r.mode === 'revision').length;
    return Math.max(0, config.maxRevisions - used);
  }
  const used = stage.runs.filter((r) => r.mode === 'rerun').length;
  return Math.max(0, model.template.defaults.maxReruns - used);
}

/** §8.1 / S12: derived from seats, not from a server field (G5 is not in the contract). */
export function quietState(
  gate: GateView,
  model: ReadModel | null,
  t: Translator,
): GateQuiet | null {
  if (gate.kind !== 'stage' || gate.status !== 'open' || !model) return null;
  const attempts = model.seats.flatMap((seat) => seat.attempts);
  const alive = attempts.filter((a) => !GONE.has(a.state) && !a.released);
  if (alive.length > 0)
    return {
      clear: false,
      text: t('gates.quiet.alive', {
        count: alive.length,
        who: [...new Set(alive.map((a) => a.role))].join('、'),
      }),
    };
  const stage = model.stages.find((s) => s.stageId === gate.stageId);
  const roles = new Set(
    attempts.filter((a) => a.stageId === gate.stageId).map((a) => a.role),
  );
  return {
    clear: true,
    text:
      stage && roles.size > 0
        ? t('gates.quiet.clear', {
            stage: stageName(t, stage.kind),
            count: roles.size,
          })
        : t('gates.quiet.clearNobody'),
  };
}

function stageOrdinal(
  gate: GateView,
  model: ReadModel | null,
  t: Translator,
): string | null {
  if (gate.kind !== 'stage' || !model) return null;
  const gated = model.template.stages.filter((s) => 'gate' in s);
  const index = gated.findIndex((s) => s.id === gate.stageId);
  return index < 0
    ? null
    : t('gates.needsStage', { total: gated.length, index: index + 1 });
}

function afterDecision(gate: GateView, t: Translator): string {
  if (gate.kind === 'exception' || !gate.stageKind)
    return t('gates.after.exception');
  return t(`gates.after.${gate.stageKind}`);
}

/** Header and facts every gate page shows (M4_DESIGN §4.3, I-12). */
export function gateHeaderViewModel(
  gate: GateView,
  model: ReadModel | null,
  { now, t }: GateHeaderArgs,
): GateHeaderViewModel {
  const open = gate.status === 'open';
  const statusLabel = t(`gates.status.${gate.status}`);
  const end = gate.decision
    ? Date.parse(gate.decision.at)
    : gate.closedAt
      ? Date.parse(gate.closedAt)
      : now;
  const waited = formatWaited(t, end - Date.parse(gate.openedAt));
  const reruns = rerunsLeft(gate, model);
  const facts: GateFact[] = [
    {
      id: 'waited',
      label: open ? t('gates.waited') : t('gates.waitedDecided'),
      value: waited,
    },
    {
      id: 'version',
      label: t('gates.version'),
      value: gate.conclusion?.changedOnGithub
        ? t('gates.versionGithub', { version: gate.version })
        : t('gates.versionValue', { version: gate.version }),
    },
  ];
  if (reruns !== null)
    facts.push({
      id: 'reruns',
      label: t('gates.rerunsLeft'),
      value:
        reruns > 0
          ? t('gates.rerunsLeftValue', { count: reruns })
          : t('gates.rerunsNone'),
    });
  facts.push({
    id: 'after',
    label: t('gates.after'),
    value: afterDecision(gate, t),
  });
  return {
    gateId: gate.gateId,
    workflowId: gate.workflowId,
    title: gate.title,
    heading: open
      ? t('gates.heading.open', { title: gate.title })
      : t('gates.heading.decided', { title: gate.title, status: statusLabel }),
    open,
    status: gate.status,
    statusLabel,
    facts,
    quiet: quietState(gate, model, t),
    stageOrdinal: stageOrdinal(gate, model, t),
    rerunsLeft: reruns,
    decidedNote: gate.decision
      ? t('gates.decidedNote', {
          status: statusLabel,
          by: t(`gates.decidedBy.${gate.decision.by}`),
        })
      : null,
  };
}
