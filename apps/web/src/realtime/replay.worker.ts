import { attachReplayEngine, type WorkerScope } from './replay-engine.js';

// Dedicated module worker: `new Worker(new URL('./replay.worker.ts', import.meta.url))`.
attachReplayEngine(self as unknown as WorkerScope);
