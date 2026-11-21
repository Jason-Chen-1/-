import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createStudioServer } from '../server.mjs';
import { verifyUploadPng } from './poster.mjs';
import { rasterizePoster } from './poster-render.mjs';

const modelEndpoint = 'https://model.fixture.invalid/v1/chat/completions';
const amdOrigin = 'https://h3.oneclickamd.ai';
const amdModel = 'Qwen-Image-2.1-Turbo';
const amdKey = 'fixture-amd-personal-key';
const modelKey = 'fixture-designer-key';
const upstreamTaskId = '21db70d7239b46f79688cc068e434ed5';
const editedTaskId = '39426f490aa649e48f6d953229c71b64';
const signature = 'fixture-image-download-signature';
const editedSignature = 'fixture-edited-image-download-signature';
const signedUrl = `${amdOrigin}/v1/files/download?exp=1799999999&sig=${signature}`;
const editedUrl = `${amdOrigin}/v1/files/download?exp=1799999999&sig=${editedSignature}`;
const project = {
  topic: 'Fox Lantern Walk', date: 'September 12', venue: 'Studio Courtyard',
  brief: 'Create an event poster with a fox surrounded by warm lantern light. Keep the event name, date and venue intact.',
};
const studioSettings = {
  STUDIO_AGENT_MODE: 'api', STUDIO_MODEL_URL: modelEndpoint, STUDIO_MODEL: 'designer-fixture', STUDIO_MODEL_KEY: modelKey,
  STUDIO_IMAGE_MODE: 'amd', AMD_CREATIVE_HUB_API_KEY: amdKey,
};
const artPrompt = 'A russet fox resting under a paper lantern, cut-paper shapes against a warm ivory backdrop, no lettering';
const editPrompt = 'Keep the fox and use the blue palette to cool the sky. Match the current poster layout without adding lettering.';
const delivery = 'I placed the edited fox artwork and kept the date and venue easy to find.';
const generateCall = { id: 'call_generate_fox', name: 'generate_image', args: { id: 'fox', mode: 'generate', prompt: artPrompt, aspectRatio: '1:1', name: 'Fox' } };
const editCallId = 'call_edit_fox';
const placementCallId = 'call_place_fox';
const editedPlacementCallId = 'call_place_edited_fox';
const previewCall = { id: 'call_preview_fox', name: 'preview_draft', args: {} };
const submitCall = { id: 'call_submit_fox', name: 'submit_draft', args: { speech: delivery } };
const illustration = rasterizePoster(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
  <rect width="32" height="32" fill="#edb96a"/>
  <path d="M4 11L11 14L22 14L28 11L26 24L16 30L6 24Z" fill="#d35535"/>
  <circle cx="16" cy="21" r="4" fill="#722c34"/>
</svg>`).asPng();
const swatch = rasterizePoster(`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#589bb6"/></svg>`).asPng();
const editedIllustration = rasterizePoster(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24">
  <rect width="32" height="24" fill="#589bb6"/>
  <path d="M4 3L11 6L22 6L28 3L26 16L16 22L6 16Z" fill="#d35535"/>
  <circle cx="16" cy="13" r="4" fill="#722c34"/>
</svg>`).asPng();

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const pngUrl = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
const reference = bytes => ({ type: 'image_url', role: 'reference', image_url: { url: pngUrl(bytes) } });

function assertPrivateDataAbsent(text) {
  for (const value of [amdKey, modelKey, upstreamTaskId, editedTaskId, signature, editedSignature, `${amdOrigin}/v1/files/download`]) {
    assert.ok(!text.includes(value), 'credentials and AMD download details must stay server-side');
  }
}

function toolReply(turn, call) {
  return Response.json({
    id: `chatcmpl-image-${turn}`, object: 'chat.completion', created: 1, model: 'designer-fixture',
    choices: [{ index: 0, finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: {
        name: call.name, arguments: JSON.stringify(call.args),
      } }],
    } }],
  });
}

function posterAttachment(request) {
  const attachments = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(part => part.type === 'image_url');
  assert.equal(attachments.length, 1, 'each model request receives one current poster');
  const { bytes, width, height } = verifyUploadPng(attachments[0].image_url.url);
  assert.deepEqual([width, height], [594, 840]);
  return { bytes, hash: sha256(bytes) };
}

function feedback(request, callId) {
  const result = request.messages.find(message => message.role === 'tool' && message.tool_call_id === callId);
  assert.ok(result, `missing result for ${callId}`);
  return JSON.parse(result.content);
}

function innerPixel(png) {
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  const { pixels } = rasterizePoster(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <image width="${width}" height="${height}" href="data:image/png;base64,${png.toString('base64')}"/>
  </svg>`);
  const offset = (452 * width + 301) * 4;
  return [...pixels.subarray(offset, offset + 4)];
}

function createFixtureStudio(dataDirectory) {
  return createStudioServer({ dataDirectory, publicURL: '', voiceEnabled: false, dialogueModel: null, settingsEnv: studioSettings });
}

async function startStudio(studio) {
  studio.server.listen(0, '127.0.0.1');
  await once(studio.server, 'listening');
  return `http://127.0.0.1:${studio.server.address().port}`;
}

async function createProject(origin) {
  const response = await fetch(`${origin}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ language: 'en', project }),
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assertPrivateDataAbsent(JSON.stringify(created));
  assert.deepEqual(created.versions, []);
  return created;
}

async function waitForPoster(base, failures) {
  const deadline = Date.now() + 20_000;
  do {
    const response = await fetch(base, { headers: { Connection: 'close' } });
    assert.equal(response.status, 200);
    const text = await response.text();
    assertPrivateDataAbsent(text);
    const state = JSON.parse(text);
    if (state.draft) {
      assert.equal(state.versions.length, 0);
      assert.equal(state.job.status, 'awaitingApproval');
      const approval = await fetch(`${base}/commands`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
        body: JSON.stringify({ id: 'approve-image-poster', type: 'confirmDraft', payload: { draftId: state.draft.id } }),
      });
      assert.equal(approval.status, 200, await approval.clone().text());
      return (await approval.json()).state;
    }
    assert.notEqual(state.job.status, 'failed', [state.job.error, ...failures].filter(Boolean).join('\n'));
    await delay(60);
  } while (Date.now() < deadline);
  assert.fail(['Timed out waiting for the initial poster', ...failures].join('\n'));
}

test('小乙用 Turbo 生成主图、按三类参考图编辑位图、复核 PNG 并提交初稿', { timeout: 35_000 }, async t => {
  const network = globalThis.fetch;
  const temporary = path.resolve(tmpdir());
  const prefix = 'studio-designer-image-';
  const dataDirectory = await mkdtemp(path.join(temporary, prefix));
  const requests = [];
  const failures = [];
  const amdRequests = [];
  const tasks = [
    { id: upstreamTaskId, statuses: ['queued', 'running', 'succeeded'], url: signedUrl, bytes: illustration },
    { id: editedTaskId, statuses: ['succeeded'], url: editedUrl, bytes: editedIllustration },
  ];
  let studio;
  let localOrigin;
  let materialId;
  let swatchId;
  let editedMaterialId;
  let submissions = 0;
  t.after(async () => {
    await studio?.close();
    if (path.dirname(dataDirectory) === temporary && path.basename(dataDirectory).startsWith(prefix)) await rm(dataDirectory, { recursive: true });
  });

  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === localOrigin) return network(input, options);
    const headers = new Headers(options.headers);
    try {
      if (url.origin === amdOrigin) {
        amdRequests.push([options.method, url.pathname]);
        if (url.href === `${amdOrigin}/v2/video_generation`) {
          assert.equal(options.method, 'POST');
          assert.equal(headers.get('authorization'), `Bearer ${amdKey}`);
          const task = tasks[submissions++];
          assert.ok(task, 'exactly one generation and one edit are permitted');
          const edit = task.id === editedTaskId;
          if (edit) assert.equal(requests.length, 3, 'the reference is the working PNG already shown to Pi');
          assert.deepEqual(JSON.parse(options.body), {
            model: amdModel, aspect_ratio: edit ? '4:3' : '1:1', steps: 8, quality: 'standard',
            content: [{ type: 'text', text: edit ? editPrompt : artPrompt },
              ...(edit ? [swatch, illustration, requests[2].attachment.bytes].map(reference) : [])],
          });
          return Response.json({ task_id: task.id });
        }
        const task = tasks.find(({ id }) => url.href === `${amdOrigin}/v2/query/video_generation/${id}`);
        if (task) {
          assert.equal(options.method, 'GET');
          assert.equal(headers.get('authorization'), `Bearer ${amdKey}`);
          const status = task.statuses.shift();
          assert.ok(status, 'the completed image task should not be polled again');
          return Response.json({ task: { id: task.id, model: amdModel, modality: 'image', status, x_steps: 8,
            ...(status === 'succeeded' ? { content: { type: 'image', url: task.url } } : {}),
          } });
        }
        const download = tasks.find(task => url.href === task.url);
        assert.ok(download, 'downloads can only use a previously issued signed task URL');
        assert.equal(options.method, 'GET');
        assert.equal(headers.has('authorization'), false);
        return new Response(download.bytes, { headers: { 'Content-Type': 'image/png' } });
      }

      assert.equal(url.href, modelEndpoint, 'only the fixture model and fixture AMD may be called');
      assert.equal(headers.get('authorization'), `Bearer ${modelKey}`);
      const request = JSON.parse(options.body);
      assertPrivateDataAbsent(JSON.stringify(request));
      const attachment = posterAttachment(request);
      requests.push({ request, attachment });
      const turn = requests.length;
      if (turn === 1) {
        const generationTool = request.tools.find(tool => tool.function.name === 'generate_image');
        assert.deepEqual(generationTool.function.parameters.properties.mode.enum, ['generate', 'edit']);
        assert.deepEqual(generationTool.function.parameters.properties.aspectRatio.enum, ['1:1', '4:3', '3:4', '16:9', '9:16']);
        assert.equal(generationTool.function.parameters.properties.references.maxItems, 3);
        return toolReply(turn, generateCall);
      }
      if (turn === 2) {
        ({ materialId } = feedback(request, generateCall.id));
        assert.ok(typeof materialId === 'string' && materialId);
        assert.equal(attachment.hash, requests[0].attachment.hash);
        return toolReply(turn, { id: placementCallId, name: 'place_material', args: {
          materialId, id: 'fox-illustration', x: 115, y: 314, w: 370, h: 280,
          fit: 'cover', style: { blendMode: 'multiply' },
        } });
      }
      if (turn === 3) {
        const result = feedback(request, placementCallId);
        assert.ok(result.changed.includes('fox-illustration'));
        assert.equal(result.preview.sha256, attachment.hash);
        assert.notEqual(attachment.hash, requests[0].attachment.hash);
        assert.ok(swatchId, 'the project material was imported before requesting the edit');
        return toolReply(turn, { id: editCallId, name: 'generate_image', args: {
          id: 'fox-blue', mode: 'edit', prompt: editPrompt, aspectRatio: '4:3', name: 'Fox in blue', references: [
            { source: 'material', id: swatchId }, { source: 'layer', id: 'fox-illustration' }, { source: 'poster' },
          ],
        } });
      }
      if (turn === 4) {
        ({ materialId: editedMaterialId } = feedback(request, editCallId));
        assert.ok(editedMaterialId && editedMaterialId !== materialId);
        assert.equal(attachment.hash, requests[2].attachment.hash);
        return toolReply(turn, { id: editedPlacementCallId, name: 'place_material', args: {
          materialId: editedMaterialId, id: 'fox-illustration', x: 115, y: 314, w: 370, h: 280,
          fit: 'cover', style: { blendMode: 'multiply' },
        } });
      }
      if (turn === 5) {
        const result = feedback(request, editedPlacementCallId);
        assert.ok(result.changed.includes('fox-illustration'));
        assert.equal(result.preview.sha256, attachment.hash);
        assert.notEqual(attachment.hash, requests[2].attachment.hash);
        return toolReply(turn, previewCall);
      }
      assert.equal(turn, 6, 'no extra model request after submit_draft');
      assert.equal(feedback(request, previewCall.id).sha256, attachment.hash);
      assert.equal(attachment.hash, requests[4].attachment.hash);
      return toolReply(turn, submitCall);
    } catch (error) {
      failures.push(error.message);
      throw error;
    }
  });

  studio = createFixtureStudio(dataDirectory);
  localOrigin = await startStudio(studio);
  const created = await createProject(localOrigin);
  const base = `${localOrigin}/api/sessions/${created.id}`;
  const importResponse = await fetch(`${base}/commands`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ id: 'add-fox-swatch', type: 'importMaterial', payload: { name: 'Blue palette', data: pngUrl(swatch) } }),
  });
  assert.equal(importResponse.status, 200, await importResponse.clone().text());
  swatchId = (await importResponse.json()).result.materialId;
  const state = await waitForPoster(base, failures);

  assert.deepEqual(failures, []);
  assert.equal(state.job.status, 'completed');
  const [version] = state.versions;
  assert.equal(version.id, 'V01');
  assert.equal(state.versions.length, 1);
  assert.equal(requests.length, 6);
  assert.deepEqual(amdRequests, [
    ['POST', '/v2/video_generation'],
    ...Array.from({ length: 3 }, () => ['GET', `/v2/query/video_generation/${upstreamTaskId}`]),
    ['GET', '/v1/files/download'],
    ['POST', '/v2/video_generation'],
    ['GET', `/v2/query/video_generation/${editedTaskId}`],
    ['GET', '/v1/files/download'],
  ]);
  const sourceHash = sha256(illustration);
  const editedHash = sha256(editedIllustration);
  const material = state.materials.find(item => item.id === materialId);
  const editedMaterial = state.materials.find(item => item.id === editedMaterialId);
  assert.equal(state.materials.length, 3);
  assert.deepEqual([material.id, material.name, material.hash, material.width, material.height], [materialId, 'Fox', sourceHash, 32, 32]);
  assert.deepEqual([editedMaterial.id, editedMaterial.name, editedMaterial.hash, editedMaterial.width, editedMaterial.height],
    [editedMaterialId, 'Fox in blue', editedHash, 32, 24]);
  assert.ok(version.assetHashes.includes(editedHash));
  assert.ok(!version.assetHashes.includes(sourceHash));
  assert.equal(version.elements.filter(layer => layer.id === 'fox-illustration').length, 1);
  assert.ok(state.messages.some(message => message.role === 'yi' && message.text === delivery));
  assert.equal(state.toolTraces.filter(trace => trace.tool === 'generate_image' && trace.status === 'ok').length, 2);
  assert.ok(state.toolTraces.some(trace => trace.tool === 'place_material' && trace.status === 'ok'));

  const assetResponse = await fetch(`${localOrigin}/api/media/${material.hash}`);
  assert.equal(assetResponse.status, 200);
  assert.equal(assetResponse.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await assetResponse.arrayBuffer()), illustration);
  const editedAsset = await fetch(`${localOrigin}/api/media/${editedMaterial.hash}`);
  assert.equal(editedAsset.status, 200);
  assert.deepEqual(Buffer.from(await editedAsset.arrayBuffer()), editedIllustration);
  const pngResponse = await fetch(`${base}/versions/V01/poster.png`);
  assert.equal(pngResponse.status, 200);
  assert.equal(pngResponse.headers.get('content-type'), 'image/png');
  const poster = Buffer.from(await pngResponse.arrayBuffer());
  const dimensions = verifyUploadPng(`data:image/png;base64,${poster.toString('base64')}`);
  assert.deepEqual([dimensions.width, dimensions.height], [594, 840]);
  assert.equal(sha256(poster), requests.at(-1).attachment.hash);
  assert.equal(sha256(poster), version.pngHash);
  assert.notDeepEqual(innerPixel(poster), innerPixel(requests[0].attachment.bytes));
  assert.notDeepEqual(innerPixel(poster), innerPixel(requests[2].attachment.bytes));

  const svgResponse = await fetch(`${base}/versions/V01/poster.svg`);
  assert.equal(svgResponse.status, 200);
  const svg = await svgResponse.text();
  assertPrivateDataAbsent(svg);
  assert.match(svg, /<g id="fox-illustration"[^>]*style="mix-blend-mode:multiply"><image [^>]*preserveAspectRatio="xMidYMid slice"/);
  assert.ok(svg.includes(pngUrl(editedIllustration)));
  assert.match(svg, /September 12/);
  assert.match(svg, /Studio Courtyard/);
});

test('工作台重启时恢复已有 AMD 任务，同一工单只提交一次', { timeout: 30_000 }, async t => {
  const network = globalThis.fetch;
  const temporary = path.resolve(tmpdir());
  const prefix = 'studio-designer-image-recover-';
  const dataDirectory = await mkdtemp(path.join(temporary, prefix));
  const failures = [];
  let studio;
  let localOrigin;
  let submitted = 0;
  let queried = 0;
  let turns = 0;
  let reopened = false;
  let startedQuery;
  const checkpoint = new Promise(resolve => { startedQuery = resolve; });
  t.after(async () => {
    await studio?.close();
    if (path.dirname(dataDirectory) === temporary && path.basename(dataDirectory).startsWith(prefix)) await rm(dataDirectory, { recursive: true });
  });

  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === localOrigin) return network(input, options);
    try {
      if (url.href === `${amdOrigin}/v2/video_generation`) {
        assert.equal(++submitted, 1, 'recovery must not charge for another generation');
        assert.deepEqual(JSON.parse(options.body), { model: amdModel, content: [{ type: 'text', text: artPrompt }],
          aspect_ratio: '1:1', steps: 8, quality: 'standard' });
        return Response.json({ task_id: upstreamTaskId });
      }
      if (url.href === `${amdOrigin}/v2/query/video_generation/${upstreamTaskId}`) {
        queried++;
        if (!reopened) {
          startedQuery();
          return new Promise((_, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
          });
        }
        return Response.json({ task: { id: upstreamTaskId, model: amdModel, modality: 'image', x_steps: 8,
          status: 'succeeded', content: { type: 'image', url: signedUrl } } });
      }
      if (url.href === signedUrl) return new Response(illustration);
      assert.equal(url.href, modelEndpoint);
      const request = JSON.parse(options.body);
      assertPrivateDataAbsent(JSON.stringify(request));
      turns++;
      const results = request.messages.filter(message => message.role === 'tool');
      if (!results.length) {
        if (!reopened) return toolReply(turns, generateCall);
        const assignment = request.messages.find(message => message.role === 'user');
        const input = typeof assignment.content === 'string' ? assignment.content : assignment.content[0].text;
        const { imageGenerations } = JSON.parse(input).context;
        assert.ok(imageGenerations.some(item => item.id === 'fox' && item.status === 'pending'));
        return toolReply(turns, { ...generateCall, args: { id: 'fox' } });
      }
      if (results.length === 1) {
        const { materialId } = feedback(request, generateCall.id);
        return toolReply(turns, { id: placementCallId, name: 'place_material',
          args: { materialId, id: 'fox-illustration', x: 115, y: 314, w: 370, h: 280, fit: 'cover' } });
      }
      assert.equal(feedback(request, placementCallId).preview.sha256, posterAttachment(request).hash);
      return toolReply(turns, submitCall);
    } catch (error) {
      failures.push(error.message);
      throw error;
    }
  });

  studio = createFixtureStudio(dataDirectory);
  localOrigin = await startStudio(studio);
  const created = await createProject(localOrigin);
  await Promise.race([checkpoint, delay(8000, undefined, { ref: false }).then(() => {
    assert.fail(['AMD task was never ready to poll', ...failures].join('\n'));
  })]);
  await studio.close();

  reopened = true;
  studio = createFixtureStudio(dataDirectory);
  localOrigin = await startStudio(studio);
  const state = await waitForPoster(`${localOrigin}/api/sessions/${created.id}`, failures);
  assert.deepEqual(failures, []);
  assert.equal(submitted, 1);
  assert.equal(queried, 2);
  assert.equal(turns, 4);
  assert.equal(state.job.id, created.job.id);
  assert.equal(state.job.status, 'completed');
  assert.equal(state.materials.length, 1);
  assert.ok(state.versions[0].elements.some(layer => layer.id === 'fox-illustration'));
});
