import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createStudioServer } from '../server.mjs';
import { verifyUploadPng } from './poster.mjs';

const project = {
  topic: 'Cat Election', date: 'September 12', venue: 'Studio Courtyard',
  brief: 'A fictional office mascot election. Create a navy-and-cream campaign poster featuring a tuxedo cat. Campaign slogan: Vote for more naps.',
};
const copy = 'The Cat Election poster is ready, with a navy and cream ballot framed around the tuxedo cat, the original headline and campaign slogan, and the confirmed date and venue set together at the foot of the poster.';
const ink = '#14213b', cream = '#fff1d0', gold = '#f2bd62', pink = '#e48781';
const invalidCall = {
  id: 'call_missing_layer', name: 'run_canvas',
  args: { commands: [{ op: 'paint', id: 'missing-halo', style: { fill: gold } }] },
};
const truncatedCall = {
  id: 'call_truncated', name: 'run_canvas',
  args: '{"commands":[{"op":"arrange","operations":[{"op":"set","id":"title","set":{"x":150}}]}',
  finishReason: 'length',
};

function lettering(id, text, y, h, fontSize, style = {}) {
  return { id, label: text, text, x: 45, y, w: 510, h, style: {
    fontFamily: 'sans', fontSize, fontWeight: 800, textAlign: 'center', textColor: cream, ...style,
  } };
}

function oval(id, x, y, w, h, fill) {
  return { id, shape: 'ellipse', x, y, w, h, style: { fill } };
}

function drawingPath(id, d, fill, stroke = 'none', strokeWidth = 0) {
  return { id, shape: 'path', d, style: { fill, stroke, strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round' } };
}

const validCall = {
  id: 'call_draw_cat', name: 'run_canvas', args: { commands: [
    { op: 'palette', preset: 'mono-dark', decorations: 'none', gradient: {
      type: 'linear', x1: 0, y1: 0, x2: 1, y2: 1,
      stops: [{ offset: 0, color: ink }, { offset: 1, color: '#263955' }],
    } },
    { op: 'arrange', operations: [
      { op: 'set', id: 'title', set: {
        x: 47, y: 111, w: 506, h: 181, text: 'Cat\nElection', size: 92, weight: 800,
        style: { fontFamily: 'sans', textAlign: 'center', textColor: cream, letterSpacing: -3, lineHeight: .92 },
      } },
      { op: 'set', id: 'info', set: {
        x: 50, y: 687, w: 500, h: 57, size: 18,
        style: { fontFamily: 'sans', textAlign: 'center', textColor: cream, lineHeight: 1.3 },
      } },
      { op: 'add', element: { id: 'ballot-frame', type: 'shape', shape: 'rect', label: 'Ballot border',
        x: 28, y: 28, w: 544, h: 744, style: { radius: 13, fill: 'none', stroke: '#7d766b', strokeWidth: 1.6 } } },
    ] },
    { op: 'draw', layer: { id: 'cat-candidate', label: 'Tuxedo cat candidate', x: 87, y: 297, w: 426, h: 274,
      viewWidth: 426, viewHeight: 274, parts: [
        oval('campaign-medallion', 90, 8, 246, 246, gold),
        oval('campaign-medallion-inner', 102, 20, 222, 222, '#e9a953'),
        drawingPath('stars', 'M48 53l5 10 11 2-8 8 1 11-9-5-10 5 2-11-8-8 11-2ZM374 92l6 12 13 2-10 9 3 13-12-6-12 6 2-13-9-9 13-2ZM52 187l5 8 9 2-7 7 1 9-8-4-8 4 1-9-7-7 9-2Z', cream),
        drawingPath('tail', 'M272 224c34 13 72 0 74-25 1-16-12-24-25-19', 'none', ink, 19),
        oval('body', 132, 126, 162, 141, ink),
        drawingPath('shirt', 'M174 161c12 16 24 24 39 24s29-8 41-24l11 72c-10 13-27 24-52 24-26 0-42-10-53-24Z', cream),
        drawingPath('cat-face', 'M136 115l8-79c1-7 8-9 13-3l36 39c13-3 29-3 41 0l37-39c5-6 12-4 13 3l8 79c0 42-29 69-78 69s-78-26-78-69Z', ink),
        drawingPath('ear-lining', 'M153 54l-4 40 30-19ZM273 54l4 40-30-19Z', pink),
        drawingPath('white-muzzle', 'M213 114c10 0 12 17 24 17 15 0 28 7 28 20 0 14-23 26-52 26s-52-12-52-26c0-13 13-20 28-20 13 0 14-17 24-17Z', cream),
        oval('eye-left', 174, 107, 17, 11, gold),
        oval('eye-right', 235, 107, 17, 11, gold),
        drawingPath('nose', 'M203 133q10-5 21 0l-11 9Z', pink),
        drawingPath('smile', 'M213 142v7q-1 10-13 9m13-9q1 10 13 9', 'none', ink, 2.5),
        drawingPath('whiskers', 'M185 149l-42-6m41 15-39 3m97-12 43-6m-41 15 40 3', 'none', '#a99a82', 2.4),
        drawingPath('bow-tie', 'M213 196l-27-13v24l27-8 27 8v-24Z', pink),
        oval('tie-knot', 207, 189, 12, 12, '#f8b79a'),
      ],
    } },
    { op: 'text', layers: [
      lettering('ballot-masthead', 'THE OFFICE MASCOT BALLOT', 66, 24, 15, { letterSpacing: 3.1, textColor: gold }),
      lettering('campaign-slogan', 'Vote for more naps', 591, 54, 40),
      lettering('ballot-instruction', 'CAST YOUR BALLOT', 655, 24, 13, { letterSpacing: 2.6, textColor: gold }),
    ] },
    { op: 'resize', preset: 'A2' },
  ] },
};

const refinements = [52, 54, 56, 58].map(x => ({
  id: `call_align_title_${x}`, name: 'run_canvas', args: {
    commands: [{ op: 'arrange', operations: [{ op: 'set', id: 'title', set: { x } }] }],
  },
}));
const serializedCall = { ...validCall, args: { commands: validCall.args.commands.map(command => JSON.stringify(command)) } };
const mockTurns = [invalidCall, serializedCall, truncatedCall, ...refinements, null];

function replyTurn(response, number, tool) {
  const message = { role: 'assistant', content: tool ? null : copy };
  if (tool) message.tool_calls = [{ id: tool.id, type: 'function', function: {
    name: tool.name, arguments: typeof tool.args === 'string' ? tool.args : JSON.stringify(tool.args),
  } }];
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({
    id: `chatcmpl-artist-${number}`, object: 'chat.completion', created: 1, model: 'designer-test',
    choices: [{ index: 0, message, finish_reason: tool?.finishReason ?? (tool ? 'tool_calls' : 'stop') }],
    usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 },
  }));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertPng(bytes, dimensions) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], dimensions);
  assert.equal(bytes.toString('ascii', 37, 41), 'pHYs');
  assert.equal(bytes.readUInt32BE(41), 2000);
}

function imageHash(request, index) {
  const images = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(part => part.type === 'image_url');
  assert.equal(images.length, 1, 'each model call must receive exactly the current poster');
  const url = images[0].image_url.url;
  assert.match(url, /^data:image\/png;base64,/);
  const bytes = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
  assertPng(bytes, index < 2 ? [594, 840] : [840, 1188]);
  return sha256(bytes);
}

function toolFeedback(request, sent) {
  const call = request.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? [])
    .find(item => item.id === sent.id);
  assert.ok(call, `assistant history preserves ${sent.id}`);
  assert.equal(call.function.name, sent.name);
  const result = request.messages.find(message => message.role === 'tool' && message.tool_call_id === sent.id);
  assert.ok(result, `tool response is paired with ${sent.id}`);
  return typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
}

test('the designer decodes canvas strings, repairs errors and publishes the reviewed first-draft PNG after approval', { timeout: 30_000 }, async t => {
  const requests = [];
  const upstreamErrors = [];
  const upstream = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      assert.equal(request.url, '/v1/chat/completions');
      const body = JSON.parse(Buffer.concat(chunks));
      requests.push(body);
      const turn = requests.length;
      assert.ok(turn <= mockTurns.length, 'unexpected extra upstream request');
      replyTurn(response, turn, mockTurns[turn - 1]);
    } catch (error) {
      upstreamErrors.push(error.message);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));

  const temporary = path.resolve(tmpdir());
  const prefix = 'studio-designer-agent-';
  const dataDirectory = await mkdtemp(path.join(temporary, prefix));
  const studio = createStudioServer({ dataDirectory, voiceEnabled: false, dialogueModel: null, settingsEnv: {
    STUDIO_AGENT_MODE: 'api', STUDIO_MODEL_URL: `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`,
    STUDIO_MODEL: 'designer-test', STUDIO_MODEL_KEY: 'controlled-test-key',
  } });
  t.after(async () => {
    await studio.close();
    if (path.dirname(dataDirectory) === temporary && path.basename(dataDirectory).startsWith(prefix)) await rm(dataDirectory, { recursive: true });
  });
  studio.server.listen(0, '127.0.0.1');
  await once(studio.server, 'listening');
  const origin = `http://127.0.0.1:${studio.server.address().port}`;
  const response = await fetch(`${origin}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ language: 'en', project }),
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.deepEqual(created.versions, []);
  assert.equal(created.job.initial, true);
  const base = `${origin}/api/sessions/${created.id}`;
  const deadline = Date.now() + 15_000;
  let state;
  do {
    const current = await fetch(base, { headers: { Connection: 'close' } });
    assert.equal(current.status, 200);
    state = await current.json();
    if (state.draft) break;
    assert.notEqual(state.job.status, 'failed', [state.job.error, ...upstreamErrors].filter(Boolean).join('\n'));
    await delay(35);
  } while (Date.now() < deadline);

  assert.deepEqual(upstreamErrors, []);
  assert.equal(requests.length, mockTurns.length);
  assert.ok(requests.every(request => request.stream !== true));
  for (const request of requests) {
    assert.equal(Object.hasOwn(request, 'max_tokens'), false);
    assert.equal(Object.hasOwn(request, 'max_completion_tokens'), false);
    assert.equal(Object.hasOwn(request, 'max_output_tokens'), false);
  }
  assert.ok(requests[0].tools.some(tool => tool.function.name === 'run_canvas'));
  assert.match(JSON.stringify(requests[0].messages), /Cat Election/);
  assert.match(requests[0].messages[0].content, /Apply the installed canvas-design skill/);
  assert.match(toolFeedback(requests[1], invalidCall), /missing-halo/);
  assert.match(toolFeedback(requests[2], validCall), /cat-candidate/);
  assert.deepEqual(JSON.parse(toolFeedback(requests[2], validCall)).canvas,
    { width: 840, height: 1188, paper: { format: 'A2', widthMm: 420, heightMm: 594 } });
  assert.match(toolFeedback(requests[3], truncatedCall), /truncat/i);
  assert.match(JSON.stringify(requests[3].messages), /Use exactly one tool call with one small edit now/);
  const delivery = requests.at(-1);
  assert.equal(delivery.tools, undefined, 'the last turn is reserved for the spoken delivery');
  assert.match(JSON.stringify(delivery.messages.at(-1).content[0]), /Editing is complete/);
  assert.match(toolFeedback(delivery, refinements.at(-1)), /title/);
  const hashes = requests.map(imageHash);
  const [initialHash, failedHash, renderedHash, truncatedHash] = hashes;
  const deliveredHash = hashes.at(-1);
  assert.equal(failedHash, initialHash, 'a rejected tool call must leave the board unchanged');
  assert.equal(truncatedHash, renderedHash, 'a truncated tool call must preserve the last rendered poster');
  assert.notEqual(renderedHash, initialHash, 'a valid vector edit must deliver a newly rendered image');

  assert.equal(state.job.status, 'awaitingApproval');
  assert.equal(state.versions.length, 0);
  assert.equal(state.draft.pngHash, deliveredHash);
  assert.deepEqual(state.draft.paper, { format: 'A2', widthMm: 420, heightMm: 594 });
  const approval = await fetch(`${base}/commands`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ id: 'approve-cat-election', type: 'confirmDraft', payload: { draftId: state.draft.id } }),
  });
  assert.equal(approval.status, 200, await approval.clone().text());
  state = (await approval.json()).state;
  assert.equal(state.job.status, 'completed');
  assert.equal(state.job.id, created.job.id);
  assert.equal(state.selectedVersionId, 'V01');
  assert.equal(state.versions.length, 1);
  assert.ok(state.toolTraces.some(entry => entry.tool === 'load_skill' && entry.input.name === 'canvas-design' && entry.output.loaded));
  const traces = state.toolTraces.filter(entry => entry.tool === 'run_canvas');
  assert.deepEqual(traces.map(entry => [entry.callId, entry.status]), [
    [invalidCall.id, 'error'], [validCall.id, 'ok'], [truncatedCall.id, 'not_executed'],
    ...refinements.map(call => [call.id, 'ok']),
  ]);
  assert.match(traces[0].output.error, /missing-halo/);
  assert.ok(traces[1].input.arguments.commands.every(command => typeof command === 'object' && command !== null));
  assert.equal(traces[2].output.executed, false);
  assert.ok(state.toolTraces.some(entry => entry.tool === 'chat.completions' && entry.finishReason === 'length'));
  assert.equal(traces[1].output.preview.sha256, renderedHash);
  const version = state.versions[0];
  assert.equal(version.pngHash, deliveredHash);
  assert.ok(version.elements.some(layer => layer.id === 'cat-candidate'));
  assert.ok(state.messages.some(message => message.role === 'yi' && message.mode === 'online' && message.text === copy));

  const exported = await fetch(`${base}/versions/V01/poster.png`, { headers: { Connection: 'close' } });
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get('Content-Type'), 'image/png');
  const png = Buffer.from(await exported.arrayBuffer());
  assertPng(png, [840, 1188]);
  const decoded = verifyUploadPng(`data:image/png;base64,${png.toString('base64')}`);
  assert.deepEqual([decoded.width, decoded.height], [840, 1188]);
  assert.equal(sha256(png), deliveredHash, 'the delivered V01 is the poster the model last inspected');
  const svg = await fetch(`${base}/versions/V01/poster.svg`, { headers: { Connection: 'close' } });
  assert.equal(svg.status, 200);
  const markup = await svg.text();
  assert.match(markup, /width="420mm" height="594mm" viewBox="0 0 840 1188"/);
  assert.match(markup, /data-vector-part="cat-face"/);
  assert.match(markup, /Vote for more naps/);
  assert.match(markup, /September 12/);
  assert.match(markup, /Studio Courtyard/);

  const output = process.env.STUDIO_TEST_AGENT_PNG;
  if (output) {
    await mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await writeFile(output, png);
    const { dir, name } = path.parse(output);
    await writeFile(path.join(dir, `${name}.svg`), markup);
  }
});
