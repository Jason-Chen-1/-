import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAgentLoop } from '@earendil-works/pi-agent-core';
import { canvasProgramTool, runCanvasProgram } from './canvas-program.mjs';
import { configureChatProvider } from './chat-provider.mjs';
import { createInitialPoster } from './initial-poster.mjs';
import { createPosterPiTransport } from './pi-poster-transport.mjs';
import { projectTheme } from './project-theme.mjs';

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

for (const protocol of ['native', 'json']) {
  test(`${protocol} canvas calls decode serialized containers before Pi validates and executes them`, async t => {
    const requests = [];
    const applied = [];
    const title = '{"text":"Keep this exact poster copy"}';
    const commands = [
      { op: 'paint', id: 'palette', style: JSON.stringify({ fill: '#07110F' }), gradient: null },
      { op: 'text', layers: JSON.stringify([{ id: 'title', text: title }]) },
    ];
    const args = { commands: commands.map(command => JSON.stringify(command)) };
    const encoded = protocol === 'native' ? args : { commands: JSON.stringify(args.commands) };
    t.mock.method(globalThis, 'fetch', async (_url, request) => {
      const body = JSON.parse(request.body);
      requests.push(body);
      if (protocol === 'json' && requests.length === 1) {
        return Response.json({ error: { message: 'Native tools are unavailable' } }, { status: 400 });
      }
      if (!body.messages.some(message => message.role === 'tool' ||
          (message.role === 'user' && typeof message.content === 'string' && message.content.includes('toolResults')))) {
        const call = { id: 'serialized-canvas', type: 'function',
          function: { name: 'run_canvas', arguments: JSON.stringify(encoded) } };
        return protocol === 'native' ? response('tool_calls', null, [call])
          : response('stop', JSON.stringify({ tools: [{ id: call.id, name: 'run_canvas', arguments: JSON.stringify(encoded) }] }));
      }
      return response('stop', 'The poster is ready.');
    });
    let scene = createInitialPoster(projectTheme(undefined, { topic: 'CrosspointX' }));
    const { model, streamFn, getFailure } = transport();
    const history = await runAgentLoop([assignment], { messages: [instruction], tools: [{
      ...canvasProgramTool.function, label: 'Canvas',
      async execute(id, parameters) {
        applied.push({ id, parameters });
        scene = runCanvasProgram(scene, parameters).scene;
        return { content: [{ type: 'text', text: 'Rendered.' }], details: {} };
      },
    }] }, { model, convertToLlm: messages => messages, toolExecution: 'sequential' }, () => {}, undefined, streamFn);
    assert.deepEqual(applied, [{ id: 'serialized-canvas', parameters: { commands: [
      { op: 'paint', id: 'palette', style: { fill: '#07110F' }, gradient: null },
      { op: 'text', layers: [{ id: 'title', text: title }] },
    ] } }]);
    assert.equal(scene.elements.find(layer => layer.id === 'palette').style.fill, '#07110f');
    assert.equal(scene.elements.find(layer => layer.id === 'title').text, title);
    assert.ok(history.some(message => message.role === 'toolResult' && message.toolCallId === 'serialized-canvas' && !message.isError));
    assert.equal(requests.length, protocol === 'native' ? 2 : 3);
    assert.equal(getFailure(), undefined);
  });
}

test('malformed canvas strings and invalid decoded values remain rejected and repairable', async t => {
  const requests = [];
  const applied = [];
  const badCommands = ['{"op":"paint"', JSON.stringify({ op: 'unsupported-operation' }), JSON.stringify([])];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    requests.push(body);
    const index = requests.length - 1;
    if (index <= badCommands.length) return response('tool_calls', null, [{
      id: `canvas-${index}`, type: 'function', function: { name: 'run_canvas', arguments: JSON.stringify({
        commands: index < badCommands.length ? [badCommands[index]] : [{ op: 'paint', id: 'palette', style: { fill: '#07110F' } }],
      }) },
    }]);
    return response('stop', 'The corrected poster is ready.');
  });
  const { model, streamFn, getFailure } = transport();
  const history = await runAgentLoop([assignment], { messages: [instruction], tools: [{
    ...canvasProgramTool.function, label: 'Canvas',
    async execute(id, args) {
      applied.push({ id, args });
      return { content: [{ type: 'text', text: 'Rendered.' }], details: {} };
    },
  }] }, { model, convertToLlm: messages => messages, toolExecution: 'sequential' }, () => {}, undefined, streamFn);
  assert.deepEqual(applied.map(call => call.id), ['canvas-3']);
  assert.deepEqual(history.filter(message => message.role === 'toolResult').map(message => [message.toolCallId, message.isError]),
    [['canvas-0', true], ['canvas-1', true], ['canvas-2', true], ['canvas-3', false]]);
  for (let index = 0; index < badCommands.length; index++) {
    assert.ok(requests[index + 1].messages.some(message => message.role === 'tool' && message.tool_call_id === `canvas-${index}`));
  }
  assert.equal(getFailure(), undefined);
});
