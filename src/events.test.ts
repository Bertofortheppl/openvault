import { describe, expect, it, vi } from 'vitest';
import type { V2Event } from '@opencode-ai/sdk/v2/client';
import { TurnReducer, type TurnCallbacks } from './events';

let seq = 0;

function event(type: string, data: Record<string, unknown>): V2Event {
  seq += 1;
  return { id: `evt-${seq}`, type, data } as unknown as V2Event;
}

function setup(sessionId = 'session-1') {
  const onText = vi.fn();
  const onStatus = vi.fn();
  const onPermission = vi.fn();
  const onSettled = vi.fn();
  const callbacks: TurnCallbacks = {
    onText,
    onStatus,
    onPermission,
    onSettled,
  };
  const reducer = new TurnReducer(sessionId, callbacks);
  reducer.begin();
  return { reducer, onText, onStatus, onPermission, onSettled };
}

describe('TurnReducer', () => {
  it('accumulates text deltas and settles on idle', () => {
    const { reducer, onText, onSettled } = setup();

    reducer.handle(
      event('session.next.text.delta', {
        sessionID: 'session-1',
        textID: 'text-1',
        delta: 'Hello ',
      }),
    );
    reducer.handle(
      event('session.next.text.delta', {
        sessionID: 'session-1',
        textID: 'text-1',
        delta: 'world',
      }),
    );
    reducer.handle(event('session.idle', { sessionID: 'session-1' }));

    expect(onText).toHaveBeenLastCalledWith('Hello world');
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({
      text: 'Hello world',
      error: undefined,
      aborted: false,
    });
  });

  it('keeps text parts separated across tool calls', () => {
    const { reducer, onSettled } = setup();

    reducer.handle(
      event('session.next.text.delta', {
        sessionID: 'session-1',
        textID: 'text-1',
        delta: 'Before',
      }),
    );
    reducer.handle(
      event('session.next.tool.called', {
        sessionID: 'session-1',
        tool: 'read',
      }),
    );
    reducer.handle(
      event('session.next.text.delta', {
        sessionID: 'session-1',
        textID: 'text-2',
        delta: 'After',
      }),
    );
    reducer.handle(event('session.status', {
      sessionID: 'session-1',
      status: { type: 'idle' },
    }));

    expect(onSettled).toHaveBeenCalledWith({
      text: 'Before\n\nAfter',
      error: undefined,
      aborted: false,
    });
  });

  it('uses the durable text when a part ends', () => {
    const { reducer, onSettled } = setup();

    reducer.handle(
      event('session.next.text.delta', {
        sessionID: 'session-1',
        textID: 'text-1',
        delta: 'partial',
      }),
    );
    reducer.handle(
      event('session.next.text.ended', {
        sessionID: 'session-1',
        textID: 'text-1',
        text: 'complete response',
      }),
    );
    reducer.handle(event('session.idle', { sessionID: 'session-1' }));

    expect(onSettled).toHaveBeenCalledWith({
      text: 'complete response',
      error: undefined,
      aborted: false,
    });
  });

  it('ignores events for other sessions', () => {
    const { reducer, onText, onSettled } = setup();

    reducer.handle(
      event('session.next.text.delta', {
        sessionID: 'session-2',
        textID: 'text-1',
        delta: 'other',
      }),
    );
    reducer.handle(event('session.idle', { sessionID: 'session-2' }));

    expect(onText).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('dedupes repeated event ids', () => {
    const { reducer, onText } = setup();
    const delta = {
      id: 'same-id',
      type: 'session.next.text.delta',
      data: { sessionID: 'session-1', textID: 'text-1', delta: 'once' },
    } as unknown as V2Event;

    reducer.handle(delta);
    reducer.handle(delta);

    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith('once');
  });

  it('surfaces step failures and settles without waiting for idle', () => {
    const { reducer, onSettled } = setup();

    reducer.handle(
      event('session.next.step.failed', {
        sessionID: 'session-1',
        error: { message: 'model failed' },
      }),
    );

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({
      text: '',
      error: 'model failed',
      aborted: false,
    });

    // A late idle (if the server ever sends one) must not settle twice.
    reducer.handle(event('session.idle', { sessionID: 'session-1' }));
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('marks aborted sessions', () => {
    const { reducer, onSettled } = setup();

    reducer.handle(
      event('session.error', {
        sessionID: 'session-1',
        error: { name: 'MessageAbortedError' },
      }),
    );

    expect(onSettled).toHaveBeenCalledWith({
      text: '',
      error: undefined,
      aborted: true,
    });
  });

  it('reports tool status and permissions', () => {
    const { reducer, onStatus, onPermission } = setup();

    reducer.handle(
      event('session.next.tool.called', {
        sessionID: 'session-1',
        tool: 'bash',
      }),
    );
    reducer.handle(
      event('permission.v2.asked', {
        sessionID: 'session-1',
        id: 'perm-1',
        action: 'bash',
        resources: ['ls'],
      }),
    );

    expect(onStatus).toHaveBeenCalledWith('Running bash...');
    expect(onPermission).toHaveBeenCalledWith({
      id: 'perm-1',
      action: 'bash',
      resources: ['ls'],
    });

    reducer.handle(
      event('session.next.tool.success', { sessionID: 'session-1' }),
    );
    expect(onStatus).toHaveBeenLastCalledWith('');
  });
});
