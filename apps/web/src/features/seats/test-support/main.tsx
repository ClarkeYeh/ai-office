/** Manual harness: /src/features/seats/test-support/index.html?state=review
 * For a real fake backend: ?workflow=<id>&seat=<id> (through dev:office's proxy).
 */
import { createRoot } from 'react-dom/client';
import { createApiClient } from '../../../api/index.js';
import {
  createBrowserRealtime,
  RealtimeProvider,
} from '../../../realtime/index.js';
import { mainline } from '../../../test-support/office/mainline.js';
import { seatId } from '../../../test-support/office/log.js';
import { seatsT } from '../../../shared/lib/i18n/seats.js';
import '../../../shared/ui/tokens.css';
import { SeatInspector } from '../index.js';

const params = new URLSearchParams(location.search);
const log = mainline();
const workflow = params.get('workflow');
const mark = params.get('state') ?? 'review';
const model = log.at(mark);
const selected =
  params.get('seat') ?? seatId(mark === 'meeting' ? 'pm' : 'integrator');
// Fixture mode has no side effects; real mode goes through the actual HTTP/SSE stack.
if (!workflow) {
  globalThis.fetch = async (_input, init) =>
    Response.json(
      init?.method === 'POST' ? { accepted: true } : { events: log.events },
    );
}
const realtime = createBrowserRealtime(createApiClient());
if (workflow) {
  await realtime.setActiveWorkflow(workflow);
  await realtime.start();
} else {
  realtime.store.setState({
    auth: 'ok',
    active: { workflowId: model.workflowId, live: model, status: 'ready' },
  });
}
document.title = seatsT('seats.title');
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <main style={{ width: 320, margin: 24 }}>
      <RealtimeProvider realtime={realtime}>
        <SeatInspector seatId={selected} />
      </RealtimeProvider>
    </main>,
  );
