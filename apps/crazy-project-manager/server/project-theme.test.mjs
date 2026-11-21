import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyPatch, createScene, openingLines, planEdit, posterSVG, rasterizePoster, reviewScene } from './domain.mjs';
import { projectTheme } from './project-theme.mjs';

const custom = projectTheme(undefined, {
  topic: '城市创意手作周',
  brief: '走进工坊，做自己的器物。',
  organizer: '创意社区',
  date: '12月5日 9:00—12:00',
  venue: '虹桥工坊',
});

test('自定义活动海报、角色意见与评分取自同一份简报', () => {
  const scene = createScene({ project: custom });
  const svg = posterSVG(scene);
  assert.match(svg, /城市创意手作周/);
  assert.match(svg, /创意社区/);
  assert.match(svg, /12月5日 9:00—12:00/);
  assert.match(svg, /虹桥工坊/);
  assert.match(svg, /走进工坊，做自己的器物/);
  assert.doesNotMatch(svg, /夜游美术馆|未眠美术馆|东门入场|特别夜间开放计划|免费 · 须预约|扫码预约/);
  const png = rasterizePoster(svg);
  assert.deepEqual([png.width, png.height], [600, 800]);
  assert.equal(reviewScene(scene).tang.score, 100);
  assert.equal(reviewScene(scene).tang.items.find(item => item.id === 'reservation-qr').state, 'notApplicable');
  assert.ok(openingLines(custom).every(turn => !/夜游|馆标|预约/.test(turn.text)));
});

test('自定义活动改错时间或地点会扣分，按简报恢复只修改活动信息图层', () => {
  const scene = createScene({ project: custom });
  const change = planEdit('把时间改成「12月6日 11:00」，地点改成「西岸工坊」', scene);
  const v2 = applyPatch(scene, change.patches);
  assert.deepEqual(v2.diff.map(item => item.id), ['info']);
  const svg = posterSVG(v2.scene);
  assert.match(svg, /12月6日 11:00/);
  assert.match(svg, /西岸工坊/);
  assert.equal(reviewScene(v2.scene).tang.items.find(item => item.id === 'event-facts').earned, 0);

  const restoration = planEdit('按简报整理底部活动信息', v2.scene);
  const v3 = applyPatch(v2.scene, restoration.patches);
  assert.deepEqual(v3.diff.map(item => item.id), ['info']);
  assert.deepEqual(v3.scene.project.facts, custom.facts);
  assert.equal(reviewScene(v3.scene).tang.score, 100);
  assert.match(posterSVG(v3.scene), /虹桥工坊/);
  assert.doesNotMatch(posterSVG(v3.scene), /未眠美术馆|东门入场/);
});
