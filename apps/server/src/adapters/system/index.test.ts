import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FsSpecStore,
  SystemClock,
  SystemIdGen,
  TimerScheduler,
} from './index.js';

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const temporary = () => {
  const path = mkdtempSync(join(tmpdir(), 'aio-system-'));
  directories.push(path);
  return path;
};

describe('system identity', () => {
  it('uses wall clock and produces monotonic ULIDs within a millisecond and on rollback', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const clock = new SystemClock();
    expect(clock.now().getTime()).toBe(1000);
    const ids = new SystemIdGen(clock);
    const values = Array.from({ length: 1000 }, () => ids.ulid());
    vi.setSystemTime(999);
    values.push(ids.ulid());
    vi.setSystemTime(1001);
    values.push(ids.ulid());
    expect(values).toEqual([...values].sort());
    expect(new Set(values).size).toBe(values.length);
    for (const value of values)
      expect(value).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(new Set(Array.from({ length: 100 }, () => ids.shortId())).size).toBe(
      100,
    );
    expect(ids.shortId()).toMatch(/^[a-f0-9]{12}$/);
  });
  it('matches the fixed namespace UUIDv5 vector across instances', () => {
    expect(new SystemIdGen().orcaRequestId('command-123')).toBe(
      'b46073d2-ec07-50ac-a0b1-08c6ebef35fe',
    );
    expect(new SystemIdGen().orcaRequestId('command-123')).toBe(
      new SystemIdGen().orcaRequestId('command-123'),
    );
    expect(new SystemIdGen().orcaRequestId('command-124')).not.toBe(
      new SystemIdGen().orcaRequestId('command-123'),
    );
  });
});

describe('TimerScheduler', () => {
  it('delivers once, replaces, cancels, restores overdue timers, and snapshots input', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sink = vi.fn();
    const scheduler = new TimerScheduler(sink);
    const timer = {
      id: 'a',
      workflowId: 'w',
      fireAt: new Date(100).toISOString(),
    };
    scheduler.schedule(timer);
    timer.workflowId = 'changed';
    vi.advanceTimersByTime(100);
    expect(sink).toHaveBeenCalledWith({ ...timer, workflowId: 'w' });
    scheduler.schedule(timer);
    scheduler.schedule({ ...timer, fireAt: new Date(300).toISOString() });
    vi.advanceTimersByTime(100);
    expect(sink).toHaveBeenCalledTimes(1);
    scheduler.cancel('a');
    scheduler.cancel('missing');
    vi.advanceTimersByTime(100);
    expect(sink).toHaveBeenCalledTimes(1);
    scheduler.schedule(timer);
    vi.advanceTimersByTime(1);
    expect(sink).toHaveBeenCalledTimes(2);
    scheduler.schedule({ ...timer, fireAt: new Date(1000).toISOString() });
    scheduler.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => scheduler.schedule({ ...timer, fireAt: 'bad' })).toThrow(
      'Invalid fireAt',
    );
  });
  it('does not fire long delays early and permits sink re-scheduling', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const timer = {
      id: 'long',
      workflowId: 'w',
      fireAt: new Date(2 ** 31 + 100).toISOString(),
    };
    const sink = vi.fn(() =>
      scheduler.schedule({
        ...timer,
        fireAt: new Date(Date.now() + 10).toISOString(),
      }),
    );
    const scheduler = new TimerScheduler(sink);
    scheduler.schedule(timer);
    vi.advanceTimersByTime(2 ** 31);
    expect(sink).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(sink).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10);
    expect(sink).toHaveBeenCalledTimes(2);
    scheduler.close();
  });
});

describe('FsSpecStore', () => {
  it('writes private UTF-8 specs, verifies bytes, preserves retries, and removes idempotently', () => {
    const root = temporary();
    const store = new FsSpecStore(root);
    const spec = store.write('attempt-1', 'hello');
    expect(spec.path).toBe(join(root, 'specs', 'attempt-1.md'));
    expect(spec.sha256).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    expect(statSync(spec.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(spec.path, 'utf8')).toBe('hello');
    expect(store.write('attempt-1', 'hello')).toEqual(spec);
    expect(() => store.write('attempt-1', 'changed')).toThrow(
      'different content',
    );
    expect(store.verify(spec.path, spec.sha256)).toBe(true);
    writeFileSync(spec.path, 'tampered');
    expect(store.verify(spec.path, spec.sha256)).toBe(false);
    store.remove(spec.path);
    store.remove(spec.path);
    expect(store.verify(spec.path, spec.sha256)).toBe(false);
    const unicode = store.write('unicode', '你好');
    expect(store.verify(unicode.path, unicode.sha256)).toBe(true);
  });
  it('stores domain attempt IDs with separators under distinct names', () => {
    const root = temporary();
    const store = new FsSpecStore(root);
    const meeting = store.write('wf-1/meeting/1/attempt/lead', 'lead');
    const seat = store.write('wf-1:lead', 'seat');
    expect(dirname(meeting.path)).toBe(join(root, 'specs'));
    expect(meeting.path).not.toBe(seat.path);
    expect(store.read(meeting.path, meeting.sha256)).toBe('lead');
    store.removeUnissued('wf-1/meeting/1/attempt/lead');
    expect(store.verify(meeting.path, meeting.sha256)).toBe(false);
    expect(store.verify(seat.path, seat.sha256)).toBe(true);
  });
  it('rejects traversal and refuses symlink reads or overwrite', () => {
    const root = temporary();
    const store = new FsSpecStore(root);
    expect(() => store.write('../escape', 'secret')).toThrow('Invalid attempt');
    expect(() => store.remove(join(root, 'outside.md'))).toThrow(
      'Invalid spec',
    );
    expect(() => store.verify(join(root, 'outside.md'), '')).toThrow(
      'Invalid spec',
    );
    const outside = join(root, 'outside.md');
    writeFileSync(outside, 'hello');
    symlinkSync(outside, join(root, 'specs', 'link.md'));
    expect(store.verify(join(root, 'specs', 'link.md'), '')).toBe(false);
    expect(() => store.write('link', 'hello')).toThrow();
    expect(readFileSync(outside, 'utf8')).toBe('hello');
  });
});
