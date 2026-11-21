import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAgentLoop } from '@earendil-works/pi-agent-core';
import { configureChatProvider } from './chat-provider.mjs';
import { createPosterPiTransport } from './pi-poster-transport.mjs';

const edit = {
  name: 'edit_poster', label: 'Edit poster', description: 'Edit one poster layer.',
  parameters: { type: 'object', required: ['opacity'], properties: { opacity: { type: 'number' } } },
};
const assignment = { role: 'user', content: 'Adjust the poster.', timestamp: 0 };
const instruction = { role: 'system', content: 'Use the canvas tool.', timestamp: 0 };

function transport() {
  return createPosterPiTransport(configureChatProvider({
    mode: 'api', url: 'https://poster-fixture.invalid/v1/chat/completions', model: 'fixture-model',
  }, 'FIXTURE', 1000));
}

function response(finishReason, content, calls) {
  return Response.json({ choices: [{ finish_reason: finishReason, message: {
    role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}),
  } }] });
}

function toolCall(id, args) {
  return { id, type: 'function', function: { name: edit.name, arguments: args } };
}

function assertProviderBudget(model, requests) {
  assert.ok(!Object.hasOwn(model, 'contextWindow'));
  assert.ok(!Object.hasOwn(model, 'maxTokens'));
  for (const request of requests) {
    assert.ok(!Object.hasOwn(request, 'max_tokens'));
    assert.ok(!Object.hasOwn(request, 'max_completion_tokens'));
  }
}

test('Pi retries truncated native tools under their original IDs without executing the batch', async t => {
  const requests = [];
  const applied = [];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    requests.push(JSON.parse(request.body));
    if (requests.length === 1) return response('length', 'tools:\n  - name: edit_poster\n    arguments:', [
      toolCall('first-truncated-id', '{"opacity":0.5}'),
      toolCall('second-truncated-id', '{"opacity":'),
    ]);
    if (requests.length === 2) return response('tool_calls', null, [toolCall('repaired-id', '{"opacity":0.8}')]);
    return response('stop', 'The edit is ready.');
  });
  const { model, streamFn, getFailure } = transport();
  const events = [];
  const history = await runAgentLoop([assignment], {
    messages: [instruction],
    tools: [{ ...edit, async execute(id, args) {
      applied.push({ id, args });
      return { content: [{ type: 'text', text: 'Edited.' }], details: {} };
    } }],
  }, { model, maxTokens: 40, convertToLlm: messages => messages, toolExecution: 'sequential' }, event => events.push(event), undefined, streamFn);

  const first = history.find(item => item.role === 'assistant');
  assert.equal(first.stopReason, 'length');
  assert.equal(first.rawStopReason, 'length');
  assert.deepEqual(first.content.map(part => [part.type, part.id]), [
    ['toolCall', 'first-truncated-id'], ['toolCall', 'second-truncated-id'],
  ]);
  assert.ok(first.content.every(part => part.argumentsError && Object.keys(part.arguments).length === 0));
  const failed = events.find(event => event.type === 'turn_end' && event.message.stopReason === 'length');
  assert.deepEqual(failed.toolResults.map(result => [result.toolCallId, result.isError]), [
    ['first-truncated-id', true], ['second-truncated-id', true],
  ]);
  assert.deepEqual(requests[1].messages.filter(message => message.role === 'tool').map(message => message.tool_call_id),
    ['first-truncated-id', 'second-truncated-id']);
  assert.deepEqual(applied, [{ id: 'repaired-id', args: { opacity: 0.8 } }]);
  assert.equal(requests.length, 3);
  assertProviderBudget(model, requests);
  assert.equal(getFailure(), undefined);
});

test('truncated JSON arrives as a length turn and a Pi continuation leaves the fragment out', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    requests.push(JSON.parse(request.body));
    if (requests.length === 1) return Response.json({ error: { message: 'Native tools are unavailable' } }, { status: 400 });
    if (requests.length === 2) return response('length', '{"tools":[{"name":"edit_poster","arguments":');
    return response('stop', '{"clarification":"I can split the edit."}');
  });
  const { model, streamFn, getFailure } = transport();
  const history = await runAgentLoop([assignment], {
    messages: [instruction],
    tools: [{ ...edit, execute: () => assert.fail('No truncated JSON tool should execute') }],
  }, {
    model, maxTokens: 40,
    convertToLlm: messages => messages,
    finishTurn: ({ message }) => message.stopReason === 'length' ? { action: 'continue' } : undefined,
    prepareNextTurn: ({ message }) => message.stopReason === 'length' ? {
      messages: [{ role: 'user', content: 'Retry using one smaller action.', timestamp: 0 }],
    } : undefined,
  }, () => {}, undefined, streamFn);

  const assistant = history.filter(item => item.role === 'assistant');
  assert.equal(assistant[0].stopReason, 'length');
  assert.deepEqual(assistant[0].content, []);
  assert.equal(assistant[1].content[0].text, 'I can split the edit.');
  assert.equal(requests.length, 3);
  assert.equal(requests[2].tools, undefined);
  assert.ok(requests[2].messages.some(message => message.content === 'Retry using one smaller action.'));
  assert.ok(!requests[2].messages.some(message => message.role === 'assistant'));
  assertProviderBudget(model, requests);
  assert.equal(getFailure(), undefined);
});

test('the JSON compatibility transport supplies the model’s tool progress as Pi assistant text', async t => {
  const requests = [];
  const order = [];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    requests.push(JSON.parse(request.body));
    if (requests.length === 1) return Response.json({ error: { message: 'Native tools are unavailable' } }, { status: 400 });
    if (requests.length === 2) return response('stop', JSON.stringify({ progress: 'I am adjusting the contrast.',
      tools: [{ id: 'compat-adjust', name: edit.name, arguments: { opacity: 0.8 } }] }));
    return response('stop', 'The edit is ready.');
  });
  const { model, streamFn } = transport();
  await runAgentLoop([assignment], { messages: [instruction], tools: [{ ...edit, async execute() {
    order.push('tool');
    return { content: [{ type: 'text', text: 'Edited.' }], details: {} };
  } }] }, {
    model, convertToLlm: messages => messages,
    async beforeToolCall({ assistantMessage }) {
      order.push(assistantMessage.content.find(part => part.type === 'text')?.text);
    },
  }, () => {}, undefined, streamFn);
  assert.deepEqual(order, ['I am adjusting the contrast.', 'tool']);
  assert.equal(requests.length, 3);
  assertProviderBudget(model, requests);
});
