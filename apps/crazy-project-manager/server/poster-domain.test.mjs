import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  answerRole, applyPatch, applyUpload, buildIssues, createScene, openingLines, planEdit,
  posterSVG, rasterizePoster, reviewScene, reviewTurns, verifyPosterQR,
} from './domain.mjs';

const scoreList = review => ['zhou', 'lin', 'tang'].map(role => review[role].score);
const edit = (scene, text) => applyPatch(scene, planEdit(text, scene).patches);

function checkedReview(scene) {
  const svg = posterSVG(scene);
  const png = rasterizePoster(svg);
  assert.deepEqual([png.width, png.height], [600, 800]);
  const qr = verifyPosterQR(scene, svg, { rgba: png, reachable: target => target === scene.reservationUrl });
  assert.equal(qr, 'verified');
  return reviewScene(scene, { qr });
}

test('黄贴示例三版各有实际可解码的二维码和精确评分', () => {
  const a = createScene({ reservationUrl: 'http://localhost:4173/reservation' });
  const aReview = checkedReview(a);
  const aIssues = buildIssues(aReview);
  assert.deepEqual(scoreList(aReview), [100, 100, 85]);

  const b = edit(a, '把免费 · 须预约做成标题旁的大黄贴');
  const bIds = b.diff.map(item => item.id);
  assert.deepEqual(bIds, ['sticker']);
  const bReview = checkedReview(b.scene);
  assert.deepEqual(scoreList(bReview), [80, 65, 100]);
  assert.deepEqual(bReview.zhou.items.map(item => item.earned), [20, 25, 20, 15]);
  assert.deepEqual(bReview.lin.items.map(item => item.earned), [0, 20, 20, 25]);
  assert.deepEqual(bReview.tang.items.map(item => item.earned), [35, 30, 25, 10]);
  const bIssues = buildIssues(bReview, aIssues, bIds);
  const debate = reviewTurns({ scene: b.scene, review: bReview, previousReview: aReview, changedElements: bIds, issues: bIssues });
  assert.deepEqual(debate.map(turn => [turn.role, turn.replyTo]), [['lin', undefined], ['tang', 0], ['zhou', 1], ['tang', 2]]);
  assert.ok(debate.every(turn => turn.elementIds.includes('sticker')));
  assert.deepEqual(planEdit(debate[0].text, b.scene, { sourceMessages: [debate[0]] }).elementIds, ['sticker']);

  const c = edit(b.scene, '把黄贴移到预约码旁边，别动馆标');
  assert.deepEqual(c.diff.map(item => item.id), ['sticker']);
  const cReview = checkedReview(c.scene);
  assert.deepEqual(scoreList(cReview), [100, 100, 100]);
  assert.equal(buildIssues(cReview, bIssues, ['sticker']).find(issue => issue.id === 'sticker-placement').status, 'resolved');
  assert.deepEqual(c.scene.elements.filter(layer => layer.id !== 'sticker'), a.elements.filter(layer => layer.id !== 'sticker'));
});

test('扫码证据来自导出像素与站内地址的实测', () => {
  const scene = createScene();
  const svg = posterSVG(scene);
  assert.equal(verifyPosterQR(scene, svg), 'pending');
  assert.equal(verifyPosterQR(scene, svg, { reachable: false }), 'invalid');
  const locked = reviewScene(scene);
  assert.equal(locked.tang.score, null);
  assert.equal(locked.tang.pendingWeight, 25);
  assert.equal(locked.tang.lowerBound, 60);

  const qr = scene.elements.find(element => element.id === 'qr');
  const covered = applyPatch(scene, [{ id: 'sticker', set: { x: qr.x, y: qr.y, w: qr.w, h: qr.h, treatment: 'yellow' } }]).scene;
  assert.equal(verifyPosterQR(covered, posterSVG(covered), { reachable: true }), 'invalid');
  const rewritten = applyPatch(scene, [{ id: 'qr', set: { url: 'https://example.com/other-event' } }]).scene;
  assert.equal(verifyPosterQR(rewritten, posterSVG(rewritten), { reachable: true }), 'invalid');
});

test('模糊开场会被回问，追问逐次有可转交的目标、条件和让步', () => {
  const scene = createScene();
  const [opening] = openingLines();
  assert.equal(planEdit(opening.text, scene, { sourceMessages: [opening] }).clarification, '你要我动标题、主图，还是颜色？说一处，我马上改。');
  const goal = answerRole('zhou', '高级具体指哪里？', { scene, messages: [opening] });
  const criteria = answerRole('zhou', '缩成手机大小先看见什么？', { scene, messages: [opening, { ...goal, id: 'M4' }] });
  const concession = answerRole('zhou', '黄贴放底部可以吗？', { scene, reveal: 'criterion' });
  assert.deepEqual([goal.requirement.stage, criteria.requirement.stage, concession.requirement.stage], ['goal', 'criterion', 'concession']);
  assert.ok(criteria.requirement.condition.includes('300'));
  assert.equal(criteria.replyTo, 'M4');
  assert.deepEqual(planEdit(criteria.text, scene, { sourceMessages: [criteria] }).elementIds, ['sticker']);
  assert.equal(answerRole('lin', '你好！', { scene }).requirement, undefined);
  assert.deepEqual(answerRole('yi', '展名放大一点', { scene }).elementIds, ['title']);
});

test('合并与校验只改变工单明确点名的图层', () => {
  const scene = createScene();
  const before = structuredClone(scene);
  const plan = planEdit('标题再大一点，配色用夜紫，别动馆标', scene);
  assert.deepEqual(plan.elementIds, ['title', 'palette']);
  const direct = applyPatch(scene, plan.patches);
  assert.deepEqual(direct.diff.map(item => item.id), ['title', 'palette']);
  assert.deepEqual(scene, before);
  assert.throws(() => applyPatch(scene, [...plan.patches, { id: 'logo', set: { x: 594 } }]), /超出/);
  assert.deepEqual(scene, before);
  const grouped = applyPatch(scene, [
    { op: 'group', ids: ['logo', 'credits'], group: 'brand' },
    { op: 'moveGroup', group: 'brand', dx: -10, dy: -1 },
  ]);
  assert.deepEqual(grouped.diff.map(item => item.id), ['logo', 'credits']);
  const escaped = applyPatch(scene, [{ id: 'tagline', set: { text: 'a <b> & c' } }]);
  assert.match(posterSVG(escaped.scene), /a &lt;b&gt; &amp; c/);
});

test('上传素材校验解码后替换主视觉，并保留上传待评依据', () => {
  const scene = createScene();
  const png = rasterizePoster('<svg width="8" height="9" xmlns="http://www.w3.org/2000/svg"><rect width="8" height="9" fill="#365970"/></svg>').asPng();
  const img = `data:image/png;base64,${png.toString('base64')}`;
  const uploaded = applyUpload(scene, img, '新主图.png');
  assert.deepEqual(uploaded.diff.map(item => item.id), ['visual']);
  assert.match(uploaded.diff[0].after.image, /^sha256:[a-f\d]{64}$/);
  assert.ok(posterSVG(uploaded.scene).includes(img));
  assert.equal(reviewScene(uploaded.scene, { qr: 'verified' }).zhou.pendingWeight, 25);

  const priorAsset = uploaded.diff[0].after.image.slice(7);
  uploaded.scene.elements.find(layer => layer.id === 'visual').image = `studio-asset:${priorAsset}`;
  assert.equal(applyUpload(uploaded.scene, img).diff[0].before.image, `sha256:${priorAsset}`);
  png[40] ^= 0xff;
  assert.throws(() => applyUpload(scene, `data:image/png;base64,${png.toString('base64')}`), /损坏/);
  assert.equal(scene.elements.find(layer => layer.id === 'visual').image, null);
});
