import { applyPatch, createScene, getElement, projectTitle } from './poster.mjs';
import { defaultPaperFormat } from './poster-paper.mjs';

export function createInitialPoster(project, { reservationUrl } = {}) {
  const scene = createScene({ reservationUrl, project });
  const facts = project.facts;
  const get = id => getElement(scene, id);
  Object.assign(get('palette'), { label: '画布背景', preset: 'mono-light', decorations: 'none' });
  Object.assign(get('title'), { label: '项目标题', ...projectTitle(facts.title) });
  Object.assign(get('visual'), { label: '主视觉位置', hidden: true });
  Object.assign(get('tagline'), { text: '', hidden: true });
  get('logo').hidden = true;
  get('qr').hidden = true;
  Object.assign(get('info'), {
    date: facts.date ?? '', hours: facts.hours ?? '', venue: facts.venue ?? '', gate: facts.gate ?? '',
    hidden: ![facts.date, facts.hours, facts.venue, facts.gate].some(Boolean)
  });
  Object.assign(get('credits'), { text: facts.credits ?? '', hidden: !facts.credits });
  Object.assign(get('sticker'), { text: [facts.admission, facts.reservation].filter(Boolean).join(' · '), hidden: true });
  return applyPatch(scene, [{ op: 'resize', preset: defaultPaperFormat }]).scene;
}
