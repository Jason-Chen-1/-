import { englishReview, englishTarget, roleLanguage } from './role-language.mjs';

const han = /\p{Script=Han}/u;

const layerLabels = {
  底色与夜游配色: 'Background and night palette',
  底色与主配色: 'Background and color palette',
  环形主视觉: 'Circular main visual',
  主视觉: 'Main visual',
  展名: 'Exhibition title',
  项目标题: 'Project title',
  宣传语: 'Tagline',
  馆标: 'Museum logo',
  主办方标志: 'Organizer logo',
  '展期、时段与入场': 'Exhibition dates, hours, and entry',
  时间与地点: 'Time and venue',
  联合主办署名: 'Co-organizer credit',
  主办方署名: 'Organizer credit',
  预约二维码: 'Booking QR code',
  预约提示: 'Booking notice',
  活动角标: 'Event badge',
};

const scoreLabels = {
  标题与第一眼: 'Title and first impression',
  主视觉与活动目标: 'Main visual and event goals',
  布局主次: 'Layout hierarchy',
  文字编排: 'Typography',
  授权标志和用法: 'Approved logo and usage',
  正式署名: 'Official credits',
  品牌版式及配色: 'Brand layout and palette',
  实际辨识度: 'Brand legibility',
  活动事实与参与条件: 'Event details and entry conditions',
  关键信息是否好找: 'Visibility of key information',
  实际参与入口: 'Working booking link',
  卖点取舍: 'Promotional priorities',
  主办标志和留白: 'Organizer logo and clear space',
  主办方署名: 'Organizer credit',
  活动时间与地点: 'Event time and venue',
  活动信息是否好找: 'Visibility of event information',
  报名入口: 'Registration link',
  信息优先级: 'Information hierarchy',
  黄贴的显眼程度与摆放: 'Yellow badge visibility and placement',
};

const jobLabels = {
  项目初稿: 'First draft',
  放大标题旁的黄贴: 'Enlarge the yellow badge beside the title',
  黄贴移至预约区: 'Move the yellow badge to the booking area',
  替换主视觉: 'Replace the main visual',
};

const reasons = new Map([
  ['手机预览先能读到完整展名。', 'The full title reads first in the phone preview.'],
  ['标题旁的高对比黄贴与展名争第一眼。', 'The high-contrast yellow badge beside the title competes for attention.'],
  ['馆标的宽度让它抢在展名前被看见。', 'The museum logo is wide enough to draw attention before the title.'],
  ['展名需要更靠前的摆放、字号或字重。', 'Give the title more prominence through placement, size, or weight.'],
  ['海报的主视觉已被隐藏。', 'The poster’s main visual is hidden.'],
  ['上传主图与项目主题的匹配度有待确认。', 'The uploaded image still needs to be checked against the project theme.'],
  ['主视觉与项目方向不符。', 'The main visual does not fit the project direction.'],
  ['主视觉的尺寸或主题辨识度需要强化。', 'Increase the size of the main visual or make its theme clearer.'],
  ['模板主视觉与标题各有独立位置。', 'The template’s main visual and title occupy separate areas.'],
  ['主视觉与夜间开放的主题不符。', 'The main visual does not fit the after-hours theme.'],
  ['主视觉仍需强化夜间展览的辨识度。', 'Make the nighttime exhibition more recognizable in the main visual.'],
  ['环形夜景主视觉对应夜间开放。', 'The circular nighttime visual supports the after-hours theme.'],
  ['展名、主视觉与底部信息各有独立空间。', 'The title, main visual, and event details at the bottom each have their own space.'],
  ['展名字面超出文字框或画布。', 'Part of the title extends outside the text box or canvas.'],
  ['展名的断行割开了完整词组。', 'The line break splits a phrase in the title.'],
  ['宣传语字号与展名过于接近。', 'The tagline is almost as large as the exhibition title.'],
  ['标题断行、字重和文字边界清楚。', 'The title has clear line breaks and weight and fits within its text box.'],
  ['使用本场授权白标，比例、遮挡与安全净空均合规。', 'The approved white logo retains its proportions, is unobstructed, and has enough clear space.'],
  ['授权馆标没有显示。', 'The approved museum logo is hidden.'],
  ['画面使用了旧馆标，需要换成本场授权白标。', 'The poster uses the old museum logo. Replace it with the approved white version.'],
  ['馆标长宽比偏离授权素材。', 'The museum logo’s aspect ratio differs from the approved artwork.'],
  ['白标仍可辨认，四周安全净空不到 10 像素或离边缘不足 18 像素。', 'The white logo is still legible. It has less than 10 px of clear space or is less than 18 px from the edge.'],
  ['主办及联合主办全称和顺序正确。', 'The organizer and co-organizer are listed in full and in the correct order.'],
  ['合作方已列全，请检查职责和顺序。', 'All partners are listed. Check their roles and order.'],
  ['缺少主办或联合主办方的正式全称。', 'The full official name of the organizer or co-organizer is missing.'],
  ['授权区域与主题配色符合确认规范。', 'The logo placement and palette follow the approved guidelines.'],
  ['手机发布尺寸上的馆标与署名对比充足。', 'The museum logo and credits have sufficient contrast at phone size.'],
  ['馆标或署名的尺寸、边界与背景对比需要调整。', 'Adjust the size, bounds, or background contrast of the logo or credits.'],
  ['展期、开放时段、东门入场、免费及须预约与简报相符。', 'The dates, hours, East Gate entry, free admission, and booking requirement match the brief.'],
  ['「免费 · 须预约」在手机上清楚，并有独立的位置。', 'Free admission and required booking are clear and have their own space on phones.'],
  ['手机预览需仔细找才能看到费用和预约限制。', 'Admission costs and booking requirements are easy to miss in the phone preview.'],
  ['手机预览看不清预约限制。', 'The booking requirements are hard to read in the phone preview.'],
  ['本主题无需预约。', 'This event does not require booking.'],
  ['从本版导出像素解码，链接与声明的预约测试页一致且可达。', 'The QR code in this export decodes to the specified booking test page, and the page is reachable.'],
  ['导出码可解码，当前尺寸在手机发布时偏小。', 'The exported QR code decodes. It is small for a poster viewed on a phone.'],
  ['本版没有有效的预约入口。复核二维码的遮挡、尺寸或链接。', 'This version has no working booking link. Check the QR code’s visibility, size, and URL.'],
  ['本版预约入口尚缺实际扫码或可达性证据。', 'Scanning and reachability have yet to be verified for the booking link in this version.'],
  ['夜间活动的宣传语保持次要，参与信息有独立空间。', 'The after-hours tagline stays secondary, and the entry details have their own space.'],
  ['宣传语的字号超过了参与信息。', 'The tagline is larger than the entry details.'],
  ['简报已有主办方，画面尚未显示标志。', 'The brief names the organizer, and the logo is missing from the poster.'],
  ['按主办方标志的位置与净空核查。', 'Check the organizer logo’s position and clear space.'],
  ['等待项目确认主办方。', 'The organizer has yet to be confirmed.'],
  ['简报待补主办方全称。', 'The brief still needs the organizer’s full name.'],
  ['主办方全称与简报一致。', 'The organizer’s full name matches the brief.'],
  ['主办方署名缺失或与简报不一致。', 'The organizer credit is missing or differs from the brief.'],
  ['等待确认活动时间与地点。', 'The event time and venue have yet to be confirmed.'],
  ['已确定的活动信息与简报一致。', 'The confirmed event details match the brief.'],
  ['核对底部活动信息在手机预览的字号。', 'Check the size of the event details at the bottom in the phone preview.'],
  ['底部信息块还没有可读的时间或地点。', 'The details at the bottom do not show a readable time or venue.'],
  ['项目简报未设置报名入口。', 'The project brief does not include a registration link.'],
  ['保持活动信息优先于宣传语。', 'Keep the event details more prominent than the tagline.'],
]);

const factNames = {
  展期: 'the exhibition dates', 时段: 'the opening hours', 馆址与东门: 'the museum address and East Gate entry',
  免费和须预约: 'free admission and required booking', 时间: 'the event time', 地点: 'the venue',
};
const brandNotes = {
  馆标应位于右上或左下: 'Place the museum logo in the upper right or lower left.',
  当前配色未列入本场授权方案: 'The current palette is not approved for this event.',
};
const labelPairs = Object.entries(layerLabels);
const list = new Intl.ListFormat('en', { type: 'conjunction' });
const lowercaseFirst = (text) => text[0].toLowerCase() + text.slice(1);
const hasChinese = (text) => typeof text === 'string' && han.test(text);
const lookup = (dictionary, label) => Object.hasOwn(dictionary, label) ? dictionary[label] : undefined;

function overlapReason(text) {
  const clauses = text.split('，');
  const translated = clauses.map((clause) => {
    if (!clause.endsWith('相挤')) return null;
    for (const [name, english] of labelPairs) {
      const prefix = `${name}与`;
      if (!clause.startsWith(prefix)) continue;
      const other = lookup(layerLabels, clause.slice(prefix.length, -2));
      if (other) return `The ${lowercaseFirst(english)} and ${lowercaseFirst(other)} are too close together.`;
    }
    return null;
  });
  return translated.every(Boolean) ? translated.join(' ') : null;
}

function reviewReason(text, item) {
  if (!hasChinese(text)) return text;
  if (reasons.has(text)) return reasons.get(text);
  const missingTitle = /^海报上找不到完整的「(.+)」标题。$/s.exec(text);
  if (missingTitle) return `The full title “${missingTitle[1]}” is missing from the poster.`;
  const coveredLogo = /^(.+)遮挡了授权馆标。$/.exec(text);
  if (coveredLogo) {
    const coverers = coveredLogo[1].split('、').map((name) => lookup(layerLabels, name)).filter(Boolean);
    if (coverers.length) return `The approved museum logo is covered by ${list.format(coverers.map((label) => `the ${lowercaseFirst(label)}`))}.`;
  }
  const missingFacts = /^(.+)缺失或与简报不一致。$/.exec(text);
  if (missingFacts) {
    const names = missingFacts[1].split('、').map((name) => lookup(factNames, name)).filter(Boolean);
    if (names.length) return `Check ${list.format(names)}. The poster is missing this information or differs from the brief.`;
  }
  if (item.id === 'composition') {
    const overlap = overlapReason(text);
    if (overlap) return overlap;
  }
  if (item.id === 'brand-layout') {
    const notes = text.split('，').map((part) => lookup(brandNotes, part));
    if (notes.every(Boolean)) return notes.join(' ');
  }
  return englishReview(item);
}

function editLabel(label, elementIds) {
  if (!hasChinese(label)) return label;
  const named = lookup(jobLabels, label);
  if (named) return named;
  const restored = /^恢复\s+(V\d+)$/.exec(label);
  if (restored) return `Restore ${restored[1]}`;
  if (!label.startsWith('调整')) return label;
  const target = lookup(layerLabels, label.slice(2));
  return `Adjust ${target ? `the ${lowercaseFirst(target)}` : englishTarget(elementIds)}`;
}

function localizeLayer(layer) {
  if (!hasChinese(layer?.label)) return layer;
  const label = lookup(layerLabels, layer.label);
  return label ? { ...layer, label } : layer;
}

function localizeReview(review) {
  return Object.fromEntries(Object.entries(review).map(([role, score]) => [role, score && Array.isArray(score.items)
    ? { ...score, items: score.items.map((item) => ({
      ...item, label: lookup(scoreLabels, item.label) ?? item.label, reason: reviewReason(item.reason, item),
    })) }
    : score]));
}

export function localizeIssues(issues, language) {
  if (roleLanguage(language) !== 'en' || !Array.isArray(issues)) return issues;
  return issues.map((issue) => {
    const projected = { ...issue, label: lookup(scoreLabels, issue.label) ?? issue.label };
    if (Array.isArray(issue.opinions)) {
      projected.opinions = issue.opinions.map((opinion) => ({
        ...opinion,
        reason: reviewReason(opinion.reason, { ...opinion, id: opinion.itemId, elementIds: issue.elementIds }),
      }));
    }
    return projected;
  });
}

export function localizeJob(job, language) {
  if (!job || roleLanguage(language) !== 'en') return job;
  return hasChinese(job.label) ? { ...job, label: editLabel(job.label, job.elementIds) } : job;
}

export function localizeVersion(version, language) {
  if (!version || roleLanguage(language) !== 'en') return version;
  const projected = { ...version };
  if (hasChinese(version.label)) projected.label = editLabel(version.label, version.diff?.map(({ id }) => id));
  if (version.review) projected.review = localizeReview(version.review);
  if (Array.isArray(version.issues)) projected.issues = localizeIssues(version.issues, language);
  if (Array.isArray(version.elements)) projected.elements = version.elements.map(localizeLayer);
  if (Array.isArray(version.diff)) {
    projected.diff = version.diff.map((entry) => ({ ...entry, before: localizeLayer(entry.before), after: localizeLayer(entry.after) }));
  }
  return projected;
}
