import { defaultLogoColor, getElement, intersection, palettes, separation, theme } from './poster.mjs';

export const reviewers = ['zhou', 'lin', 'tang'];
export const compactText = text => String(text).replace(/[^\p{L}\p{N}]/gu, '');

export function estimatedTextWidth(text, size, kerning = 0) {
  return Array.from(text).reduce((sum, character) => sum + (/[\p{Script=Han}\u3000-\u303F\uFF00-\uFFEF]/u.test(character) ? 1 : .59) * size + kerning, 0);
}

function criterion(id, label, weight, level, reason, elementIds, evidence = {}) {
  const states = { 1: 'full', 0.5: 'partial', 0: 'missing' };
  return { id, label, weight, level, earned: level === null ? null : level * weight, reason, elementIds, evidence, state: states[level] ?? 'pending' };
}

function finalize(items) {
  const applicable = items.filter(item => item.state !== 'notApplicable');
  const applicableWeight = applicable.reduce((total, item) => total + item.weight, 0);
  const pendingWeight = applicable.filter(item => item.level === null).reduce((total, item) => total + item.weight, 0);
  const earned = applicable.reduce((total, item) => total + (item.earned ?? 0), 0);
  const lowerBound = Math.round(100 * earned / applicableWeight);
  return { score: pendingWeight ? null : lowerBound, lowerBound, pendingWeight, items };
}

function titleInk(layer) {
  const lines = layer.text.split('\n');
  const style = layer.style;
  const spacing = style?.letterSpacing ?? -layer.size * .055;
  const width = Math.max(...lines.map(line => estimatedTextWidth(line, layer.size, spacing)));
  const height = layer.size * (.99 + (lines.length - 1) * (style?.lineHeight ?? 1.08));
  const left = style?.textAlign === 'right' ? layer.w - width : style?.textAlign === 'center' ? (layer.w - width) / 2 : 0;
  const top = style?.verticalAlign === 'bottom' ? Math.max(0, layer.h - height) : style?.verticalAlign === 'middle' ? Math.max(0, layer.h - height) / 2 : 0;
  return {
    ...layer,
    x: layer.x + left,
    y: layer.y + top,
    w: width,
    h: height,
  };
}

const referenceWidth = (scene, width) => width * scene.width / theme.width;
const referenceHeight = (scene, height) => height * scene.height / theme.height;

function sharesTitlePriority(sticker, scene) {
  return !sticker.hidden && sticker.y < referenceHeight(scene, 262) && sticker.h >= referenceHeight(scene, 66) &&
    sticker.w >= referenceWidth(scene, 120) && sticker.treatment !== 'plain';
}

function approvedLogoPosition(logo, scene) {
  return (logo.x >= referenceWidth(scene, 408) && logo.y <= referenceHeight(scene, 61)) ||
    (logo.x <= referenceWidth(scene, 62) && logo.y >= referenceHeight(scene, 608) && logo.y < referenceHeight(scene, 716));
}

function usableQr(layer) {
  return !layer.hidden && layer.url.length > 0;
}

function reviewTitle(title, sticker, logo, scene) {
  const { project } = scene;
  const expected = project?.facts.title ?? theme.facts.title;
  const intact = compactText(title.text) === compactText(expected);
  const prominent = title.size >= referenceWidth(scene, project ? 46 : 76) && title.weight >= 700 && title.y < referenceHeight(scene, 226);
  const competing = sharesTitlePriority(sticker, scene);
  const oversizedLogo = !logo.hidden && logo.w > referenceWidth(scene, 190);
  const level = title.hidden || title.style?.opacity === 0 || !title.text.trim() || !intact ? 0 : prominent && !competing && !oversizedLogo ? 1 : .5;
  let reason = '手机预览先能读到完整展名。';
  if (level === 0) reason = `海报上找不到完整的「${expected}」标题。`;
  else if (competing) reason = '标题旁的高对比黄贴与展名争第一眼。';
  else if (oversizedLogo) reason = '馆标的宽度让它抢在展名前被看见。';
  else if (!prominent) reason = '展名需要更靠前的摆放、字号或字重。';
  return criterion('title-priority', '标题与第一眼', 40, level, reason, competing ? ['title', 'sticker'] : oversizedLogo ? ['title', 'logo'] : ['title'], {
    mobilePx: title.size * theme.previewWidth / scene.width,
    title: title.text.replaceAll('\n', ''),
    stickerCompetes: competing,
  });
}

function reviewVisual(visual, evidence, scene) {
  if (visual.hidden) return criterion('visual-goal', '主视觉与活动目标', 25, 0, '海报的主视觉已被隐藏。', ['visual']);
  if (visual.asset === 'uploaded' && evidence.visual === undefined) {
    return criterion('visual-goal', '主视觉与活动目标', 25, null, '上传主图与项目主题的匹配度有待确认。', ['visual'], { asset: visual.imageName });
  }
  const level = evidence.visual === 'wrong' ? 0 : evidence.visual === 'partial' || visual.w < referenceWidth(scene, 360) ? .5 : 1;
  const reason = scene.project
    ? ['主视觉与项目方向不符。', '主视觉的尺寸或主题辨识度需要强化。', '模板主视觉与标题各有独立位置。'][level * 2]
    : ['主视觉与夜间开放的主题不符。', '主视觉仍需强化夜间展览的辨识度。', '环形夜景主视觉对应夜间开放。'][level * 2];
  return criterion('visual-goal', '主视觉与活动目标', 25, level, reason, ['visual'], { asset: visual.asset });
}

function reviewLayout(layers) {
  const [title, visual, info, credits, qr] = layers;
  const candidates = [[titleInk(title), visual], [titleInk(title), info], [visual, info], [info, credits], [info, qr], [credits, qr]];
  const conflicts = candidates.filter(([left, right]) => intersection(left, right) > Math.min(left.w * left.h, right.w * right.h) * .09);
  const level = conflicts.length > 1 ? 0 : conflicts.length === 1 ? .5 : 1;
  const reason = conflicts.length ? conflicts.map(([left, right]) => `${left.label}与${right.label}相挤`).join('，') : '展名、主视觉与底部信息各有独立空间。';
  const elementIds = conflicts.length ? [...new Set(conflicts.flatMap(pair => pair.map(layer => layer.id)))] : ['title', 'visual', 'info'];
  return criterion('composition', '布局主次', 20, level, reason, elementIds);
}

function reviewTypography(title, tagline, scene) {
  const ink = titleInk(title);
  const padding = referenceWidth(scene, 3);
  const clipped = ink.w > title.w + padding || ink.h > title.h + padding || ink.x + ink.w > scene.width || ink.y + ink.h > scene.height;
  const taglineDominates = !tagline.hidden && tagline.size >= title.size * .47;
  const breaks = !scene.project && !['夜游\n美术馆', theme.facts.title].includes(title.text) && compactText(title.text) === theme.facts.title;
  const level = clipped ? 0 : breaks || taglineDominates ? .5 : 1;
  const reason = clipped ? '展名字面超出文字框或画布。' : breaks ? '展名的断行割开了完整词组。' : taglineDominates ? '宣传语字号与展名过于接近。' : '标题断行、字重和文字边界清楚。';
  return criterion('typography', '文字编排', 15, level, reason, taglineDominates ? ['title', 'tagline'] : ['title'], { inkWidth: Math.round(ink.w), boxWidth: title.w });
}

function logoCoverers(logo, layers) {
  const foreground = layers.slice(layers.findIndex(layer => layer.id === logo.id) + 1);
  return foreground.filter(layer => {
    if (layer.hidden || (layer.style?.opacity ?? 1) < .8 || intersection(logo, layer) <= .5) return false;
    if (layer.id === 'qr') return usableQr(layer);
    if (layer.id !== 'sticker' && !(layer.type === 'shape' && layer.shape === 'rect')) return false;
    if (layer.id === 'sticker' && layer.treatment === 'plain') return false;
    const fill = layer.style?.fill;
    const alpha = /^#[a-f0-9]{8}$/i.test(fill ?? '') ? parseInt(fill.slice(7), 16) / 255
      : /^#[a-f0-9]{4}$/i.test(fill ?? '') ? parseInt(fill.slice(4), 16) / 15 : 1;
    return !['none', 'transparent'].includes(fill) && alpha * (layer.style?.fillOpacity ?? 1) >= .8;
  });
}

function reviewLogo(logo, sticker, qr, scene) {
  const coverers = logoCoverers(logo, scene.elements);
  const covered = coverers.some(other => intersection(logo, other) > .5);
  const ratioCorrect = Math.abs((logo.w / logo.h) / (132 / 38) - 1) < .065;
  const approved = logo.asset === theme.assets.approvedLogo;
  const edge = Math.min(logo.x, logo.y, scene.width - logo.x - logo.w, scene.height - logo.y - logo.h);
  const tooClose = [sticker, qr].some(other => !other.hidden && separation(logo, other) < referenceWidth(scene, 10));
  const clear = edge >= referenceWidth(scene, 18) && !tooClose;
  const level = !approved || logo.hidden || covered || !ratioCorrect ? 0 : clear ? 1 : .5;
  let reason = '使用本场授权白标，比例、遮挡与安全净空均合规。';
  if (logo.hidden) reason = '授权馆标没有显示。';
  else if (!approved) reason = '画面使用了旧馆标，需要换成本场授权白标。';
  else if (covered) reason = `${coverers.map(layer => layer.label).join('、')}遮挡了授权馆标。`;
  else if (!ratioCorrect) reason = '馆标长宽比偏离授权素材。';
  else if (!clear) reason = '白标仍可辨认，四周安全净空不到 10 像素或离边缘不足 18 像素。';
  return criterion('logo-usage', '授权标志和用法', 35, level, reason, ['logo', ...coverers.map(layer => layer.id)], {
    asset: logo.asset,
    overlapPx: coverers.reduce((sum, layer) => sum + Math.round(intersection(logo, layer)), 0),
    edge,
    ratio: Math.round(100 * logo.w / logo.h) / 100,
  });
}

function reviewCredits(credits) {
  const exact = !credits.hidden && compactText(credits.text) === compactText(theme.facts.credits);
  const both = !credits.hidden && credits.text.includes('未眠美术馆') && credits.text.includes('城市艺术空间');
  return criterion('credits-line', '正式署名', 20, exact ? 1 : both ? .5 : 0,
    exact ? '主办及联合主办全称和顺序正确。' : both ? '合作方已列全，请检查职责和顺序。' : '缺少主办或联合主办方的正式全称。',
    ['credits'], { expected: theme.facts.credits, actual: credits.hidden ? '' : credits.text });
}

function reviewBrandLayout(logo, palette, scene) {
  const region = approvedLogoPosition(logo, scene);
  const approved = theme.approvedPalettes.includes(palette.preset);
  const level = (Number(region) + Number(approved)) / 2;
  const reason = level === 1 ? '授权区域与主题配色符合确认规范。' : [region ? '' : '馆标应位于右上或左下', approved ? '' : '当前配色未列入本场授权方案'].filter(Boolean).join('，');
  return criterion('brand-layout', '品牌版式及配色', 20, level, reason, [...(region ? [] : ['logo']), ...(approved ? [] : ['palette'])].concat(level === 1 ? ['logo', 'palette'] : []), {
    approvedPalettes: theme.approvedPalettes,
    palette: palette.preset,
  });
}

function contrast(foreground, background) {
  const luminance = color => color.slice(1).match(/../g).map(pair => Number.parseInt(pair, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0);
  const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (values[0] + .05) / (values[1] + .05);
}

function reviewLegibility(logo, credits, palette, scene) {
  const colors = palettes[palette.preset];
  const ratio = Math.min(contrast(colors.fine, colors.bg), contrast(defaultLogoColor(logo.asset, colors), colors.bg));
  const legibleLogo = logo.h >= referenceWidth(scene, 27) && ratio >= 4.5;
  const legibleCredits = credits.size >= referenceWidth(scene, 11) && estimatedTextWidth(credits.text, credits.size) <= credits.w && ratio >= 4.5;
  return criterion('brand-legibility', '实际辨识度', 25, (Number(legibleLogo) + Number(legibleCredits)) / 2,
    legibleCredits && legibleLogo ? '手机发布尺寸上的馆标与署名对比充足。' : '馆标或署名的尺寸、边界与背景对比需要调整。',
    ['logo', 'credits', 'palette'], { contrast: Math.round(100 * ratio) / 100, previewWidth: theme.previewWidth });
}

function reviewFacts(info, sticker) {
  const checks = [
    !info.hidden && compactText(info.date) === compactText(theme.facts.date),
    !info.hidden && compactText(info.hours) === compactText(theme.facts.hours),
    !info.hidden && info.venue === theme.facts.venue && info.gate === theme.facts.gate,
    !sticker.hidden && compactText(sticker.text) === `${theme.facts.admission}${theme.facts.reservation}`,
  ];
  const labels = ['展期', '时段', '馆址与东门', '免费和须预约'];
  const missing = labels.filter((_, index) => !checks[index]);
  const level = missing.length === 0 ? 1 : missing.length <= 2 ? .5 : 0;
  return criterion('event-facts', '活动事实与参与条件', 35, level, level === 1 ? '展期、开放时段、东门入场、免费及须预约与简报相符。' : `${missing.join('、')}缺失或与简报不一致。`, ['info', 'sticker'], { missing });
}

function reviewVisibility(sticker, qr, info, scene) {
  const phoneFont = sticker.size * theme.previewWidth / scene.width;
  const grouped = !qr.hidden && separation(sticker, qr) < referenceWidth(scene, 35) && intersection(sticker, qr) === 0;
  const emphasis = sticker.treatment !== 'plain' && phoneFont >= 10 && (grouped || sharesTitlePriority(sticker, scene));
  const readable = !sticker.hidden && sticker.text.trim() && phoneFont >= 5;
  const level = readable ? emphasis && info.size >= referenceWidth(scene, 14) ? 1 : .5 : 0;
  const reason = level === 1 ? '「免费 · 须预约」在手机上清楚，并有独立的位置。' : level === .5 ? '手机预览需仔细找才能看到费用和预约限制。' : '手机预览看不清预约限制。';
  return criterion('info-visibility', '关键信息是否好找', 30, level, reason, ['sticker', 'qr', 'info'], { phoneFont, previewWidth: theme.previewWidth });
}

function reviewEntry(qr, evidence, scene) {
  if (!theme.facts.reservation) {
    return { ...criterion('reservation-qr', '实际参与入口', 25, null, '本主题无需预约。', ['qr']), state: 'notApplicable' };
  }
  const minimum = referenceWidth(scene, 76);
  const level = !usableQr(qr) || evidence.qr === 'invalid' ? 0 : evidence.qr === 'verified' ? (qr.w >= minimum && qr.h >= minimum ? 1 : .5) : null;
  const reason = level === 1 ? '从本版导出像素解码，链接与声明的预约测试页一致且可达。' : level === .5 ? '导出码可解码，当前尺寸在手机发布时偏小。' : level === 0 ? '本版没有有效的预约入口。复核二维码的遮挡、尺寸或链接。' : '本版预约入口尚缺实际扫码或可达性证据。';
  return criterion('reservation-qr', '实际参与入口', 25, level, reason, ['qr'], { url: qr.url, verification: evidence.qr ?? 'pending' });
}

function reviewSales(tagline, info, sticker) {
  const priority = tagline.hidden || tagline.size <= Math.max(info.size, sticker.size);
  return criterion('sales-focus', '卖点取舍', 10, priority ? 1 : .5,
    priority ? '夜间活动的宣传语保持次要，参与信息有独立空间。' : '宣传语的字号超过了参与信息。',
    ['tagline', 'info', 'sticker']);
}

function projectReview(scene, { title, visual, logo, credits, palette, sticker, info, qr, tagline }, evidence) {
  const { facts } = scene.project;
  const present = [['date', '时间'], ['venue', '地点']].filter(([key]) => facts[key]);
  const missing = present.filter(([key]) => info.hidden || compactText(info[key]) !== compactText(facts[key])).map(([, label]) => label);
  const completeness = !present.length ? null : missing.length === 0 ? 1 : missing.length < present.length ? .5 : 0;
  const posted = !info.hidden && Boolean(info.date || info.venue);
  const available = !facts.organizer ? null : !credits.hidden && compactText(credits.text) === compactText(facts.credits) ? 1 : 0;
  const coverers = logoCoverers(logo, scene.elements);
  const logoCheck = facts.organizer
    ? criterion('logo-usage', '主办标志和留白', 35, logo.hidden || coverers.length ? 0 : approvedLogoPosition(logo, scene) ? 1 : .5,
      logo.hidden ? '简报已有主办方，画面尚未显示标志。' : coverers.length ? `${coverers.map(layer => layer.label).join('、')}遮挡了主办方标志。` : '按主办方标志的位置与净空核查。',
      ['logo', ...coverers.map(layer => layer.id)])
    : criterion('logo-usage', '主办标志和留白', 35, null, '等待项目确认主办方。', ['logo']);
  return {
    zhou: finalize([reviewTitle(title, sticker, logo, scene), reviewVisual(visual, evidence, scene), reviewLayout([title, visual, info, credits, qr]), reviewTypography(title, tagline, scene)]),
    lin: finalize([
      logoCheck,
      criterion('credits-line', '主办方署名', 20, available, available === null ? '简报待补主办方全称。' : available ? '主办方全称与简报一致。' : '主办方署名缺失或与简报不一致。', ['credits']),
      reviewBrandLayout(logo, palette, scene), reviewLegibility(logo, credits, palette, scene)
    ]),
    tang: finalize([
      criterion('event-facts', '活动时间与地点', 35, completeness, completeness === null ? '等待确认活动时间与地点。' : missing.length ? `${missing.join('、')}缺失或与简报不一致。` : '已确定的活动信息与简报一致。', ['info'], { missing }),
      criterion('info-visibility', '活动信息是否好找', 30, posted ? info.size >= referenceWidth(scene, 18) ? 1 : .5 : 0, posted ? '核对底部活动信息在手机预览的字号。' : '底部信息块还没有可读的时间或地点。', ['info']),
      { ...criterion('reservation-qr', '报名入口', 25, null, '项目简报未设置报名入口。', ['qr']), state: 'notApplicable' },
      criterion('sales-focus', '信息优先级', 10, tagline.hidden || tagline.size <= info.size ? 1 : .5, '保持活动信息优先于宣传语。', ['tagline', 'info'])
    ])
  };
}

export function reviewScene(scene, evidence = {}) {
  const layers = Object.fromEntries(scene.elements.map(layer => [layer.id, layer]));
  if (scene.project) return projectReview(scene, layers, evidence);
  const { title, visual, logo, credits, palette, sticker, info, qr, tagline } = layers;
  return {
    zhou: finalize([reviewTitle(title, sticker, logo, scene), reviewVisual(visual, evidence, scene), reviewLayout([title, visual, info, credits, qr]), reviewTypography(title, tagline, scene)]),
    lin: finalize([reviewLogo(logo, sticker, qr, scene), reviewCredits(credits), reviewBrandLayout(logo, palette, scene), reviewLegibility(logo, credits, palette, scene)]),
    tang: finalize([reviewFacts(info, sticker), reviewVisibility(sticker, qr, info, scene), reviewEntry(qr, evidence, scene), reviewSales(tagline, info, sticker)]),
  };
}

function issueKey(item) {
  if (item.elementIds.includes('sticker') && ['title-priority', 'logo-usage', 'info-visibility'].includes(item.id)) return 'sticker-placement';
  return item.id;
}

export function buildIssues(review, previousIssues = [], changedElements = []) {
  const current = new Map();
  for (const role of reviewers) {
    for (const item of review[role].items) {
      if (item.level === 1 || item.state === 'notApplicable') continue;
      const id = issueKey(item);
      const issue = current.get(id) ?? { id, label: id === 'sticker-placement' ? '黄贴的显眼程度与摆放' : item.label, elementIds: [], opinions: [], status: 'pending' };
      issue.elementIds = [...new Set([...issue.elementIds, ...item.elementIds])];
      issue.opinions.push({ role, reason: item.reason, itemId: item.id, level: item.level });
      if (item.level !== null) issue.status = 'open';
      current.set(id, issue);
    }
  }
  for (const previous of previousIssues) {
    if (!current.has(previous.id)) current.set(previous.id, { ...previous, status: 'resolved' });
  }
  const changed = new Set(changedElements);
  return [...current.values()].map(issue => {
    const previous = previousIssues.find(item => item.id === issue.id);
    const related = issue.elementIds.some(id => changed.has(id));
    return { ...issue, changed: related || !previous || JSON.stringify(previous.opinions) !== JSON.stringify(issue.opinions) || previous.status !== issue.status };
  });
}
