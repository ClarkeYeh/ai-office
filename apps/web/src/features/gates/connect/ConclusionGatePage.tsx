import { useEffect, useMemo, useState } from 'react';
import { conclusionViewModel, type GateView } from '../model/index.js';
import { ConclusionGate } from '../ui/index.js';
import type { GateBodyProps } from './gateBodies.js';
import { sha256Hex } from './hash.js';
import { useGateDecision } from './useGateDecision.js';

/**
 * `githubBodyHash` for approve/revise (§8.2 step 3): the digest of the GitHub body
 * the owner is looking at. Without a body (SCM down) fall back to the last hash the
 * read model knows; the server answers 409 if GitHub has moved since.
 */
function useGithubBodyHash(gate: GateView): string | null {
  const body = gate.conclusion?.githubBody;
  const fallback =
    gate.conclusion?.githubBodyHash ?? gate.conclusion?.renderedHash ?? null;
  const [computed, setComputed] = useState<{
    body: string;
    hash: string;
  } | null>(null);
  useEffect(() => {
    if (body === undefined) return;
    let live = true;
    void sha256Hex(body).then((hash) => {
      if (live) setComputed({ body, hash });
    });
    return () => {
      live = false;
    };
  }, [body]);
  if (body === undefined) return fallback;
  return computed?.body === body ? computed.hash : null;
}

export function ConclusionGatePage({
  gate,
  model,
  api,
  refetch,
  layout,
}: GateBodyProps) {
  const vm = useMemo(() => conclusionViewModel(gate, model), [gate, model]);
  const githubBodyHash = useGithubBodyHash(gate);
  const { pending, notice, conflicts, decide } = useGateDecision(
    gate,
    api,
    refetch,
  );
  const githubUpdatedAt = gate.conclusion?.githubUpdatedAt;
  const hashed = {
    ...(githubBodyHash === null ? {} : { githubBodyHash }),
    ...(githubUpdatedAt === undefined ? {} : { githubUpdatedAt }),
  };
  return (
    <ConclusionGate
      layout={layout}
      vm={vm}
      version={gate.version}
      pending={pending || githubBodyHash === null}
      notice={notice}
      conflicts={conflicts}
      onApprove={() =>
        decide({ decision: 'approve', ...hashed }, 'gates.decided.approve')
      }
      onRevise={(conclusion) =>
        decide(
          {
            decision: 'revise',
            edits: { type: 'conclusion', conclusion },
            ...hashed,
          },
          'gates.decided.revise',
        )
      }
      onReject={(comment) =>
        decide({ decision: 'reject', comment }, 'gates.decided.reject')
      }
    />
  );
}
