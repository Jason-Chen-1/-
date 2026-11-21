import { Buffer } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';
import { AmdImageError, amdImageMaxReferences, downloadAmdImage, normalizeAmdImageRequest, queryAmdImage, submitAmdImage } from './amd-image.mjs';
import { amdImageModel } from './runtime-config.mjs';
import { verifyPosterPngBytes, verifyUploadPng } from './poster.mjs';

export const amdDesignerTimeoutMs = 185_000;
export const projectMaterialLimit = 30;
const pollIntervalMs = 3000;
const pollTimeoutMs = 110_000;
const failedTask = 'AMD Creative Hub reported that the image generation failed. Retry the assignment to try again.';
const pendingStatuses = new Set(['submitting', 'pending']);
const previousModel = record => record && record.model !== amdImageModel && pendingStatuses.has(record.status);

export function saveProjectMaterial(store, state, { bytes, width, height, name, source, sourceUrl }) {
  const materials = state.materials ??= [];
  if (materials.length >= projectMaterialLimit) throw new Error('This project’s material library is full.');
  const { hash } = store.saveAsset(bytes, 'image/png');
  const existing = materials.find(item => item.hash === hash);
  if (existing) return { material: existing, added: false };
  const material = { id: `mat-${hash.slice(0, 16)}`, name, hash, width, height, source, sourceUrl };
  materials.push(material);
  return { material, added: true };
}

export function imageGenerationContext(job) {
  return (job.imageGenerations ?? []).map(record => {
    const { id, name, mode, aspectRatio, status, materialId } = record;
    return { id, name, mode, aspectRatio, status: previousModel(record) ? 'previous-model' : status, materialId };
  });
}

async function waitForImage(key, taskId, signal) {
  const deadline = AbortSignal.timeout(pollTimeoutMs);
  const pollSignal = AbortSignal.any([signal, deadline]);
  let refreshedDownload = false;
  try {
    for (;;) {
      pollSignal.throwIfAborted();
      let task;
      try {
        task = await queryAmdImage({ key, taskId, signal: pollSignal });
      } catch (error) {
        if (!error.retryable) throw error;
      }
      if (task?.status === 'failed') return null;
      if (task?.status === 'succeeded') {
        try {
          return await downloadAmdImage({ url: task.url, signal: pollSignal });
        } catch (error) {
          if (error.code !== 'expired-download' || refreshedDownload) throw error;
          refreshedDownload = true;
          continue;
        }
      }
      await delay(pollIntervalMs, undefined, { signal: pollSignal });
    }
  } catch (error) {
    if (deadline.aborted && !signal.aborted) {
      throw new Error('AMD Creative Hub is still processing the image. Retry the assignment to check the same task.');
    }
    throw error;
  }
}

function imageName(value, id) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120) || id : id;
}

function changeStatus(record, values, emit) {
  Object.assign(record, values);
  emit('image-generation-updated', { id: record.id, name: record.name, status: record.status, materialId: record.materialId });
}

function referenceHash(reference, store, state, artwork) {
  if (reference?.source === 'material') {
    const hash = state.materials?.find(item => item.id === reference.id)?.hash;
    if (!hash) throw new Error('Select a reference from this project’s material library.');
    return hash;
  }
  if (reference?.source === 'layer') {
    const image = artwork?.scene?.elements.find(layer => layer.id === reference.id)?.image;
    const hash = typeof image === 'string' && /^studio-asset:([a-f0-9]{64})$/.exec(image)?.[1];
    if (hash) return hash;
    if (typeof image === 'string' && image.startsWith('data:image/png;')) {
      return store.saveAsset(verifyUploadPng(image).bytes, 'image/png').hash;
    }
    throw new Error('Select an existing bitmap layer as the reference.');
  }
  if (reference?.source === 'poster' && artwork?.preview?.imageDataUrl) {
    return store.saveAsset(verifyUploadPng(artwork.preview.imageDataUrl).bytes, 'image/png').hash;
  }
  throw new Error('Image references must be project materials, bitmap layers or the current poster preview.');
}

function imageOperation(args, previous, store, state, artwork) {
  const { references } = args;
  if (references !== undefined && !Array.isArray(references)) throw new AmdImageError('invalid-input');
  const priorHashes = args.mode === 'generate' ? [] : previous?.referenceHashes ?? [];
  const count = references?.length ?? priorHashes.length;
  const mode = args.mode ?? (count ? 'edit' : 'generate');
  if (!['generate', 'edit'].includes(mode) || count > amdImageMaxReferences || (mode === 'edit') !== (count > 0)) {
    throw new Error('Use text-only generation or edit with one to three project references.');
  }
  const referenceHashes = references?.map(reference => referenceHash(reference, store, state, artwork)) ?? priorHashes;
  return { mode, referenceHashes };
}

async function readReferences(store, hashes) {
  const images = [];
  for (const hash of hashes ?? []) {
    const bytes = await store.readAsset(hash, { verify: true });
    if (!bytes || store.asset(hash)?.mime !== 'image/png') throw new Error('An AMD reference picture could not be read from this project.');
    images.push(`data:image/png;base64,${Buffer.from(bytes).toString('base64')}`);
  }
  return images;
}

export function createDesignerImageGenerator({ key, mutate, store }) {
  return async function generateImage(args, signal, artwork) {
    const { id } = args ?? {};
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(id)) throw new Error('Provide a lowercase artwork id, such as fox-background.');
    signal.throwIfAborted();
    const entry = await mutate((job, state, emit) => {
      const records = job.imageGenerations ??= [];
      const previous = records.find(record => record.id === id);
      if (previous?.status === 'ready') {
        const material = state.materials?.find(item => item.id === previous.materialId);
        if (!material) throw new Error('The generated material is missing from this project.');
        return { material };
      }
      if (previousModel(previous)) throw new Error('This artwork ID belongs to a previous AMD model. Use a new ID for a Qwen-Image 2.1 Turbo task.');
      if (previous?.status === 'pending') return { ...previous };
      // A timeout after POST may still have created a paid task.
      if (records.some(record => record.model === amdImageModel && record.status === 'submitting')) throw new AmdImageError('unconfirmed-submission');
      if (previous?.status === 'failed' && previous.attempt === job.attempts) throw new Error(previous.error);
      if ((state.materials?.length ?? 0) >= projectMaterialLimit) throw new Error('This project’s material library is full.');
      const { prompt, aspectRatio } = normalizeAmdImageRequest({
        prompt: args.prompt ?? previous?.prompt,
        aspectRatio: args.aspectRatio ?? previous?.aspectRatio,
      });
      const operation = imageOperation(args, previous, store, state, artwork);
      const record = previous ?? { id };
      if (!previous) records.push(record);
      changeStatus(record, { model: amdImageModel, ...operation, prompt, aspectRatio, name: imageName(args.name ?? previous?.name, id), attempt: job.attempts,
        status: 'submitting', submissionId: crypto.randomUUID(), taskId: undefined, error: undefined }, emit);
      return { ...record };
    });
    if (entry.material) return entry.material;
    let { taskId } = entry;
    if (!taskId) {
      const settle = values => mutate((job, _state, emit) => {
        const record = job.imageGenerations?.find(item => item.id === id && item.submissionId === entry.submissionId);
        if (record?.status === 'submitting') changeStatus(record, values, emit);
      }, { matchClaim: false });
      let referenceImages;
      try {
        referenceImages = await readReferences(store, entry.referenceHashes);
      } catch (error) {
        await settle({ status: 'failed', error: error.message });
        throw error;
      }
      try {
        taskId = await submitAmdImage({ key, prompt: entry.prompt, aspectRatio: entry.aspectRatio, referenceImages, signal });
      } catch (error) {
        if (error.code && error.code !== 'unconfirmed-submission') await settle({ status: 'failed', error: error.message });
        throw error;
      }
      await settle({ status: 'pending', taskId });
    }
    const bitmap = await waitForImage(key, taskId, signal);
    if (!bitmap) {
      await mutate((job, _state, emit) => {
        const record = job.imageGenerations.find(item => item.id === id);
        changeStatus(record, { status: 'failed', error: failedTask }, emit);
      });
      throw new Error(failedTask);
    }
    const image = verifyPosterPngBytes(Buffer.from(bitmap.bytes));
    signal.throwIfAborted();
    return mutate((job, state, emit) => {
      const record = job.imageGenerations.find(item => item.id === id);
      const { material, added } = saveProjectMaterial(store, state, { ...image, name: record.name, source: 'amd' });
      changeStatus(record, { status: 'ready', materialId: material.id, prompt: undefined, referenceHashes: undefined,
        submissionId: undefined, taskId: undefined }, emit);
      if (added) emit('material-imported', { material });
      return material;
    });
  };
}
