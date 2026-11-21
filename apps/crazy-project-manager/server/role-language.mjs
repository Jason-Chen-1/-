const han = /\p{Script=Han}/u;
const fields = ['text', 'goal', 'instruction', 'condition', 'concession'];

export const englishRoles = { zhou: 'Zhou', lin: 'Lin', tang: 'Tang', yi: 'Xiao Yi' };
export const englishLayers = {
  title: 'the title', logo: 'the logo', credits: 'the credits', sticker: 'the badge', qr: 'the booking QR code',
  info: 'the event details', palette: 'the color palette', visual: 'the main visual', tagline: 'the tagline',
};

export function roleLanguage(language) {
  return /^en(?:[-_]|$)/i.test(String(language ?? '')) ? 'en' : 'zh-CN';
}

const english = new Map([
  ['高级一点。', 'Make it feel more refined.'],
  ['按联名那份规范走。', 'Stick to the co-branding guidelines.'],
  ['几个卖点都得突出！', 'Every selling point has to pop!'],
  ['标题先给我立起来。观众得一眼看懂，这张海报在说什么！', 'Lead with the title. People need to know what this poster is about at a glance!'],
  ['先看标题。缩到手机大小，字和字也别挤成一团。', 'Start with the title. Shrink it to phone size. Can you still read every word?'],
  ['主图你可以试别的，给标题留块干净地方。', 'Try another main image if you like. Just give the title some breathing room.'],
  ['注意右上角！给主办方留署名和净空，别把元素堆成一团。', 'Check the upper right! Give the organizer credit and some breathing room.'],
  ['署名按简报里确认的全称。标志的四边都留出净空。', 'Use the full organizer name from the brief. Leave clear space around the logo.'],
  ['位置可以挪。只要署名完整，边缘留一点呼吸。', 'You can move it. Keep the full credit line and give it room at the edges.'],
  ['时间、地点！人真要照这张海报去现场，这两样给我做大！', 'Time and place! People are going to use this poster to get there. Make both bigger!'],
  ['活动信息都放底部一块。时间和地点要按你简报里写的。', 'Put the event details together at the bottom. Use the time and place from the brief.'],
  ['我可以让宣传语小一点，但时间地点得看得清！', 'I can live with a smaller tagline. People have to be able to read the time and place!'],
  ['展名。我想让观众第一眼就记住展名。', 'The exhibition name. That is what I want people to see and remember first.'],
  ['缩到手机大小，第一眼得先读完展名。黄贴挪到底部，重新看一眼。', 'At phone size, read the full exhibition name first. Move the yellow badge down and look again.'],
  ['底下可以留黄贴。先读展名，往下一眼知道怎么约。这个顺序对了，我签。', 'The yellow badge can stay at the bottom. Title first, booking second. Get that order right and I will sign off.'],
  ['看右上角。谁给的文件都先别用，我要这场授权的白标。', 'Look at the upper right. Use the approved white logo for this exhibition.'],
  ['本场用授权白标。右上角，原比例。旁边让出十像素，署名照着简报写全。', 'Approved white logo, upper right, original proportions. Leave ten pixels of clear space and keep the full credits from the brief.'],
  ['白标可以去左下。要移就完整地移。联合主办那一行，别删字。', 'The white logo can go in the lower left. Move it intact and keep the full co-organizer credit.'],
  ['白标被黄贴压住了。把黄贴挪开，馆标原比例。周围留出十像素。', 'The yellow badge is covering the white logo. Move the badge and leave ten pixels around the original logo.'],
  ['左下这块白标可以。原比例，周围留十像素，联合主办署名照着简报写全。', 'The white logo can stay in the lower left. Keep its proportions, ten pixels of clearance, and the full co-organizer credit.'],
  ['免费、须预约。这两件事得放一起！到了才知道要约，人就白跑了。', 'Free admission. Booking required. Put those together! Nobody wants to queue up and find that out at the door.'],
  ['我手机上得先找得到免费和须预约。先做张标题旁的大黄贴给我看！', 'On my phone I need to spot free admission and required booking. Show me a big yellow badge by the title!'],
  ['你放预约码旁边也行，字要看得清，东门也得看得见。', 'Beside the booking QR works. Keep the text legible and make sure people can find the East Gate.'],
  ['在。先说，观众要记住哪一件事？', 'I am here. What is the one thing people should remember?'],
  ['我在。要核对馆标还是联合主办署名？', 'I am listening. Do you want to check the logo or the co-organizer credit?'],
  ['在！你想核对时间、预约还是入口？', 'Here! Are we checking the time, booking, or the entrance?'],
  ['展名在第一眼，看得清。这个排法可以。', 'You see the title first and it reads clearly. This layout works.'],
  ['按这版的标和署名看，得分项已经齐了。', 'The logo and credits meet the requirements on this version.'],
  ['条件和入口这版都能核对。', 'The entry conditions and booking path are clear on this version.'],
  ['看右上！黄贴压住半个馆标了。先把馆标还我。', 'Look at the upper right! The yellow badge covers half the logo. Give me my logo back.'],
  ['这回我打开手机就看见免费、须预约！就留这儿。', 'Now I open the poster on my phone and see free admission and required booking! Keep it here.'],
  ['留这儿？人家先记住免费，连要去看什么都不知道！', 'Keep it here? People will remember “free” and have no idea what they came to see!'],
  ['馆标可以给你。周总，预约别缩回脚注！人到门口才知道要约，谁去拦？', 'You can have your logo. Zhou, bury the booking in a footnote and who is going to turn people away at the door?'],
  ['先读到展名了。行，角标留着。', 'The title reads first now. Fine, keep the badge.'],
  ['白标完整，署名清楚。我签。', 'The white logo is intact and the credits are clear. I sign off.'],
  ['免费、须预约都找得到，码能进预约页。东门也写了，发吧。', 'Free admission and booking are easy to find, the QR works, and the East Gate is clear. Send it.'],
  ['眼睛还是先去找展名。我看的是这一版。', 'I am still looking for the exhibition name first. On this version.'],
  ['这次改动的地方看过了。馆标和署名的位置照旧。', 'I checked the changes. The logo and credit positions stay as they were.'],
  ['我还盯着预约和东门。走到现场得照这张图办。', 'I am watching the booking details and East Gate. People will follow this poster to the venue.'],
  ['你要我动标题、主图，还是颜色？说一处，我马上改。', 'Title, main image, or colors? Pick one and I will get started.'],
  ['等一下。', 'Hold on.'],
  ['收到。我这就改，给我几秒。', 'Got it. Give me a few seconds.'],
  ['这个视频就十五秒……真的。', 'This video is only fifteen seconds. I swear.'],
  ['收到，继续刚才那张。进度还在。', 'Back to the same poster. The work is right where I left it.'],
  ['交稿！新版本在中间，验一下。', 'Done! The new version is on the canvas. Take a look.'],
  ['我在。交给我一条改稿指令吧。', 'I am here. Give me an edit to make.'],
  ['这几个图层已经是工单指定的样子。', 'Those layers already match the job.'],
  ['免费和须预约已经做成标题旁的大黄贴。', 'I put free admission and required booking on a big yellow badge by the title.'],
  ['黄贴挪到预约码旁边了。免费、须预约都在这块。', 'The yellow badge now sits by the booking QR. Both conditions are right there.'],
  ['优先读到展名', 'Read the exhibition title first'], ['把展名放大一点。', 'Make the exhibition title a little bigger.'], ['用手机预览确认完整展名。', 'Check that the full exhibition title reads on a phone.'],
  ['给主题留白', 'Give the title breathing room'], ['把宣传语缩小一点。', 'Make the tagline a little smaller.'], ['宣传语的字号低于展名。', 'Keep the tagline smaller than the title.'],
  ['馆标完整可辨', 'Keep the museum logo intact and legible'], ['把授权白标移到左下角。', 'Move the approved white logo to the lower left.'], ['保留授权白标比例和净空。', 'Keep the logo proportions and clear space.'],
  ['署名可辨', 'Make the credit line legible'], ['把联合主办署名放大一点。', 'Make the co-organizer credit a little bigger.'], ['署名全称和顺序保持不变。', 'Keep every full credit and preserve their order.'],
  ['参与条件醒目', 'Make entry conditions easy to spot'], ['把免费 · 须预约做成标题旁的大黄贴。', 'Put free admission and required booking on a big yellow badge beside the title.'], ['手机预览同时读到免费与须预约。', 'Both free admission and required booking should read on a phone.'],
  ['东门入场好找', 'Make the East Gate easy to find'], ['把底部活动信息放大一点。', 'Make the event details at the bottom a little bigger.'], ['用简报核对地点与东门。', 'Check the venue and East Gate against the brief.'],
  ['让标题有独立位置', 'Give the title its own space'], ['把主标题移到左上角，别动主视觉。', 'Move the title to the upper left and leave the main visual in place.'], ['完整标题留在画布内。', 'Keep the entire title on the canvas.'],
  ['先读活动名', 'Read the event name first'], ['副信息给项目标题让出层次。', 'Give the event title priority over secondary details.'],
  ['给主办方标志留白', 'Give the organizer logo clear space'], ['把主办方标志移到左下角。', 'Move the organizer logo to the lower left.'], ['标志和周围内容保持净空。', 'Leave a gap between the logo and surrounding content.'],
  ['正式署名可读', 'Make the official credit legible'], ['把主办方署名字号调到 16。', 'Set the organizer credit to 16 pixels.'], ['全称与简报一致。', 'Use the full name from the brief.'],
  ['时间地点与简报一致', 'Keep the time and place consistent with the brief'], ['按简报整理底部活动信息。', 'Lay out the event details at the bottom using the brief.'], ['用本项目确认过的时间和地点。', 'Use the confirmed time and place.'],
  ['让观众优先找到活动安排', 'Make the event schedule easy to find first'], ['底部时间地点更醒目。', 'Make the time and place at the bottom stand out.'],
  ['项目标题第一眼可读', 'Make the title readable at a glance'], ['把主标题放大一点。', 'Make the title a little bigger.'],
  ['手机上标题清晰', 'Keep the title legible on phones'], ['把主标题加粗。', 'Make the title bold.'], ['完整标题可读，文字留在画布内。', 'Make the full title legible and keep it inside the canvas.'],
  ['标题和主图的层次分开', 'Distinguish the title from the main image'],
  ['署名清楚，周围留白', 'Make the credit clear and leave space around it'], ['把主办方署名放大一点。', 'Make the organizer credit a little bigger.'],
  ['主办方全称和标志可辨认', 'Make the full organizer name and logo legible'], ['主办方署名按简报补齐，字号 16。', 'Complete the organizer credit from the brief and set it to 16 pixels.'], ['用项目已确认的全称，尺寸适合手机预览。', 'Use the confirmed full name at a readable phone size.'],
  ['署名不拥挤', 'Give the credit line space'], ['把主办方署名移到左下角。', 'Move the organizer credit to the lower left.'],
  ['活动时间和地点容易找到', 'Make the event time and place easy to find'], ['信息完整且容易找到', 'Keep the details complete and easy to find'], ['活动信息已确认时，在手机上同时读到时间和地点。', 'Once confirmed, make both the time and place legible on a phone.'],
  ['时间地点比宣传语醒目', 'Give the time and place priority over the tagline'], ['把底部活动信息字号调到 22，宣传语缩小。', 'Set the event details to 22 pixels and make the tagline smaller.'],
  ['让观众第一眼读到并记住展名', 'Make the exhibition name the first thing people read and remember'], ['展名先被看到', 'Make the exhibition title read first'],
  ['以 300 像素宽的手机预览核对，完整展名先于预约贴被看见。', 'At 300px wide, the full exhibition title should read before the booking badge.'], ['展名优先，其次才看到参与条件', 'Show the exhibition title first and the entry conditions second'], ['把黄贴移到预约码旁边，保留展名。', 'Move the yellow badge beside the booking QR and keep the exhibition title.'], ['以 300 像素宽的手机预览核对主次。', 'Check the hierarchy in a 300px-wide preview.'], ['底部可保留高对比黄贴，宣传语可删。', 'The high-contrast badge can stay at the bottom. The tagline is optional.'],
  ['使用本场的授权白标', 'Use the approved white logo'], ['馆标换成本场授权白标。', 'Use the approved white logo on this poster.'], ['馆标用对且完整可辨', 'Use the correct logo and keep it intact and legible'], ['馆标换成本场授权白标，署名按简报补齐。', 'Use the approved white logo and complete the credits from the brief.'], ['保留授权素材原比例、至少 10 像素净空和完整主办／联合主办署名。', 'Keep the original logo proportions, at least 10px of clear space, and full organizer and co-organizer credits.'], ['馆标和合作方署名完整', 'Preserve the museum logo and partner credits in full'], ['把授权白标移到左下角，别动署名。', 'Move the approved white logo to the lower left and keep the credits unchanged.'], ['保留授权素材原比例、净空及合作方全称。', 'Keep the original proportions, clear space, and full partner names.'], ['右上或左下都可，允许使用已授权的反白标志。', 'Either the upper right or lower left works. The approved reversed logo is acceptable.'],
  ['让观众一眼找到免费和须预约', 'Make free admission and required booking easy to spot'], ['把免费和须预约放在一起，标得醒目。', 'Group free admission and required booking and make them stand out.'], ['让参与条件在手机上读得清', 'Make the entry conditions readable on a phone'], ['在 300 像素宽的手机预览上清楚读出两项条件，实际预约码要能打开。', 'Both conditions should read in a 300px-wide preview, and the printed QR must open the booking page.'], ['找得到预约条件，也能从东门进', 'Make booking requirements and the East Gate easy to find'], ['把黄贴移到预约码旁边，别动馆标。', 'Move the yellow badge beside the booking QR and keep the logo unchanged.'], ['手机预览可读，当前稿的二维码可以打开预约页。', 'The text should read on a phone, and this version’s QR should open the booking page.'], ['允许放底部预约区，嘉宾介绍可放详情页。', 'The booking area can go at the bottom. Guest information can stay on the details page.'],
  ['把黄贴移到预约码旁边。', 'Move the yellow badge beside the booking QR.'], ['让右上角馆标完整露出', 'Keep the entire upper-right logo visible'], ['保留授权白标原比例与净空。', 'Keep the approved white logo’s proportions and clear space.'], ['恢复展名的第一眼优先级', 'Put the exhibition title back first'], ['手机预览先读到完整展名，再找到预约条件。', 'At phone size, read the full title first, then the booking conditions.'], ['保住醒目的预约条件', 'Keep the booking conditions prominent'], ['移开黄贴后，手机预览仍能及时读到免费和须预约。', 'After moving the yellow badge, keep free admission and booking visible on a phone.'],
]);

export function englishTarget(ids = []) {
  return ids.map(id => englishLayers[id]).filter(Boolean).join(' and ') || 'the layout';
}

const reviewTopics = {
  'title-priority': 'The title needs to read first.', 'visual-goal': 'The main image needs to support the event theme.',
  composition: 'Give the title, visual, and event details separate space.', typography: 'Check the title’s line breaks and edges.',
  'logo-usage': 'Keep the approved logo visible and give it clear space.', 'credits-line': 'Check the full credit line against the brief.',
  'brand-layout': 'Use an approved palette and logo position.', 'brand-legibility': 'The logo and credit line need to read at phone size.',
  'event-facts': 'Check the event details against the brief.', 'info-visibility': 'People need to find the event details on a phone.',
  'reservation-qr': 'Check that the booking QR on this version opens the right page.', 'sales-focus': 'Give the key event details priority over the tagline.',
};

export function englishReview(item) {
  if (item.id === 'logo-usage' && item.evidence?.overlapPx > 0) return 'Artwork is covering the logo. Move the overlapping element.';
  if (item.id === 'title-priority' && item.evidence?.stickerCompetes) return 'The yellow badge competes with the title for the first glance.';
  if (item.level === null && item.id === 'reservation-qr') return 'The booking QR has not been verified on this version.';
  if (item.level === null && item.id === 'visual-goal') return 'The uploaded image still needs to be checked against the event theme.';
  return reviewTopics[item.id] ?? `Review ${englishTarget(item.elementIds)} on this version.`;
}

function englishLine(value, line) {
  if (!value || !han.test(value)) return value;
  if (english.has(value)) return english.get(value);
  const project = value.match(/^「(.+)」这版，我负责的部分可以交。$/);
  if (project) return `My part of “${project[1]}” is ready to deliver.`;
  const greeting = value.match(/^在。接着聊「(.+)」这张海报。$/);
  if (greeting) return `I am here. Let’s get back to the “${greeting[1]}” poster.`;
  const interjection = value.match(/^(周总|林尺|阿唐)，等一下。(.+)$/);
  if (interjection) return `Hold on, ${{ 周总: 'Zhou', 林尺: 'Lin', 阿唐: 'Tang' }[interjection[1]]}. ${englishLine(interjection[2], line)}`;
  if (value.startsWith('等一下。')) return `Hold on. ${englishLine(value.slice('等一下。'.length), line)}`;
  if (/^我先确认一下/.test(value)) return `What should change in ${englishTarget(line.elementIds)}: the content, size, or position?`;
  if (/^我会改/.test(value)) return `I can change ${englishTarget(line.elementIds)}. Assign the job and I will get started.`;
  if (/改好了。你看这版。$/.test(value)) return `I’ve updated ${englishTarget(line.elementIds)}. Have a look.`;
  if (/^(?:哇|呜哇|别拍|我马上|等一下|我的咖啡)/.test(value) && /拍|咖啡|桌/.test(value)) return 'Whoa! You nearly knocked over my coffee! I’m on it!';
  return value;
}

function requirementCopy(item, language, supplied = {}) {
  if (!item) return undefined;
  const translated = item.translations?.[language] ?? supplied;
  const result = { id: item.id };
  for (const field of fields) {
    const original = item[field] || (field === 'text' ? item.goal || item.instruction : '') || '';
    if (language === 'zh-CN' || translated[field]) result[field] = translated[field] || original;
    else if (!han.test(original) || english.has(original)) result[field] = english.get(original) ?? original;
    else if (field === 'text' || field === 'goal') result[field] = `Review ${englishTarget(item.elementIds)}.`;
    else result[field] = '';
  }
  return result;
}

export function projectRequirement(item, language, supplied) {
  if (!item) return item;
  const copy = requirementCopy(item, roleLanguage(language), supplied);
  return { ...item, text: copy.text, goal: copy.goal, condition: copy.condition, concession: copy.concession, displayInstruction: copy.instruction };
}

export function projectDialogueLine(line, language) {
  if (!line || typeof line !== 'object' || line.role === 'manager') return line;
  const locale = roleLanguage(language);
  const variant = line.translations?.[locale];
  const items = Array.isArray(line.requirements) ? line.requirements : line.requirement ? [line.requirement] : [];
  const requirements = items.map(item => projectRequirement(item, locale, variant?.requirements?.find(copy => copy.id === item.id)));
  const requirement = line.requirement && (requirements.find(item => item.id === line.requirement.id) ?? projectRequirement(line.requirement, locale));
  const spoken = line.speech ?? line.text;
  const speech = variant?.speech ?? variant?.text ?? (locale === 'en' ? englishLine(spoken, line) : spoken);
  return { ...line, speech, text: speech, language: locale, ...(requirements.length ? { requirements } : {}), ...(requirement ? { requirement } : {}) };
}

export function bilingualDialogueLine(line, language, alternate = {}) {
  const items = line.requirements ?? (line.requirement ? [line.requirement] : []);
  const requirements = items.map(item => ({
    ...item,
    translations: { 'zh-CN': requirementCopy(item, 'zh-CN'), en: requirementCopy(item, 'en') },
  }));
  const primary = line.requirement && (requirements.find(item => item.id === line.requirement.id) ?? line.requirement);
  const existing = line.translations ?? {};
  const spoken = line.speech ?? line.text;
  const chinese = alternate['zh-CN'] ?? existing['zh-CN']?.speech ?? existing['zh-CN']?.text ?? spoken;
  const english = alternate.en ?? existing.en?.speech ?? existing.en?.text ?? englishLine(spoken, line);
  const translations = {
    'zh-CN': { speech: chinese, text: chinese, requirements: requirements.map(item => item.translations['zh-CN']) },
    en: { speech: english, text: english, requirements: requirements.map(item => item.translations.en) },
  };
  return projectDialogueLine({ ...line, requirements, ...(primary ? { requirement: primary } : {}), translations }, language);
}

const editTranslations = new Map([...english].filter(([zh]) => /^(?:把|馆标换|按简报|主办方署名按简报)/.test(zh)).map(([zh, en]) => [en.toLowerCase().replace(/[.!?]+$/, ''), zh]));
for (const [en, zh] of [
  ['make the title bigger', '标题再大一点'],
  ['try a different color palette', '试试另一种配色'],
  ['make a big yellow sticker next to the title, covering half the museum logo', '把免费 · 须预约做成标题旁的大黄贴，盖住半个馆标'],
  ['move the yellow sticker next to the reservation qr code and leave the logo alone', '把黄贴移到预约码旁边，别动馆标'],
  ['make the event info bigger', '把底部活动信息放大一点'],
]) editTranslations.set(en, zh);

export function localInstruction(text) {
  if (typeof text !== 'string') return text;
  const exact = value => editTranslations.get(value.trim().toLowerCase().replace(/[.!?]+$/, ''));
  const known = exact(text);
  if (known) return known;
  const clauses = text.split(/[\r\n;；]+|(?<=[.!?])\s+(?=[A-Z])/).map(value => value.trim()).filter(Boolean);
  if (clauses.length > 1 && clauses.some(exact)) return clauses.map(value => exact(value) ?? value).join('；');
  return text;
}
