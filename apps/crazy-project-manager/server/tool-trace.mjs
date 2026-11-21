const capacity = 72;
const payloadLimit = 4800;

function traceValue(value, limit = payloadLimit) {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value, (key, item) => {
    if (/^(?:authorization|api[-_]?key|token|secret|password|reasoning(?:_content)?)$/i.test(key)) return '[redacted]';
    if (typeof item !== 'string') return item;
    if (/^data:[^,]+;base64,/i.test(item)) return { media: item.slice(5, item.indexOf(';')), bytesEmbedded: false };
    return item.replace(/Bearer\s+[\w.\-+/=]+/gi, 'Bearer [redacted]');
  });
  if (json.length > limit) return { truncated: true, json: json.slice(0, limit) };
  return JSON.parse(json);
}

export function toolResult(tool, input, output, startedAt, status = 'ok', endedAt = Date.now()) {
  return { tool, status, input, output, at: startedAt, durationMs: Math.max(0, endedAt - startedAt) };
}

export function recordTools(tx, { runId, role, versionId }, entries) {
  if (!entries.length) return;
  const traces = tx.state.toolTraces ??= [];
  for (const entry of entries) {
    const callId = typeof entry.input?.callId === 'string' ? entry.input.callId : undefined;
    const finishReason = typeof entry.output?.finish_reason === 'string' ? entry.output.finish_reason : undefined;
    const trace = {
      id: `tool-${tx.state.seq + 1}`, runId, role, tool: entry.tool, status: entry.status, versionId,
      ...(callId ? { callId } : {}),
      ...(finishReason ? { finishReason } : {}),
      input: callId ? { callId, arguments: traceValue(entry.input.arguments, 10000) } : traceValue(entry.input),
      output: traceValue(entry.output), at: entry.at, durationMs: entry.durationMs
    };
    traces.push(trace);
    tx.emit('agent-tool', { trace }, { role, versionId });
  }
  if (traces.length > capacity) traces.splice(0, traces.length - capacity);
}
