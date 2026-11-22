import { runAgentLoop } from '@earendil-works/pi-agent-core';
import { designerSpeech } from '../shared/designer-speech.mjs';
import { applyPatch } from './poster.mjs';
import { canvasDimensions } from './poster-paper.mjs';
import { designStyleSchema, normalizeDesignPatches } from './design-tools.mjs';
import { posterFontChoices } from './poster-fonts.mjs';
import { amdImageMaxReferences, amdImageRatios } from './amd-image.mjs';
import { amdDesignerTimeoutMs } from './designer-image.mjs';
import { configureChatProvider } from './chat-provider.mjs';
import { createPosterPiTransport } from './pi-poster-transport.mjs';
import { runCanvasTool } from './canvas-tools.mjs';
import { canvasProgramTool, runCanvasProgram } from './canvas-program.mjs';
import { toolResult } from './tool-trace.mjs';
import canvasDesign from './skills/canvas-design/runtime.json' with { type: 'json' };

const placement = {
  name: 'place_material',
  description: 'Place a project bitmap on its own editable layer. Use a new layer ID, or an existing image layer ID to replace its bitmap.',
  parameters: {
    type: 'object', required: ['materialId', 'x', 'y', 'w', 'h'],
    properties: {
      materialId: { type: 'string' }, id: { type: 'string' },
      x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
      fit: { type: 'string', enum: ['contain', 'cover', 'fill'] },
      style: designStyleSchema
    }
  }
};
const imageGeneration = {
  name: 'generate_image',
  description: 'Create or edit a bitmap using Qwen-Image 2.1 Turbo on AMD Creative Hub. Returns a project material ID for place_material.',
  parameters: {
    type: 'object', required: ['id'], additionalProperties: false,
    properties: {
      id: { type: 'string', description: 'A stable lowercase ID for this artwork, such as fox-background. Reuse it to resume an existing generation.' },
      prompt: { type: 'string', description: 'Required for new tasks. Describe the intended image or the edits to the reference images.' },
      mode: { type: 'string', enum: ['generate', 'edit'],
        description: 'Use generate for text-only creation and edit with one to three references. Omit to resume a task.' },
      aspectRatio: { type: 'string', enum: amdImageRatios },
      references: { type: 'array', maxItems: amdImageMaxReferences, items: {
        type: 'object', required: ['source'], additionalProperties: false,
        properties: {
          source: { type: 'string', enum: ['material', 'layer', 'poster'] },
          id: { type: 'string', description: 'Material ID or bitmap layer ID. Omit for the current poster preview.' },
        },
      } },
      name: { type: 'string', description: 'Short descriptive name for the project material library.' },
    },
  },
};
const readPoster = {
  name: 'inspect_poster',
  description: 'Read the editable layer data and available materials. The latest rendered PNG comes with each model request.',
  parameters: { type: 'object', properties: {} }
};
const submit = {
  name: 'submit_draft',
  description: 'Finish after seeing the rendered edit. Provide the final spoken delivery as speech.',
  parameters: { type: 'object', required: ['speech'], properties: { speech: { type: 'string' }, label: { type: 'string' } } }
};
const draftPreview = {
  name: 'preview_draft',
  description: 'Inspect the latest rendered draft. The next model request includes this PNG so you can visually review it.',
  parameters: { type: 'object', properties: {} }
};
const toolDefinitions = [canvasProgramTool.function, placement, readPoster, draftPreview, submit];

const instructions = [
  'You are Xiao Yi, the poster designer. Use run_canvas to change the artwork instead of only describing edits.',
  `Apply the installed ${canvasDesign.name} skill to this poster.`,
  ...canvasDesign.instructions,
  'The request includes the latest rendered PNG, layer IDs and project facts. Preserve confirmed facts. Build the first draft in small batches: set color and type, then add simple artwork if the brief calls for it.',
  'Tool arguments must match their JSON schemas. In run_canvas, commands is an array of objects, not JSON strings. Keep nested layers, operations, parts, style and gradient as JSON arrays or objects too.',
  'New posters start on portrait A3 (297 × 420 mm), and the poster snapshot gives the current dimensions. Keep the current paper unless the brief or the manager calls for another size. Use run_canvas with {"commands":[{"op":"resize","preset":"A4"}]} for A4, A3 or A2, or give widthMm and heightMm within the allowed portrait range. Existing artwork is repositioned and scaled. After resizing, use the updated width and height for further edits.',
  'Use a fresh layer ID such as cat-art for new art. Put vector parts inside draw.layer.parts: {"commands":[{"op":"draw","layer":{"id":"cat-art","x":50,"y":220,"w":500,"h":440,"parts":[{"id":"head","shape":"ellipse","x":80,"y":60,"w":320,"h":260,"style":{"fill":"#111111"}}]}}]}. Path parts use d in place of x, y, w, h.',
  `Select individual text layers with style.fontFamily. Available choices are ${posterFontChoices}. Keep poster copy editable so the next round can revise it.`,
  'Example for an existing title: {"commands":[{"op":"arrange","operations":[{"op":"set","id":"title","set":{"x":40,"y":80,"style":{"fontFamily":"sans","fontWeight":900}}}]}]}.',
  'Use place_material for bitmaps from the project library. For a full-bleed image, set fit to cover and use run_canvas to reorder the image below lettering. Set style.blendMode or style.opacity to blend with lower layers. Use inspect_poster to read exact layers. If an edit fails, use the error and the last good PNG to fix the issue.',
  'Earlier task and reply messages are completed work by Xiao Yi in this project. Follow the current assignment and any new design guidance from the manager. Only act on client requirements explicitly forwarded in the assignment.',
  'Call preview_draft when you want to visually recheck the current work. After seeing the edited PNG, deliver one short spoken sentence in the requested language naming the main result, with at most 30 Chinese characters or 18 English words. Skip introductions, a list of edits, background, and explanations of your process. You may use submit_draft with a speech field. If using JSON tool commands, send {"tools":[{"name":"run_canvas","arguments":{"commands":[...]}}]}.'
].join('\n');
const progressInstructions = 'On the first tool turn only, say one short sentence in the requested language about your next action, at most 20 Chinese characters or 12 English words. Put it in the assistant text next to the tool calls, or in progress for the JSON tool protocol. Continue later tool turns silently. Do not narrate code, internal reasoning, or claim delivery. Reserve one final short spoken sentence for submitting the reviewed draft.';
const imageInstructions = [
  'Use generate_image when the assignment calls for raster artwork. Use mode:generate to make a new image. Use mode:edit and one to three references to revise supplied imagery. A reference can be a project material, a bitmap layer, or the rendered poster. Prefer the relevant bitmap for local edits so the surrounding layers stay editable.',
  'When the context lists an existing Qwen image task for the same artwork, call generate_image with just its id to resume or reuse it. Keep the id stable to avoid submitting duplicate paid tasks. A previous-model entry can no longer be resumed in the current tool.',
  'After generate_image succeeds, place its materialId with place_material. Check the updated PNG before submitting.',
].join('\n');

export const sceneAssetHashes = scene => [...new Set(scene.elements.flatMap(element => {
  const hash = typeof element.image === 'string' && /^studio-asset:([a-f0-9]{64})$/.exec(element.image)?.[1];
  return hash ? [hash] : [];
}))];

export function patchAssetHashes(patches) {
  return sceneAssetHashes({ elements: (patches ?? []).map(patch => patch.element ?? patch.set ?? {}) });
}

export function inspectPoster(scene, materials = []) {
  return {
    ...canvasDimensions(scene),
    layers: scene.elements.map(element => {
      const { image, ...fields } = element;
      return { ...fields, ...(image ? { image: image.startsWith('studio-asset:') ? image : '[existing raster image]' } : {}) };
    }),
    materials: materials.map(({ id, name, width, height, hash }) => ({ id, name, width, height, image: `studio-asset:${hash}` }))
  };
}

export function placeMaterial(materials, parameters, scene) {
  const asset = materials.find(item => item.id === parameters.materialId);
  if (!asset) throw new Error('找不到指定的项目素材。');
  const { id, x, y, w, h, fit = 'contain', style } = parameters;
  const layer = scene?.elements.find(item => item.id === id);
  const fields = { label: asset.name, image: `studio-asset:${asset.hash}`, x, y, w, h, fit,
    ...(style == null ? {} : { style }) };
  if (layer?.type === 'image' || layer?.id === 'visual') {
    return { op: 'set', id, set: { ...fields, hidden: false } };
  }
  return { op: 'add', element: { ...fields, type: 'image', ...(id == null ? {} : { id }) } };
}

function operationPreview(base, raw, materials) {
  const patches = normalizeDesignPatches(raw, base);
  const allowed = new Set([...sceneAssetHashes(base), ...materials.map(item => item.hash)]);
  for (const operation of patches) {
    const layer = operation.element ?? operation.set;
    if (layer?.image != null && (typeof layer.image !== 'string' || !layer.image.startsWith('studio-asset:') || !allowed.has(layer.image.slice(13)))) {
      throw new Error('图片须引用当前项目中已导入的素材。');
    }
  }
  const { scene, diff } = applyPatch(base, patches);
  return { scene, patches, diff };
}

export function prepareCanvasEdits(scene, calls) {
  if (!Array.isArray(calls) || !calls.length || calls.length > 12) throw new Error('画布提交需要 1–12 次编辑。');
  const traces = [];
  let working = scene;
  const patches = [];
  for (const { name, arguments: args } of calls) {
    const at = Date.now();
    const operations = name === 'run_canvas' ? runCanvasProgram(working, args).patches : runCanvasTool(working, name, args);
    const edit = operationPreview(working, operations, []);
    working = edit.scene;
    patches.push(...edit.patches);
    traces.push(toolResult(name, args, { operations: edit.patches }, at));
  }
  return { ...operationPreview(scene, patches, []), traces };
}

const drawingTools = new Set(['run_canvas', 'place_material']);
const maxDesignerEditTurns = 7;
const maxDesignerTurns = maxDesignerEditTurns + 2;
const maxGuidedDesignerTurns = maxDesignerTurns + 4;
const maxDesignerPatches = 30;
const deliveryNote = 'Editing is complete. Review the attached final poster PNG and deliver it in one short plain-text sentence in the requested language naming the main result, at most 30 Chinese characters or 18 English words.';
const speechRepairNote = 'The rendered poster is ready. Look at the attached PNG and say one short sentence in the requested language naming the main result, at most 30 Chinese characters or 18 English words. Return only your spoken words.';

function textContent(content) {
  if (typeof content === 'string') return content.trim();
  return (content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
}

const userMessage = (content, timestamp = Date.now()) => ({ role: 'user', content, timestamp });

function guidanceOf(value) {
  if (typeof value?.text !== 'string' || !value.text.trim()) return null;
  const kind = typeof value.kind === 'string' && value.kind.trim() ? value.kind.trim() : 'instruction';
  return { ...(typeof value.id === 'string' && value.id ? { id: value.id } : {}), kind, text: value.text.trim() };
}

function guidanceMessage(item, timestamp) {
  return userMessage(JSON.stringify({ type: 'design_guidance', kind: item.kind, text: item.text }), timestamp);
}

function assignmentContext(context) {
  if (!context) return {};
  const retry = context.previousError;
  const retryDetail = Object.fromEntries(['code', 'message'].filter(key => typeof retry?.[key] === 'string')
    .map(key => [key, retry[key]]));
  const previousError = typeof retry === 'string' ? retry : Object.keys(retryDetail).length ? retryDetail : undefined;
  const sourceMessages = (Array.isArray(context.sourceMessages) ? context.sourceMessages : []).flatMap(source => {
    const requirements = (Array.isArray(source?.requirements) ? source.requirements : []).flatMap(requirement => {
      if (!requirement || typeof requirement !== 'object') return [];
      const fields = ['id', 'text', 'goal', 'instruction', 'displayInstruction', 'condition', 'concession'];
      const detail = Object.fromEntries(fields.filter(key => typeof requirement[key] === 'string' && requirement[key])
        .map(key => [key, requirement[key]]));
      if (!detail.text && !detail.goal && !detail.instruction && !detail.displayInstruction && !detail.condition) return [];
      if (Array.isArray(requirement.elementIds)) detail.elementIds = requirement.elementIds.filter(id => typeof id === 'string');
      return [detail];
    });
    return requirements.length ? [{
      ...(typeof source.id === 'string' ? { id: source.id } : {}),
      ...(typeof source.role === 'string' ? { role: source.role } : {}), requirements,
    }] : [];
  });
  const meeting = context.meeting;
  return {
    ...(context.urgency === 'rush' || context.urgency === 'normal' ? { urgency: context.urgency } : {}),
    ...(sourceMessages.length ? { sourceMessages } : {}),
    ...(Array.isArray(context.requestedMaterialIds) ? { requestedMaterialIds: context.requestedMaterialIds.filter(id => typeof id === 'string') } : {}),
    ...(Array.isArray(context.imageGenerations) ? { imageGenerations: context.imageGenerations.filter(Boolean)
      .map(({ id, name, aspectRatio, status, materialId }) => ({ id, name, aspectRatio, status, materialId })) } : {}),
    ...(previousError === undefined ? {} : { previousError }),
    ...(meeting?.roundId ? { meeting: { roundId: meeting.roundId, versionId: meeting.versionId, previouslyAssignedThrough: meeting.previouslyAssignedThrough } } : {}),
  };
}

function historyMessages(history, historicalReply) {
  if (!Array.isArray(history)) return [];
  return history.flatMap(record => {
    const reply = designerSpeech(record?.reply);
    if (!reply || (record.role && record.role !== 'yi')) return [];
    const at = Number.isFinite(record.at) ? record.at : 0;
    const messages = [];
    if (typeof record.instruction === 'string' && record.instruction.trim()) messages.push(userMessage(record.instruction.trim(), at));
    if (Array.isArray(record.guidance)) {
      for (const value of record.guidance) {
        const item = guidanceOf(value);
        if (item) messages.push(guidanceMessage(item, at));
      }
    }
    return messages.length ? [...messages, historicalReply(reply, at)] : [];
  });
}

function progressLine(value) {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || Array.from(text).length > 180 || designerSpeech(value) !== text || /https?:\/\//i.test(text)) return '';
  if (/^(?:done|finished|all done)[.!]?$|\b(?:poster|draft|edit) is (?:now )?(?:finished|ready|complete|done)\b|改好了|交稿了|(?:已经|已)完成/i.test(text)) return '';
  return text;
}

function previewInfo(preview) {
  return { sha256: preview.imageHash, width: preview.width, height: preview.height, qr: preview.qr };
}

function modelLayerIndex(snapshot, initial) {
  return {
    ...snapshot,
    layers: snapshot.layers.filter(layer => !initial || layer.id !== 'visual').map(({ id, type, label, x, y, w, h, hidden, style, text }) => ({
      id, type, label, x, y, w, h, hidden, style, text,
    }))
  };
}

export function createDesignerModel(config) {
  const upstream = configureChatProvider(config, 'STUDIO_MODEL_URL', 32000);
  if (!upstream) return null;

  return async function planDesigner({ scene, materials = [], text, project, versionId, draftId, sessionId, language, context, history, initial = false },
    { signal, onTrace, validateDraft, generateImage, takeGuidance, onSpeech } = {}) {
    if (typeof validateDraft !== 'function') throw new Error('The poster renderer is unavailable.');
    const deadline = AbortSignal.timeout(generateImage ? amdDesignerTimeoutMs : 88_000);
    const jobSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const patches = [];
    const elementIds = new Set();
    const work = { scene, preview: await validateDraft(scene), revision: 0 };
    onTrace?.(toolResult('load_skill', { name: canvasDesign.name, source: canvasDesign.source }, { loaded: true }, Date.now()));
    let shownRevision = 0;
    let toolError;
    let imageError;
    let submission;
    let repairSpeech = false;
    let turns = 0;
    let editTurnLimit = maxDesignerEditTurns;
    let turnLimit = maxDesignerTurns;
    let guidancePolledAt = -1;
    let restoreTools = false;
    let guidanceFailed = false;
    let speechIndex = 0;
    let nudged = false;
    let stopReason;
    const calls = new Map();
    const queuedGuidance = [];
    const deliveredGuidance = [];
    const seenGuidance = new Set();
    const spokenProgress = new Set();
    const narratedTurns = new WeakSet();
    const { model, streamFn, historicalReply, getFailure } = createPosterPiTransport(upstream, {
      sessionId, onTrace, temperature: 0.2,
      getPreview() { shownRevision = work.revision; return work.preview; }
    });

    const speechKey = value => value.toLowerCase().replace(/[。！？.!?]+$/u, '');
    function finalSpeech(value) {
      const speech = designerSpeech(value);
      return spokenProgress.has(speechKey(speech)) ? '' : speech;
    }

    async function readGuidance() {
      if (!takeGuidance || jobSignal.aborted || guidancePolledAt === turns || turns > maxGuidedDesignerTurns - 2) return [];
      guidancePolledAt = turns;
      let batch;
      try { batch = await takeGuidance(); guidanceFailed = false; } catch { guidanceFailed = true; return []; }
      if (!Array.isArray(batch)) return [];
      return batch.flatMap(value => {
        const item = guidanceOf(value);
        if (!item) return [];
        const key = item.id ? `id:${item.id}` : JSON.stringify([item.kind, item.text]);
        if (seenGuidance.has(key)) return [];
        seenGuidance.add(key);
        return [item];
      });
    }

    async function getSteeringMessages() {
      const guidance = queuedGuidance.length ? queuedGuidance.splice(0) : await readGuidance();
      if (!guidance.length) return [];
      deliveredGuidance.push(...guidance);
      if (turns) {
        restoreTools = true;
        editTurnLimit = Math.max(editTurnLimit, turns + 1);
        turnLimit = Math.max(turnLimit, turns + 2);
      }
      return guidance.map(item => guidanceMessage(item));
    }

    async function beforeToolCall({ assistantMessage }) {
      if (!onSpeech || speechIndex >= 1 || narratedTurns.has(assistantMessage)) return;
      narratedTurns.add(assistantMessage);
      if (assistantMessage.content.some(part => part.type === 'toolCall' && part.name === 'submit_draft')) return;
      const text = progressLine(textContent(assistantMessage.content));
      if (!text || spokenProgress.has(speechKey(text))) return;
      jobSignal.throwIfAborted();
      try {
        await onSpeech({ text, index: speechIndex });
        speechIndex++;
        spokenProgress.add(speechKey(text));
      } catch { jobSignal.throwIfAborted(); }
    }

    async function execute(name, args) {
      jobSignal.throwIfAborted();
      if (name === 'inspect_poster') return inspectPoster(work.scene, materials);
      if (name === 'preview_draft') return previewInfo(work.preview);
      if (name === imageGeneration.name) {
        try {
          const material = await generateImage(args, jobSignal, { scene: work.scene, preview: work.preview });
          imageError = undefined;
          return material;
        } catch (error) {
          imageError = error;
          throw error;
        }
      }
      if (name === 'submit_draft') {
        if (imageError) throw imageError;
        if (!patches.length || toolError || shownRevision !== work.revision) {
          throw new Error('Render an edit, repair any tool errors and review the updated PNG before delivering it.');
        }
        const reply = finalSpeech(args.speech);
        if (!reply) {
          repairSpeech = true;
          throw new Error(speechRepairNote);
        }
        submission = { label: args.label, reply };
        return { readyToSubmit: true, preview: previewInfo(work.preview) };
      }

      const operations = name === 'run_canvas' ? runCanvasProgram(work.scene, args).patches : [placeMaterial(materials, args, work.scene)];
      const next = operationPreview(work.scene, operations, materials);
      if (!next.diff.length) throw new Error('The requested operations did not change the poster.');
      if (patches.length + next.patches.length > maxDesignerPatches) throw new Error('This assignment exceeded the 30 layer-operation limit.');
      if (initial && next.scene.elements.some(layer => layer.id === 'visual' && !layer.hidden && layer.asset !== 'uploaded')) {
        throw new Error('Keep the visual placeholder hidden and draw new artwork.');
      }
      const preview = await validateDraft(next.scene);
      jobSignal.throwIfAborted();
      Object.assign(work, { scene: next.scene, preview, revision: work.revision + 1 });
      patches.push(...next.patches);
      const changed = next.diff.map(layer => layer.id);
      changed.filter(id => id !== '$canvas').forEach(id => elementIds.add(id));
      return { changed, canvas: canvasDimensions(work.scene), preview: previewInfo(preview) };
    }

    const definitions = generateImage ? [...toolDefinitions, imageGeneration] : toolDefinitions;
    const tools = definitions.map(tool => ({
      ...tool, label: tool.name,
      async execute(_callId, args) {
        const output = await execute(tool.name, args);
        return {
          content: [{ type: 'text', text: JSON.stringify(output) }], details: output,
          ...(tool.name === 'submit_draft' ? { terminate: true } : {}),
        };
      }
    }));

    function observe(event) {
      if (event.type === 'message_end' && event.message.role === 'assistant') stopReason = event.message.stopReason;
      if (event.type === 'tool_execution_start') {
        calls.set(event.toolCallId, { arguments: event.args, startedAt: Date.now() });
      }
      if (event.type !== 'tool_execution_end') return;
      const call = calls.get(event.toolCallId);
      const cutOff = event.isError && stopReason === 'length';
      const output = event.isError ? { error: textContent(event.result.content), ...(cutOff ? { executed: false } : {}) } : event.result.details;
      if (!cutOff && drawingTools.has(event.toolName)) toolError = event.isError ? output.error : undefined;
      onTrace?.(toolResult(event.toolName, { callId: event.toolCallId, arguments: call?.arguments },
        output, call?.startedAt ?? Date.now(), cutOff ? 'not_executed' : event.isError ? 'error' : 'ok'));
      calls.delete(event.toolCallId);
    }

    const jobContext = assignmentContext(context);
    const rolePrompt = [instructions, generateImage && imageInstructions, onSpeech && progressInstructions].filter(Boolean).join('\n');
    const assignment = userMessage(JSON.stringify({
      task: initial && !draftId ? 'Create the first poster' : initial ? 'Revise the existing unpublished first draft' : 'Revise the poster',
      instruction: text, language, project, versionId, draftId, context: jobContext,
      poster: modelLayerIndex(inspectPoster(scene, materials), initial)
    }));
    const previous = [{ role: 'system', content: rolePrompt, timestamp: Date.now() }, ...historyMessages(history, historicalReply)];
    const messages = await runAgentLoop([assignment], { messages: previous, tools }, {
      model, convertToLlm: messages => messages, toolExecution: 'sequential', getSteeringMessages, beforeToolCall,
      prepareNextTurn({ message, context: current }) {
        let nextContext;
        let note;
        if (restoreTools) {
          restoreTools = false;
          repairSpeech = false;
          if (current.tools !== tools) nextContext = { ...current, tools };
        } else if (repairSpeech || (turns >= editTurnLimit && patches.length && !toolError && !imageError && current.tools?.length)) {
          note = repairSpeech ? speechRepairNote : deliveryNote;
          repairSpeech = false;
          nextContext = { ...current, tools: [] };
        }
        if (!note && message.stopReason === 'length') {
          note = (nextContext ?? current).tools?.length
            ? 'The previous reply hit the output limit. Continue from the attached last good PNG. Use exactly one tool call with one small edit now. If the poster is ready, deliver just one plain sentence.'
            : 'The delivery was cut off. Keep it to one plain-text sentence.';
        }
        if (nextContext || note) return { context: nextContext, messages: note ? [userMessage(note)] : [] };
      },
      async finishTurn({ message }) {
        turns += 1;
        if (message.stopReason === 'error' || message.stopReason === 'aborted') return;
        const finished = submission || (message.stopReason === 'stop' && patches.length && !toolError && !imageError && finalSpeech(textContent(message.content)));
        if (finished || turns >= turnLimit) {
          const guidance = await readGuidance();
          if (guidance.length) {
            queuedGuidance.push(...guidance);
            submission = undefined;
            return { action: 'continue' };
          }
          return { action: 'end' };
        }
        if (message.stopReason === 'length') return { action: 'continue' };
        if (message.stopReason === 'stop' && patches.length && !toolError && !imageError && !finalSpeech(textContent(message.content))) {
          repairSpeech = true;
          return { action: 'continue' };
        }
      },
      getFollowUpMessages() {
        if (nudged || submission || imageError || (patches.length && !toolError)) return [];
        nudged = true;
        return [{ role: 'user', content: toolError || 'Use run_canvas to produce a visible edit before delivering the draft.', timestamp: Date.now() }];
      }
    }, observe, jobSignal, streamFn);
    jobSignal.throwIfAborted();
    const failure = getFailure?.();
    if (failure) throw failure;
    if (imageError) throw imageError;
    if (guidanceFailed) throw new Error('The latest design guidance could not be loaded.');
    const final = messages.findLast(message => message.role === 'assistant');
    const reply = submission?.reply ?? (final?.stopReason === 'stop' ? finalSpeech(textContent(final.content)) : '');
    if (!reply && final?.stopReason === 'length') {
      throw Object.assign(new Error('output-limit'), { agentCode: 'output-limit' });
    }
    if (!patches.length || toolError || shownRevision !== work.revision || !reply) {
      throw new Error(toolError || final?.errorMessage || 'The Agent did not deliver a rendered poster and a final spoken reply.');
    }
    const defaultLabel = initial ? (language === 'en' ? 'First draft' : '项目初稿') : (language === 'en' ? 'Edit poster' : '调整海报');
    const instruction = typeof text === 'string' ? text : '';
    const rememberedInstruction = jobContext.sourceMessages?.length ? JSON.stringify({ instruction, sourceMessages: jobContext.sourceMessages }) : instruction;
    return { patches, elementIds: [...elementIds], reply,
      label: submission?.label?.trim().slice(0, 90) || defaultLabel,
      memory: { instruction: rememberedInstruction, reply, guidance: deliveredGuidance, at: Date.now() } };
  };
}
