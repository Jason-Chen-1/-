import {
  answerRole, applyPatch, buildIssues, initialScene, openingLines, planEdit, reviewScene, reviewTurns,
} from '../server/domain.mjs';
import { deskReactions } from '../server/employee-lines.mjs';

const dialogue = new Map();
function add(role, mood, text) {
  if (text) dialogue.set(`${role}|${text}`, [role, mood, text]);
}
function addTurn(turn) {
  add(turn.role, turn.mood, turn.text);
}

const employee = [
  ['confused', '你要我动标题、主图，还是颜色？说一处，我马上改。'],
  ['ready', '收到。我这就改，给我几秒。'],
  ['lazy', '这个视频就十五秒……真的。'],
  ['resume', '收到，继续刚才那张。进度还在。'],
  ['done', '交稿！新版本在中间，验一下。'],
  ['done', '这几个图层已经是工单指定的样子。'],
  ['resume', '我在。交给我一条改稿指令吧。'],
];
for (const [mood, text] of employee) add('yi', mood, text);
for (const reaction of deskReactions) for (const text of Object.values(reaction)) add('yi', 'startled', text);

const opening = openingLines();
opening.forEach(addTurn);
openingLines({ custom: true }).forEach(addTurn);
const clients = opening.map(message => message.role);
const evidence = { qr: 'verified' };
const initialReview = reviewScene(initialScene, evidence);
const initialIssues = buildIssues(initialReview);

function edit(text, before, previousReview = initialReview, previousIssues = initialIssues) {
  const plan = planEdit(text, before);
  add('yi', 'done', plan.reply);
  if (!plan.patches?.length) {
    add('yi', 'confused', plan.clarification);
    return null;
  }
  const { scene } = applyPatch(before, plan.patches);
  const review = reviewScene(scene, evidence);
  const changedElements = plan.elementIds;
  const issues = buildIssues(review, previousIssues, changedElements);
  reviewTurns({ scene, review, previousReview, changedElements, issues }).forEach(addTurn);
  return { scene, review, issues };
}

const variants = [{ scene: initialScene, review: initialReview }];
const conflict = edit('把免费 · 须预约做成标题旁的大黄贴。', initialScene);
if (conflict) {
  variants.push(conflict);
  const compromise = edit('把黄贴移到预约码旁边，别动馆标。', conflict.scene, conflict.review, conflict.issues);
  if (compromise) variants.push(compromise);
}
for (const input of ['放大展名', '换套配色', '整理底部信息', '馆标换成本场授权白标', '缩小黄贴']) edit(input, initialScene);
for (const role of clients) {
  for (const { scene, review } of variants) {
    addTurn(answerRole(role, '你好', { scene, review }));
    addTurn(answerRole(role, '为什么扣分？', { scene, review }));
    for (const reveal of [undefined, 'goal', 'criterion']) {
      addTurn(answerRole(role, '具体怎么改？', { scene, review, reveal }));
    }
  }
}

process.stdout.write(JSON.stringify([...dialogue.values()]));
