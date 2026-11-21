import { projectDialogueLine, projectRequirement, roleLanguage } from './role-language.mjs';
import { localizeIssues, localizeJob, localizeVersion } from './review-language.mjs';

export function localizeSession(state, requested = state?.language) {
  if (!state) return state;
  const language = roleLanguage(requested ?? state.language);
  const storedLanguage = roleLanguage(state.language);
  return {
    ...state,
    language: storedLanguage,
    messages: state.messages.map(message => projectDialogueLine(message, language)),
    lastDialogue: (state.lastDialogue ?? []).map(message => projectDialogueLine(message, language)),
    requirements: (state.requirements ?? []).map(item => projectRequirement(item, language)),
    versions: state.versions.map(version => localizeVersion(version, language)),
    draft: localizeVersion(state.draft, language),
    job: localizeJob(state.job, language),
    issues: localizeIssues(state.issues, language)
  };
}

export function localizeEvent(event, language) {
  const data = event.data;
  switch (event.type) {
    case 'message': return { ...event, data: { ...data, message: projectDialogueLine(data.message, language) } };
    case 'dialogue': return { ...event, data: { ...data, turns: (data.turns ?? []).map(turn => projectDialogueLine(turn, language)) } };
    case 'version': return { ...event, data: { ...data, version: localizeVersion(data.version, language) } };
    case 'draft-updated': return { ...event, data: { ...data, draft: localizeVersion(data.draft, language) } };
    case 'slap': return { ...event, data: { ...data, reply: projectDialogueLine({ role: 'yi', text: data.reply }, language)?.text } };
    case 'qr-checked': return data.review ? { ...event, data: { ...data, review: localizeVersion({ review: data.review }, language).review } } : event;
    default: return event;
  }
}

export function localizeReplaySubtitles(records, events) {
  const lines = new Map(events.filter(event => event.type === 'message').map(event => [event.data.message.id, event.data.message]));
  return records.map(record => {
    if (record.type !== 'subtitle.presented' && record.type !== 'subtitle-start') return record;
    const line = lines.get(record.data?.messageId);
    return line ? { ...record, data: { ...record.data, text: line.text } } : record;
  });
}

export function localizedResponse(response, requested) {
  const language = roleLanguage(requested ?? response.state?.language);
  return {
    ...response,
    state: localizeSession(response.state, language),
    events: response.events?.map(event => localizeEvent(event, language))
  };
}
