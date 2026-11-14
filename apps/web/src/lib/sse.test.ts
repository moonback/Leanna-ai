import { describe, expect, it } from 'vitest';
import { createSseParser, type SseEvent } from './sse';

function parseChunks(chunks: string[]) {
  const events: SseEvent[] = [];
  const parser = createSseParser((e) => events.push(e));
  chunks.forEach((c) => parser.push(c));
  return events;
}

describe('createSseParser', () => {
  it('reassembles an event split across network chunks', () => {
    expect(parseChunks(['event: del', 'ta\ndata: {"te', 'xt":"Bon"}', '\n', '\n'])).toEqual([
      { event: 'delta', data: { text: 'Bon' } },
    ]);
  });

  it('parses several events from one chunk and ignores heartbeats', () => {
    expect(
      parseChunks([
        'event: start\ndata: {"model":"m"}\n\n: ping\n\nevent: delta\ndata: {"text":"a"}\n\n',
      ]),
    ).toEqual([
      { event: 'start', data: { model: 'm' } },
      { event: 'delta', data: { text: 'a' } },
    ]);
  });

  it('keeps an unfinished event buffered until it is closed', () => {
    const events: SseEvent[] = [];
    const parser = createSseParser((e) => events.push(e));
    parser.push('event: done\ndata: {}');
    expect(events).toEqual([]);
    parser.push('\n\n');
    expect(events).toEqual([{ event: 'done', data: {} }]);
  });
});
