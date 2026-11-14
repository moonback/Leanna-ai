export type SseEvent = { event: string; data: unknown };

/**
 * Incremental text/event-stream parser. Network chunks can split an event anywhere,
 * so input is buffered until a blank line closes the event. Comment lines (": ping")
 * are heartbeats and are ignored.
 */
export function createSseParser(onEvent: (event: SseEvent) => void) {
  let buffer = '';
  return {
    push(chunk: string) {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trimStart();
        }
        if (data) onEvent({ event, data: JSON.parse(data) });
      }
    },
  };
}
