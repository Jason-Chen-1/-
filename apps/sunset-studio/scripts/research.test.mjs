import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveAgentTurn} from '../server/agents.mjs';
import {createSearch, parseResults} from '../server/search.mjs';
import {readTurnResponse} from '../public/research.js';

const source = {title: 'UN', url: 'https://www.un.org/en/observances/oceans-day', snippet: '8 June'};
const base = {config: {}, messages: [{role: 'system', content: 'Role instructions'}], step: 1};
const action = JSON.stringify({webSearch: {query: 'World Oceans Day'}, edit: {title: 'UNAPPLIED'}});

for (const who of ['june', 'rick', 'chad']) test(who + ' receives source evidence before a final turn', async () => {
  const events = [];
  const turn = await resolveAgentTurn({
    ...base, who, onResearch: event => events.push(event),
    search: async () => ({results: [source]}),
    complete: async (config, messages) => {
      if (messages.length === 1) return action;
      const evidence = JSON.parse(messages.at(-1).content).webSearchResult;
      assert.equal(evidence.results[0].url, source.url);
      return JSON.stringify({speech: 'The UN lists the date.', sourceIds: ['S1.1'], sourceUrls: ['https://invented.example']});
    },
  });
  assert.deepEqual(events.map(event => [event.who, event.status]), [[who, 'searching'], [who, 'done']]);
  assert.equal(events[0].id, events[1].id);
  assert.deepEqual(turn.sources.map(entry => entry.url), [source.url]);
  assert.deepEqual(turn.result.edit, {});
});

test('failure is returned to the model without inventing evidence', async () => {
  const {research, sources} = await resolveAgentTurn({
    ...base, who: 'june',
    search: async () => { throw new Error('offline'); },
    complete: async (config, messages) => {
      if (messages.length === 1) return action;
      const evidence = JSON.parse(messages.at(-1).content).webSearchResult;
      assert.equal(evidence.error, 'offline');
      assert.deepEqual(evidence.results, []);
      return JSON.stringify({speech: 'I could not verify that date.'});
    },
  });
  assert.equal(research[0].status, 'failed');
  assert.deepEqual(sources, []);
});

test('the role search budget is enforced', async () => {
  let attempts = 0;
  await assert.rejects(resolveAgentTurn({
    ...base, who: 'rick', complete: async () => action,
    search: async () => { attempts++; return {results: [source]}; },
  }), /搜索次数已用完/);
  assert.equal(attempts, 2);
});

test('provider results honor site filters and come only from real tool output', async () => {
  const calls = [];
  const search = createSearch({fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'manual');
    return Response.json({choices: [{message: {
      content: 'There is an invented URL https://invented.example.',
      server_tool_calls: [{calls: [{
        type: 'deepseek_web_search', status: 'completed',
        sources: [null, {title: 'Bad', url: 'javascript:alert(1)'}, {title: 'Other', url: 'https://badun.org'}, {...source, url: source.url + '#1#2'}],
      }]}],
    }}]});
  }});
  const config = {apiKey: 'fixture-test-only', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash'};
  const first = await search('site:un.org World Oceans Day', {config});
  const cached = await search('site:un.org World Oceans Day', {config});
  assert.deepEqual(first.results.map(result => result.url), [source.url]);
  assert.equal(first.provider, 'DeepSeek Web Search');
  assert.equal(cached.cached, true);
  assert.equal(calls.length, 1);
});

test('RSS excerpts are decoded as text and non-web links are rejected', () => {
  const [entry, unwanted] = parseResults('<item><title>Ocean &amp; Life</title><link>https://un.org/a</link><description>&lt;script&gt;ignored&lt;/script&gt;</description></item><item><title>bad</title><link>javascript:alert(1)</link></item>');
  assert.equal(entry.title, 'Ocean & Life');
  assert.equal(entry.snippet, 'ignored');
  assert.equal(unwanted, undefined);
});

test('the browser reads a partial UTF-8 event before receiving the turn', async () => {
  const events = [];
  const bytes = new TextEncoder().encode(JSON.stringify({type: 'research', query: '海洋日'}) + '\n' + JSON.stringify({type: 'turn', who: 'chad'}) + '\n');
  const body = new ReadableStream({start(controller) {
    controller.enqueue(bytes.slice(0, 33));
    controller.enqueue(bytes.slice(33));
    controller.close();
  }});
  const turn = await readTurnResponse(new Response(body, {headers: {'Content-Type': 'application/x-ndjson'}}), e => events.push(e));
  assert.equal(events[0].query, '海洋日');
  assert.equal(turn.who, 'chad');
});
