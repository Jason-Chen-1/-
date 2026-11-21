import { applyPatch, createScene, getElement, initialScene, intersection } from './poster.mjs';
import { planEdit } from './poster-edit.mjs';
import { reviewScene, reviewers } from './poster-review.mjs';
import { bilingualDialogueLine, englishReview, englishRoles, englishTarget, projectDialogueLine } from './role-language.mjs';

const opening = {
  zhou: { text: '高级一点。', mood: 'firm' },
  lin: { text: '按联名那份规范走。', mood: 'sharp' },
  tang: { text: '几个卖点都得突出！', mood: 'urgent' },
};

const names = { zhou: '周总', lin: '林尺', tang: '阿唐' };

function line(role, text, mood, elementIds, rest = {}) {
  return { role, text, mood, elementIds, ...rest };
}

function requirement(role, stage, elementIds, goal = '', instruction = '', condition = '', concession = '') {
  return { id: `${role}-main`, stage, elementIds, goal, instruction, condition, concession };
}

function demand(role, stage, { text, mood, elementIds, goal, instruction, condition, concession }) {
  return line(role, text, mood, elementIds, { requirement: requirement(role, stage, elementIds, goal, instruction, condition, concession) });
}

const parallelNeeds = {
  museum: {
    zhou: [['title-focus', ['title'], '优先读到展名', '把展名放大一点。', '用手机预览确认完整展名。'], ['tagline-space', ['tagline'], '给主题留白', '把宣传语缩小一点。', '宣传语的字号低于展名。']],
    lin: [['logo-space', ['logo'], '馆标完整可辨', '把授权白标移到左下角。', '保留授权白标比例和净空。'], ['credit-scale', ['credits'], '署名可辨', '把联合主办署名放大一点。', '署名全称和顺序保持不变。']],
    tang: [['reserve-visible', ['sticker'], '参与条件醒目', '把免费 · 须预约做成标题旁的大黄贴。', '手机预览同时读到免费与须预约。'], ['entry-legible', ['info'], '东门入场好找', '把底部活动信息放大一点。', '用简报核对地点与东门。']],
  },
  custom: {
    zhou: [['title-position', ['title'], '让标题有独立位置', '把主标题移到左上角，别动主视觉。', '完整标题留在画布内。'], ['tagline-space', ['tagline'], '先读活动名', '把宣传语缩小一点。', '副信息给项目标题让出层次。']],
    lin: [['organizer-space', ['logo'], '给主办方标志留白', '把主办方标志移到左下角。', '标志和周围内容保持净空。'], ['credit-scale', ['credits'], '正式署名可读', '把主办方署名字号调到 16。', '全称与简报一致。']],
    tang: [['info-facts', ['info'], '时间地点与简报一致', '按简报整理底部活动信息。', '用本项目确认过的时间和地点。'], ['tagline-space', ['tagline'], '让观众优先找到活动安排', '把宣传语缩小一点。', '底部时间地点更醒目。']],
  },
};

function withNeeds(response, project) {
  const profile = parallelNeeds[project ? 'custom' : 'museum'][response.role];
  const items = response.requirement ? [response.requirement] : [];
  for (const [suffix, elements, goal, instruction, condition] of profile ?? []) {
    if (items.some(item => item.instruction === instruction)) continue;
    items.push({ ...requirement(response.role, 'criterion', elements, goal, instruction, condition), id: `${response.role}-${suffix}`, text: instruction });
  }
  return { ...response, requirements: items };
}

const themed = {
  zhou: {
    goal: { text: '标题先给我立起来。观众得一眼看懂，这张海报在说什么！', mood: 'firm', elementIds: ['title'], goal: '项目标题第一眼可读', instruction: '把主标题放大一点。' },
    criterion: { text: '先看标题。缩到手机大小，字和字也别挤成一团。', mood: 'angry', elementIds: ['title'], goal: '手机上标题清晰', instruction: '把主标题加粗。', condition: '完整标题可读，文字留在画布内。' },
    concession: { text: '主图你可以试别的，给标题留块干净地方。', mood: 'firm', elementIds: ['title', 'visual'], goal: '标题和主图的层次分开', instruction: '把主标题移到左上角，别动主视觉。' }
  },
  lin: {
    goal: { text: '注意右上角！给主办方留署名和净空，别把元素堆成一团。', mood: 'sharp', elementIds: ['logo', 'credits'], goal: '署名清楚，周围留白', instruction: '把主办方署名放大一点。' },
    criterion: { text: '署名按简报里确认的全称。标志的四边都留出净空。', mood: 'point', elementIds: ['logo', 'credits'], goal: '主办方全称和标志可辨认', instruction: '主办方署名按简报补齐，字号 16。', condition: '用项目已确认的全称，尺寸适合手机预览。' },
    concession: { text: '位置可以挪。只要署名完整，边缘留一点呼吸。', mood: 'point', elementIds: ['credits'], goal: '署名不拥挤', instruction: '把主办方署名移到左下角。' }
  },
  tang: {
    goal: { text: '时间、地点！人真要照这张海报去现场，这两样给我做大！', mood: 'urgent', elementIds: ['info'], goal: '活动时间和地点容易找到', instruction: '把底部活动信息放大一点。' },
    criterion: { text: '活动信息都放底部一块。时间和地点要按你简报里写的。', mood: 'excited', elementIds: ['info'], goal: '信息完整且容易找到', instruction: '按简报整理底部活动信息。', condition: '活动信息已确认时，在手机上同时读到时间和地点。' },
    concession: { text: '我可以让宣传语小一点，但时间地点得看得清！', mood: 'urgent', elementIds: ['info', 'tagline'], goal: '时间地点比宣传语醒目', instruction: '把底部活动信息字号调到 22，宣传语缩小。' }
  }
};

function overlapsNeed(scene, staged, changedId, protectedId) {
  if (changedId === protectedId) return null;
  const before = scene.elements.find(layer => layer.id === changedId);
  const changed = staged.elements.find(layer => layer.id === changedId);
  const protectedLayer = staged.elements.find(layer => layer.id === protectedId);
  if (!changed || !protectedLayer || changed.hidden || protectedLayer.hidden) return null;
  const area = intersection(changed, protectedLayer);
  const priorArea = before ? intersection(before, protectedLayer) : 0;
  const size = Math.min(changed.w * changed.h, protectedLayer.w * protectedLayer.h);
  return area > Math.max(30, size * .12) && area > priorArea + 25 ? { changed, protectedLayer } : null;
}

function conflictFrom(turns, index, scene) {
  const own = turns[index];
  const protectedIds = [...new Set(own.requirements.flatMap(item => item.elementIds ?? []))];
  for (let previous = index - 1; previous >= 0; previous--) {
    const peer = turns[previous];
    for (const need of peer.requirements) {
      if (!need.instruction) continue;
      try {
        const proposal = planEdit(need.instruction, scene);
        if (!proposal.patches) continue;
        const staged = applyPatch(scene, proposal.patches);
        for (const { id } of staged.diff) for (const protectedId of protectedIds) {
          const conflict = overlapsNeed(scene, staged.scene, id, protectedId);
          if (conflict) return { ...conflict, previous, peer, need };
        }
      } catch {
        // A proposal that cannot be staged does not establish a concrete overlap.
      }
    }
  }
  return null;
}

function connectCustomTurns(turns, scene) {
  if (!scene) return turns;
  return turns.map((turn, index) => {
    const conflict = conflictFrom(turns, index, scene);
    if (!conflict) return turn;
    const { changed, protectedLayer, previous, peer, need } = conflict;
    const elementIds = [changed.id, protectedLayer.id];
    const goal = `给「${protectedLayer.label}」留出独立空间`;
    const condition = `「${changed.label}」与「${protectedLayer.label}」互不遮挡。`;
    const englishGoal = `Leave clear space for ${englishTarget([protectedLayer.id])}.`;
    const englishCondition = `Keep ${englishTarget([changed.id])} clear of ${englishTarget([protectedLayer.id])}.`;
    const opposition = {
      ...requirement(turn.role, 'criterion', elementIds, goal, '', condition),
      id: `${turn.role}-spacing-${protectedLayer.id}`, text: goal,
      conflictsWith: { turnIndex: previous, requirementId: need.id },
      translations: { en: { text: englishGoal, goal: englishGoal, condition: englishCondition } },
    };
    const english = `${englishRoles[peer.role]}, your change to ${englishTarget([changed.id])} would crowd ${englishTarget([protectedLayer.id])}. ${projectDialogueLine(turn, 'en').text}`;
    return {
      ...turn, replyTo: previous,
      text: `${names[peer.role]}，照你给「${changed.label}」的改法会挤到「${protectedLayer.label}」。${turn.text}`,
      translations: { ...turn.translations, en: { ...turn.translations?.en, text: english } },
      elementIds: [...new Set([...turn.elementIds, ...elementIds])],
      requirements: [turn.requirements[0], opposition, ...turn.requirements.slice(1)].filter(Boolean).slice(0, 3),
    };
  });
}

export function openingLines(project, language, scene) {
  const custom = project?.custom;
  const turns = reviewers.map(role => {
    const seed = project?.custom ? demand(role, 'goal', themed[role].goal) : demand(role, 'vague', { ...opening[role], elementIds: [] });
    return withNeeds(seed, custom ? project : null);
  });
  const draft = custom && (scene ?? (project.facts?.title ? createScene({ project }) : null));
  return connectCustomTurns(turns, draft).map(turn => bilingualDialogueLine(turn, language));
}

const typed = {
  zhou: {
    goal: {
      text: '展名。我想让观众第一眼就记住展名。', mood: 'firm', elementIds: ['title'],
      goal: '让观众第一眼读到并记住展名', instruction: '把展名放大一点。',
    },
    criterion: {
      text: '缩到手机大小，第一眼得先读完展名。黄贴挪到底部，重新看一眼。', mood: 'firm', elementIds: ['title', 'sticker'],
      goal: '展名先被看到', instruction: '把黄贴移到预约码旁边。', condition: '以 300 像素宽的手机预览核对，完整展名先于预约贴被看见。',
    },
    concession: {
      text: '底下可以留黄贴。先读展名，往下一眼知道怎么约。这个顺序对了，我签。', mood: 'firm', elementIds: ['title', 'sticker', 'qr'],
      goal: '展名优先，其次才看到参与条件', instruction: '把黄贴移到预约码旁边，保留展名。', condition: '以 300 像素宽的手机预览核对主次。', concession: '底部可保留高对比黄贴，宣传语可删。',
    },
  },
  lin: {
    goal: {
      text: '看右上角。谁给的文件都先别用，我要这场授权的白标。', mood: 'point', elementIds: ['logo'],
      goal: '使用本场的授权白标', instruction: '馆标换成本场授权白标。',
    },
    criterion: {
      text: '本场用授权白标。右上角，原比例。旁边让出十像素，署名照着简报写全。', mood: 'sharp', elementIds: ['logo', 'credits'],
      goal: '馆标用对且完整可辨', instruction: '馆标换成本场授权白标，署名按简报补齐。', condition: '保留授权素材原比例、至少 10 像素净空和完整主办／联合主办署名。',
    },
    concession: {
      text: '白标可以去左下。要移就完整地移。联合主办那一行，别删字。', mood: 'point', elementIds: ['logo', 'credits'],
      goal: '馆标和合作方署名完整', instruction: '把授权白标移到左下角，别动署名。', condition: '保留授权素材原比例、净空及合作方全称。', concession: '右上或左下都可，允许使用已授权的反白标志。',
    },
  },
  tang: {
    goal: {
      text: '免费、须预约。这两件事得放一起！到了才知道要约，人就白跑了。', mood: 'urgent', elementIds: ['sticker', 'info'],
      goal: '让观众一眼找到免费和须预约', instruction: '把免费和须预约放在一起，标得醒目。',
    },
    criterion: {
      text: '我手机上得先找得到免费和须预约。先做张标题旁的大黄贴给我看！', mood: 'excited', elementIds: ['sticker', 'title'],
      goal: '让参与条件在手机上读得清', instruction: '把免费 · 须预约做成标题旁的大黄贴。', condition: '在 300 像素宽的手机预览上清楚读出两项条件，实际预约码要能打开。',
    },
    concession: {
      text: '你放预约码旁边也行，字要看得清，东门也得看得见。', mood: 'urgent', elementIds: ['sticker', 'qr', 'info'],
      goal: '找得到预约条件，也能从东门进', instruction: '把黄贴移到预约码旁边，别动馆标。', condition: '手机预览可读，当前稿的二维码可以打开预约页。', concession: '允许放底部预约区，嘉宾介绍可放详情页。',
    },
  },
};

export const suggestedQuestions = Object.freeze({
  zhou: ['高级具体指哪里？', '缩成手机大小先看见什么？', '黄贴放底部可以吗？'],
  lin: ['联名规范具体是哪条？', '用哪份馆标，放在哪？', '馆标可以移到左下吗？'],
  tang: ['几个卖点先突出哪个？', '免费和须预约放在哪儿？', '预约码旁边可以吗？'],
});

function advance(reveal) {
  if (reveal === 'goal' || reveal === 1) return 'criterion';
  if (['criterion', 'concession', 2, 3].includes(reveal)) return 'concession';
  return 'goal';
}

const welcomes = {
  zhou: ['在。先说，观众要记住哪一件事？', 'firm', ['title']],
  lin: ['我在。要核对馆标还是联合主办署名？', 'point', ['logo', 'credits']],
  tang: ['在！你想核对时间、预约还是入口？', 'urgent', ['info', 'qr']],
};

function explain(role, text, scene, knownReview) {
  if (!/(?:分数|多少分|扣分|减分|为什么不满意|哪儿挡|哪里挡|为什么扣|哪儿遮挡|哪里遮挡|\bscore\b|\bpoints?\b|\bwhy\b.*\b(?:deduct|unhappy|cover|block)\w*)/i.test(text)) return null;
  const result = (knownReview ?? reviewScene(scene))[role];
  const concern = result.items.filter(item => item.level !== 1 && item.state !== 'notApplicable').sort((left, right) => (right.weight - (right.earned ?? 0)) - (left.weight - (left.earned ?? 0)))[0];
  if (!concern) return line(role, role === 'zhou' ? '展名在第一眼，看得清。这个排法可以。' : role === 'lin' ? '按这版的标和署名看，得分项已经齐了。' : '条件和入口这版都能核对。', opening[role].mood, typed[role].criterion.elementIds);
  const delta = Number.isFinite(result.score) ? `这版 ${result.score} 分。` : '';
  const score = Number.isFinite(result.score) ? `This version gets ${result.score} points. ` : '';
  return line(role, `${delta}${concern.reason}`, opening[role].mood, concern.elementIds, { translations: { en: { text: score + englishReview(concern) } } });
}

function fitCriterion(role, selected, scene) {
  if (role === 'lin') {
    const logo = getElement(scene, 'logo');
    const usage = reviewScene(scene).lin.items[0];
    if (usage.evidence.overlapPx > 0 && usage.elementIds.includes('sticker')) {
      return {
        ...selected,
        text: '白标被黄贴压住了。把黄贴挪开，馆标原比例。周围留出十像素。',
        instruction: '把黄贴移到预约码旁边，别动馆标。',
        elementIds: ['logo', 'sticker', 'credits'],
      };
    }
    if (logo.x < 100) return { ...selected, text: '左下这块白标可以。原比例，周围留十像素，联合主办署名照着简报写全。' };
  }
  return selected;
}

function localAnswer(role, text, { messages = [], scene = initialScene, reveal, review } = {}) {
  const lastLine = messages.findLast(message => message.role === role && message.requirement?.id === `${role}-main`);
  if (role === 'yi') {
    const plan = planEdit(text, scene);
    if (plan.clarification) return line('yi', plan.clarification, 'recover', plan.elementIds);
    const targets = plan.elementIds.map(id => getElement(scene, id).label).join('、');
    return line('yi', `我会改${targets}。交给我这条工单，我就开工。`, 'work', plan.elementIds);
  }
  if (!typed[role]) throw new Error('找不到这位甲方。');
  if (/^(你好|您好|在吗|哈喽|嗨|hello|hi|hey|are you there)[\s!！?？。]*$/i.test(text)) {
    if (scene.project) return line(role, `在。接着聊「${scene.project.name}」这张海报。`, themed[role].goal.mood, themed[role].goal.elementIds);
    return line(role, ...welcomes[role]);
  }
  const reason = explain(role, text, scene, review);
  if (reason) return reason;

  const stage = advance(reveal ?? lastLine?.requirement.stage);
  const wording = scene.project ? themed[role][stage] : fitCriterion(role, typed[role][stage], scene);
  const response = demand(role, stage, wording);
  if (lastLine?.id) response.replyTo = lastLine.id;
  return withNeeds(response, scene.project);
}

export function answerRole(role, text, options = {}) {
  return bilingualDialogueLine(localAnswer(role, text, options), options.language);
}

function stickerRequirement(role, elementIds, goal, condition) {
  return {
    ...requirement(role, 'criterion', elementIds, goal, '把黄贴移到预约码旁边，别动馆标。', condition),
    id: `${role}-sticker`,
  };
}

const clash = [
  line('lin', '看右上！黄贴压住半个馆标了。先把馆标还我。', 'sharp', ['sticker', 'logo'], {
    requirement: stickerRequirement('lin', ['sticker', 'logo'], '让右上角馆标完整露出', '保留授权白标原比例与净空。'),
  }),
  line('tang', '这回我打开手机就看见免费、须预约！就留这儿。', 'excited', ['sticker', 'info'], { replyTo: 0 }),
  line('zhou', '留这儿？人家先记住免费，连要去看什么都不知道！', 'angry', ['sticker', 'title'], {
    replyTo: 1,
    requirement: stickerRequirement('zhou', ['sticker', 'title'], '恢复展名的第一眼优先级', '手机预览先读到完整展名，再找到预约条件。'),
  }),
  line('tang', '馆标可以给你。周总，预约别缩回脚注！人到门口才知道要约，谁去拦？', 'urgent', ['sticker', 'qr', 'logo'], {
    replyTo: 2,
    requirement: stickerRequirement('tang', ['sticker', 'qr', 'logo'], '保住醒目的预约条件', '移开黄贴后，手机预览仍能及时读到免费和须预约。'),
  }),
];

const approved = {
  zhou: ['先读到展名了。行，角标留着。', 'firm', ['title', 'sticker']],
  lin: ['白标完整，署名清楚。我签。', 'point', ['logo', 'credits']],
  tang: ['免费、须预约都找得到，码能进预约页。东门也写了，发吧。', 'excited', ['sticker', 'qr', 'info']],
};

function impact(role, review, previous) {
  const previousItems = previous?.[role]?.items ?? [];
  return review[role].items.reduce((delta, item) => {
    const before = previousItems.find(entry => entry.id === item.id);
    return delta + (before?.earned != null && item.earned != null ? item.earned - before.earned : 0);
  }, 0);
}

function recentIssue(result, changedElements) {
  return result.items.find(item => item.level !== 1 && item.state !== 'notApplicable' && item.elementIds.some(id => changedElements.includes(id)));
}

function reaction(role, result, delta, changedElements) {
  if (result.score === 100) return line(role, ...approved[role]);
  const concern = recentIssue(result, changedElements);
  if (concern) {
    const mood = role === 'zhou' ? delta < 0 ? 'angry' : 'firm' : role === 'lin' ? delta < 0 ? 'sharp' : 'point' : delta > 0 ? 'excited' : 'urgent';
    const lead = role === 'zhou' ? '看这儿。' : role === 'lin' ? '指给你看。' : '我用手机看了一遍。';
    const englishLead = { zhou: 'Look here. ', lin: 'Here is the issue. ', tang: 'I checked it on my phone. ' }[role];
    return line(role, lead + concern.reason, mood, concern.elementIds, { translations: { en: { text: englishLead + englishReview(concern) } } });
  }
  if (role === 'zhou') return line(role, '眼睛还是先去找展名。我看的是这一版。', 'firm', ['title']);
  if (role === 'lin') return line(role, '这次改动的地方看过了。馆标和署名的位置照旧。', 'point', ['logo', 'credits']);
  return line(role, '我还盯着预约和东门。走到现场得照这张图办。', 'urgent', ['sticker', 'info', 'qr']);
}

function localReviewTurns({ scene, review, previousReview, changedElements = [], issues = [] }) {
  if (scene?.project) {
    const turns = reviewers.map(role => {
      const result = review[role];
      const concern = recentIssue(result, changedElements) ?? result.items.find(item => item.level !== 1 && item.state !== 'notApplicable');
      const target = themed[role].goal;
      const variant = concern ? { translations: { en: { text: englishReview(concern) } } } : {};
      return withNeeds(line(role, concern?.reason ?? `「${scene.project.name}」这版，我负责的部分可以交。`, target.mood, concern?.elementIds ?? target.elementIds, variant), scene.project);
    });
    return connectCustomTurns(turns, scene);
  }
  const stickerIssue = issues.find(issue => issue.id === 'sticker-placement' && issue.status === 'open' && issue.changed);
  const exactClash = review.zhou.items[0].evidence.stickerCompetes && review.lin.items[0].evidence.overlapPx > 0 && review.tang.items[1].level === 1;
  if (exactClash && (stickerIssue || changedElements.includes('sticker'))) return structuredClone(clash).map(response => withNeeds(response));

  const impacts = Object.fromEntries(reviewers.map(role => [role, impact(role, review, previousReview)]));
  const ranked = [...reviewers].sort((first, second) => Math.abs(impacts[second]) - Math.abs(impacts[first]));
  const first = ranked.shift();
  const opposing = ranked.findIndex(role => impacts[role] * impacts[first] < 0);
  if (opposing > 0) ranked.unshift(ranked.splice(opposing, 1)[0]);
  const order = [first, ...ranked];
  return order.map((role, index) => {
    const response = reaction(role, review[role], impacts[role], changedElements);
    if (index === 1 && impacts[role] * impacts[first] < 0 && issues.some(issue => issue.changed && issue.status === 'open')) {
      response.replyTo = 0;
      response.text = `${names[first]}，等一下。${response.text}`;
      if (response.translations?.en) response.translations.en.text = `Hold on, ${englishRoles[first]}. ${response.translations.en.text}`;
    }
    return withNeeds(response);
  });
}

export function reviewTurns(options) {
  return localReviewTurns(options).map(response => bilingualDialogueLine(response, options.language));
}
