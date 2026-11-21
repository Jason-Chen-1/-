export async function readTurnResponse(response, onResearch) {
  if (!response.headers?.get('content-type')?.startsWith('application/x-ndjson')) {
    const turn = await response.json();
    for (const event of turn.research || []) onResearch(event);
    return turn;
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  let turn;
  try {
    while (true) {
      const {done, value} = await reader.read();
      const lines = (pending + (value || '')).split('\n');
      pending = done ? '' : lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'research') onResearch(event);
        if (event.type === 'turn') turn = event;
        if (event.type === 'error') throw new Error(event.error);
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!turn) throw new Error('角色回合中断，请重试。');
  return turn;
}
