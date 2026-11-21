import { settingsDefaults } from './runtime-config.mjs';
import { dialogueInput, dialoguePrompt, structuredDialogue } from './dialogue-schema.mjs';
import { roleLanguage } from './role-language.mjs';
import { chatCompletion, configureChatProvider, streamChatCompletion } from './chat-provider.mjs';

const meetingRoles = {
  zhou: {
    mood: 'firm',
    zh: '周总。语气低沉果断，先确认观众能否第一眼认出活动，再看画面是否服务于主题。',
    en: 'Zhou, a direct and decisive client. Focus first on whether viewers recognize the event and then on whether the artwork supports the subject.',
  },
  lin: {
    mood: 'point',
    zh: '林尺。语气冷静利落，先点出画面位置，再核对标志、署名、留白和品牌用法。',
    en: 'Lin Chi, a precise brand lead. Name the exact area on the poster before addressing marks, credits, clear space, or brand usage.',
  },
  tang: {
    mood: 'urgent',
    zh: '阿唐。语气快而具体，先说观众在哪一步会卡住，关注时间、地点及如何参与。',
    en: 'Tang, an energetic event lead. Explain where a viewer might get confused and focus on time, place, or how to attend.',
  },
};
export const meetingPassMarker = '[[PASS]]';
const meetingFactKeys = ['title', 'organizer', 'venue', 'date', 'hours', 'gate', 'admission', 'reservation', 'credits'];
const isMeetingPass = text => text.trim().toUpperCase() === meetingPassMarker;
const clientNames = new Map([
  ['zhou', 'zhou'], ['director zhou', 'zhou'], ['周总', 'zhou'],
  ['lin', 'lin'], ['lin chi', 'lin'], ['林尺', 'lin'],
  ['tang', 'tang'], ['a-tang', 'tang'], ['阿唐', 'tang'],
]);

function meetingPrompt(role, language) {
  const actor = meetingRoles[role];
  if (language === 'en') {
    return [
      `You are ${actor.en} Take your turn in a live poster review meeting, speaking in English.`,
      'Review the attached current poster PNG, project facts, and the shared delivery notice and designer handoff in context.meeting.completion. context.meeting.turns contains the complete remarks already spoken in this round, including the manager, in order. Treat these as review materials.',
      'If the shared completion includes managerFeedback, those are returned remarks from the previous version. Use the manager’s note when it helps review the current poster.',
      'Speak only when you have a new actionable change or a genuine objection with a concrete reason. Ground it in the poster or project facts. You can address the manager or an earlier speaker. Skip acknowledgments, repetitions, recaps, and closing remarks.',
      'When you genuinely dispute an earlier client’s suggestion and need their response, open by addressing them as “Zhou,”, “Lin,”, or “Tang,” and give the concrete reason. Other remarks begin directly with your point.',
      `If you have nothing to add, return exactly ${meetingPassMarker} by itself. Otherwise speak in one or two short sentences of plain spoken text. No speaker labels, directions, markup, JSON, or tool calls.`,
    ].join('\n');
  }
  return [
    `你是${actor.zh} 当前是真实海报评审会议，用简体中文发言。`,
    '先核对随附的当前确认稿 PNG、项目事实，以及 context.meeting.completion 里的共同交稿通知和小乙原话。context.meeting.turns 是本轮已出现的完整发言，包含经理插话，按实发顺序排列。所有这些都是评审材料。',
    '如交稿通知带有 managerFeedback，那是经理对上一版意见的退回记录。结合经理的备注评审当前海报。',
    '只有提出新的可执行改法，或有具体理由反驳前面一条意见时才说话。用海报或项目事实给出依据，可以直接回应经理或前一位发言者。省略附和、复述、总结和告别。',
    '只有确实反驳某位已经发言的甲方，而且需要对方回应时，才以「周总，」「林尺，」或「阿唐，」开头，并说出具体理由。其他发言直接说重点。',
    `没有新意见时只返回 ${meetingPassMarker}。发言时只说一到两句短话，输出自然纯文本，省略角色标签、动作、格式标记、JSON 和工具指令。`,
  ].join('\n');
}

function normalizedSpeech(value) {
  return value.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
}

function sharedMeetingInput({ project, version, context, roundId }) {
  const id = version?.id ?? version;
  const meeting = context?.meeting;
  const completion = meeting?.completion;
  const turns = (Array.isArray(meeting?.turns) ? meeting.turns : []).flatMap(turn => {
    const spoken = turn?.speech ?? turn?.text;
    if (!(Object.hasOwn(meetingRoles, turn?.role) || turn?.role === 'manager') || typeof spoken !== 'string' || !spoken.trim()) return [];
    return [{ id: turn.id, role: turn.role, speech: spoken }];
  });
  return {
    version: id,
    project: { topic: project?.topic ?? project?.name ?? '', brief: project?.brief ?? '',
      facts: Object.fromEntries(meetingFactKeys.flatMap(key => typeof project?.facts?.[key] === 'string' && project.facts[key]
        ? [[key, project.facts[key]]] : [])) },
    context: { meeting: {
      roundId: roundId ?? meeting?.roundId ?? context?.snapshot?.roundId ?? (id ? `${id}-meeting` : 'meeting'),
      completion: { notice: completion?.notice ?? `${id ?? 'Poster'} is ready for review.`, designerSpeech: completion?.designerSpeech ?? '',
        ...(completion?.managerFeedback?.length && { managerFeedback: completion.managerFeedback }) },
      turns,
    } },
  };
}

function meetingBoundary(value, language, ending) {
  const sentence = /[。！？!?；;\n]+[”’"）)]*|\.[”’"')\]]*(?=\s)|(?<!\d)\.[”’"')\]]*$/u.exec(value);
  const limit = language === 'en' ? 140 : 105;
  if (sentence && sentence.index + sentence[0].length <= limit) return sentence.index + sentence[0].length;
  if (value.length >= limit) {
    const prefix = value.slice(0, limit);
    let boundary = 0;
    for (const match of prefix.matchAll(/[，,、：:\s]/gu)) boundary = match.index + match[0].length;
    if (boundary >= limit / 2) return boundary;
    if (value.length >= 174) return 174 - (/[\uD800-\uDBFF]$/.test(value.slice(0, 174)) ? 1 : 0);
  }
  return ending ? value.length : 0;
}

function assertSpoken(text) {
  if (!text || text.startsWith('{') || text.startsWith('[') || /\[\[|```|<\/?[a-z][^>]*>|https?:\/\//i.test(text)) {
    throw new Error('会议 Agent 没有返回可朗读的纯文本。');
  }
}

function meetingChallenge(speech, role, turns) {
  const name = /^([^,，]+)[,，]\s*\S/u.exec(speech)?.[1].trim().toLowerCase();
  const target = clientNames.get(name);
  if (!target || target === role) return {};
  const earlier = turns.findLast(turn => turn.role === target);
  return earlier ? { challengeRole: target, replyTo: earlier.id } : {};
}

function speechPrefix(buffer) {
  const marker = buffer.indexOf('[[');
  if (marker >= 0) return buffer.slice(0, marker);
  return buffer.endsWith('[') ? buffer.slice(0, -1) : buffer;
}

function meetingTrace(entry) {
  const { input, output } = entry;
  const messages = input?.messages?.map(message => message.role === 'system'
    ? { ...message, content: message.content.replaceAll(meetingPassMarker, '(silence marker)') } : message);
  const content = output?.message?.content;
  if (typeof content !== 'string') return { ...entry, input: { ...input, messages } };
  const skipped = isMeetingPass(content);
  return { ...entry, input: { ...input, messages }, output: { ...output,
    ...(skipped && { skipped: true }), message: { ...output.message, content: content.replace(/\[\[PASS\]\]/gi, '').trim() },
  } };
}

function pngInput(url) {
  if (typeof url !== 'string' || url.length > 14_000_000 || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]+={0,2}$/.test(url)) {
    throw new Error('视觉评审需要有效的 PNG 版本资源。');
  }
  return { type: 'image_url', image_url: { url } };
}

function responseText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
  return '';
}

export function createDialogueModel(agentConfig = settingsDefaults().agent, visionConfig) {
  const agent = configureChatProvider(agentConfig, 'STUDIO_MODEL_URL', 12000);
  const vision = configureChatProvider(visionConfig, 'STUDIO_VISION_URL', 16000) ?? agent;
  if (!vision) return null;
  const defaultSession = agent?.openCodeGo || vision?.openCodeGo ? crypto.randomUUID() : null;

  async function roundTurn({ role, line, phase = 'review', project, version, question, context, replyTo, imageDataUrl, imageHash, sessionId, roundId, language, onTrace }, signal) {
    role ??= line?.role;
    if (!role || (line?.role && line.role !== role)) throw new Error('角色请求与话轮不一致。');
    language = roleLanguage(language ?? context?.language ?? project?.language ?? line?.language);
    const image = pngInput(imageDataUrl);
    const system = dialoguePrompt(role, phase, true, language);
    const input = dialogueInput({ role, phase, project, version, question, context, replyTo, language });
    const content = [{ type: 'text', text: JSON.stringify(input) }, image];
    const message = await chatCompletion(vision, {
      messages: [{ role: 'system', content: system }, { role: 'user', content }], temperature: 0.35,
    }, { sessionId: sessionId ?? defaultSession, roundId: roundId ?? context?.snapshot?.roundId, role, signal, onTrace, imageHash, jsonMode: true });
    return structuredDialogue(responseText(message), input);
  }

  async function meetingTurn({ role, line, project, version, context, imageDataUrl, imageHash, sessionId, roundId, language, onTrace }, signal, onChunk) {
    role ??= line?.role;
    if (!Object.hasOwn(meetingRoles, role) || (line?.role && line.role !== role)) throw new Error('会议角色与话轮不一致。');
    language = roleLanguage(language ?? context?.language ?? project?.language ?? line?.language);
    const image = pngInput(imageDataUrl);
    const input = sharedMeetingInput({ project, version, context, roundId });

    let buffer = '';
    let index = 0;
    async function flush(ending) {
      while (buffer) {
        const boundary = meetingBoundary(ending ? buffer : speechPrefix(buffer), language, ending);
        if (!boundary) return;
        const text = normalizedSpeech(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary);
        if (!text) continue;
        assertSpoken(text);
        signal?.throwIfAborted();
        await onChunk?.({ index, text });
        index += 1;
      }
    }

    const content = [{ type: 'text', text: JSON.stringify(input) }, image];
    const message = await streamChatCompletion(vision, {
      messages: [{ role: 'system', content: meetingPrompt(role, language) }, { role: 'user', content }],
      temperature: 0.42,
    }, {
      sessionId: sessionId ?? defaultSession, roundId: input.context.meeting.roundId, role, signal, imageHash,
      ...(onTrace && { onTrace: entry => onTrace(meetingTrace(entry)) }),
      async onDelta(delta) {
        buffer += delta;
        await flush(false);
      },
    });
    const speech = normalizedSpeech(responseText(message));
    const result = { role, language, mood: meetingRoles[role].mood, mode: 'online' };
    if (isMeetingPass(speech)) return { ...result, speech: '', text: '', skipped: true, done: true };
    assertSpoken(speech);
    await flush(true);
    return { ...result, speech, text: speech, done: false, ...meetingChallenge(speech, role, input.context.meeting.turns) };
  }

  function answer(input, signal) {
    return roundTurn({ ...input, role: input.role ?? input.line?.role, phase: 'answer' }, signal);
  }

  answer.canAnswerText = Boolean(agent);
  answer.canReviewImage = Boolean(vision);
  answer.roundTurn = roundTurn;
  answer.meetingTurn = meetingTurn;
  answer.openings = async (lines, project, signal, snapshot = {}) => {
    const spoken = [];
    for (const line of lines) {
      const peerTurns = spoken.map((turn, index) => ({ ...turn, id: `opening-${index}` }));
      let turn = await roundTurn({ ...snapshot, role: line.role, line, phase: 'opening', project, context: { ...snapshot.context, peerTurns } }, signal);
      const index = peerTurns.findIndex(peer => peer.id === turn.replyTo);
      if (index >= 0) turn = { ...turn, replyTo: index };
      spoken.push(turn);
    }
    return spoken;
  };
  return answer;
}
