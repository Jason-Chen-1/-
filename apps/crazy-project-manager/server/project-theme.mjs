import { theme } from './poster.mjs';
import { httpError } from './errors.mjs';

function projectField(value, label, limit) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (Array.from(text).length > limit || /[\x00-\x1f\x7f]/.test(text)) throw httpError(400, `${label}最多 ${limit} 个字。`);
  return text;
}

export function projectTheme(themeId, input) {
  if (themeId && themeId !== theme.id) throw httpError(404, '找不到这个海报模板。');
  if (input === undefined) return theme;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, '请填写项目资料。');
  const title = projectField(input.topic, '项目主题', 26);
  if (!title) throw httpError(400, '请填写项目主题。');
  const brief = projectField(input.brief, '项目简报', 320);
  const organizer = projectField(input.organizer, '主办方', 18);
  const date = projectField(input.date, '时间', 22);
  const venue = projectField(input.venue, '地点', 22);
  const facts = { title, organizer, date, venue, hours: '', gate: '', admission: '', reservation: '', credits: organizer ? `主办 ${organizer}` : '' };
  return {
    ...theme, name: title, custom: true, brief,
    facts, briefVersion: '2.0', rulesVersion: '2.0'
  };
}
