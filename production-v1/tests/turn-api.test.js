import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createEventStreamHandler, EventHub } from '../src/services/events.js';
import { createDispatcher } from '../src/services/dispatcher.js';
import { createTurnProcessor } from '../src/services/turn-processor.js';
import { providerResponseLanguage } from '../src/services/voice.js';
import { startServer } from '../src/server.js';
import { AtomicFileStore } from '../src/stores/atomic-file-store.js';
import * as storeContract from '../src/stores/store-contract.js';

const ORIGIN = 'https://v1.example.test';

async function createStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-turn-'));
  const filePath = join(directory, 'store.json');
  const store = new AtomicFileStore({ filePath });
  await store.init();
  t.after(() => store.close());
  return { store, filePath };
}

async function createOwnedConversation(store, suffix = 'one') {
  const { session, conversation } = await store.createOrResumeSession({ tokenHash: `token-${suffix}`, now: '2026-08-25T00:00:00.000Z' });
  return { session, conversation };
}

async function accept(store, owner, clientMessageId, text, now) {
  return store.acceptMessage({
    sessionId: owner.session.id,
    conversationId: owner.conversation.id,
    clientMessageId,
    requestHash: `hash-${clientMessageId}`,
    text,
    replyLanguage: 'en',
    replyMode: 'text',
    now,
  });
}

function finalMessage(text = 'Grounded answer') {
  return {
    text,
    citations: [],
    cards: [],
    suggestedReplies: [],
    needsClarification: false,
    groundingStatus: 'unverified',
  };
}

function lease(workerId, token, nowMs, durationMs = 15_000) {
  return { workerId, leaseToken: token, now: new Date(nowMs), leaseUntil: new Date(nowMs + durationMs) };
}

test('turn api claims only the earliest nonterminal per conversation and fences every worker mutation', async (t) => {
  const { store } = await createStore(t);
  const firstOwner = await createOwnedConversation(store, 'first');
  const secondOwner = await createOwnedConversation(store, 'second');
  const first = await accept(store, firstOwner, '11111111-1111-4111-8111-111111111111', 'first', '2026-08-25T00:00:01.000Z');
  const later = await accept(store, firstOwner, '22222222-2222-4222-8222-222222222222', 'later', '2026-08-25T00:00:02.000Z');
  const other = await accept(store, secondOwner, '33333333-3333-4333-8333-333333333333', 'other', '2026-08-25T00:00:03.000Z');
  const base = Date.parse('2026-08-25T00:01:00.000Z');

  const claimedFirst = await store.claimNextTurn(lease('worker-a', 'lease-a', base));
  assert.equal(claimedFirst.id, first.turn.id);
  const claimedOther = await store.claimNextTurn(lease('worker-b', 'lease-b', base));
  assert.equal(claimedOther.id, other.turn.id);
  const blockedLater = await store.claimNextTurn(lease('worker-c', 'lease-c', base));
  assert.equal(blockedLater, null);

  await assert.rejects(store.setTurnState({ turnId: first.turn.id, leaseToken: 'stale', state: 'retrieving', now: new Date(base + 1) }), (error) => error.code === 'LEASE_LOST');
  await assert.rejects(store.renewTurnLease({ turnId: first.turn.id, leaseToken: 'stale', leaseUntil: new Date(base + 30_000), now: new Date(base + 1) }), (error) => error.code === 'LEASE_LOST');
  await assert.rejects(store.deliverAssistant({ turnId: first.turn.id, leaseToken: 'stale', message: finalMessage(), now: new Date(base + 1) }), (error) => error.code === 'LEASE_LOST');

  const transitioned = await store.setTurnState({ turnId: first.turn.id, leaseToken: 'lease-a', state: 'retrieving', now: new Date(base + 2) });
  assert.equal(transitioned.turn.state, 'retrieving');
  assert.equal(transitioned.event.type, 'turn.state');
  const renewed = await store.renewTurnLease({ turnId: first.turn.id, leaseToken: 'lease-a', leaseUntil: new Date(base + 40_000), now: new Date(base + 3) });
  assert.equal(renewed.leaseExpiresAt, new Date(base + 40_000).toISOString());
  assert.equal(later.turn.state, 'accepted');
});

test('turn api context is turn-ordered and excludes later accepted input from an earlier prompt', async (t) => {
  const { store } = await createStore(t);
  const owner = await createOwnedConversation(store);
  const first = await accept(store, owner, '11111111-1111-4111-8111-111111111111', 'user one', '2026-08-25T00:00:01.000Z');
  const second = await accept(store, owner, '22222222-2222-4222-8222-222222222222', 'user two', '2026-08-25T00:00:02.000Z');
  const base = Date.parse('2026-08-25T00:01:00.000Z');
  await store.claimNextTurn(lease('worker-a', 'lease-a', base));

  const contextOne = await store.getTurnContext({ turnId: first.turn.id });
  assert.deepEqual(contextOne.messages.map((message) => [message.role, message.text]), [['user', 'user one']]);

  await store.setTurnState({ turnId: first.turn.id, leaseToken: 'lease-a', state: 'retrieving', now: new Date(base + 1) });
  await store.setTurnState({ turnId: first.turn.id, leaseToken: 'lease-a', state: 'generating', now: new Date(base + 2) });
  await store.deliverAssistant({ turnId: first.turn.id, leaseToken: 'lease-a', message: finalMessage('assistant one'), now: new Date(base + 3) });
  const claimedSecond = await store.claimNextTurn(lease('worker-b', 'lease-b', base + 4));
  assert.equal(claimedSecond.id, second.turn.id);
  const contextTwo = await store.getTurnContext({ turnId: second.turn.id });
  assert.deepEqual(contextTwo.messages.map((message) => [message.role, message.text]), [
    ['user', 'user one'], ['assistant', 'assistant one'], ['user', 'user two'],
  ]);
});

test('turn api bounds history to the newest complete pairs while always retaining current inbound', async (t) => {
  const { store } = await createStore(t);
  const owner = await createOwnedConversation(store, 'budget');
  const base = Date.parse('2026-08-25T00:01:00.000Z');
  for (let index = 0; index < 14; index += 1) {
    const accepted = await accept(
      store,
      owner,
      `60000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      `history-user-${index}-${'用'.repeat(1_000)}`,
      new Date(base + (index * 10)),
    );
    const claimed = await store.claimNextTurn(lease(`budget-worker-${index}`, `budget-token-${index}`, base + (index * 10) + 1));
    assert.equal(claimed.id, accepted.turn.id);
    await store.setTurnState({ turnId: claimed.id, leaseToken: `budget-token-${index}`, state: 'retrieving', now: new Date(base + (index * 10) + 2) });
    await store.setTurnState({ turnId: claimed.id, leaseToken: `budget-token-${index}`, state: 'generating', now: new Date(base + (index * 10) + 3) });
    await store.deliverAssistant({
      turnId: claimed.id,
      leaseToken: `budget-token-${index}`,
      message: finalMessage(`history-assistant-${index}-${'答'.repeat(1_000)}`),
      now: new Date(base + (index * 10) + 4),
    });
  }
  const current = await accept(
    store,
    owner,
    '69999999-9999-4999-8999-999999999999',
    'CURRENT-INBOUND-MUST-REMAIN',
    new Date(base + 200),
  );
  await store.claimNextTurn(lease('budget-current', 'budget-current-token', base + 201));
  const context = await store.getTurnContext({ turnId: current.turn.id });
  const normalized = context.messages.map((message) => ({ role: message.role, text: message.text }));
  assert.equal(Number.isInteger(storeContract.contextLimits?.turnBytes), true);
  assert.equal(Buffer.byteLength(JSON.stringify(normalized)) <= storeContract.contextLimits.turnBytes, true);
  assert.equal(context.messages.at(-1).text, 'CURRENT-INBOUND-MUST-REMAIN');
  assert.equal(context.messages.some((message) => message.text.startsWith('history-user-13-')), true);
  assert.equal(context.messages.some((message) => message.text.startsWith('history-user-0-')), false);
  assert.equal((context.messages.length - 1) % 2, 0);
  for (let index = 0; index < context.messages.length - 1; index += 2) {
    assert.equal(context.messages[index].role, 'user');
    assert.equal(context.messages[index + 1].role, 'assistant');
  }
});

test('turn api reclaims expired work, prevents stale fail/delivery, and preserves terminal failure after reload', async (t) => {
  const { store, filePath } = await createStore(t);
  const owner = await createOwnedConversation(store);
  const first = await accept(store, owner, '11111111-1111-4111-8111-111111111111', 'recover me', '2026-08-25T00:00:01.000Z');
  const base = Date.parse('2026-08-25T00:01:00.000Z');
  await store.claimNextTurn(lease('worker-a', 'expired-token', base, 10));
  await store.setTurnState({ turnId: first.turn.id, leaseToken: 'expired-token', state: 'retrieving', now: new Date(base + 1) });
  await store.setTurnState({ turnId: first.turn.id, leaseToken: 'expired-token', state: 'generating', now: new Date(base + 2) });
  const reclaimed = await store.claimNextTurn(lease('worker-b', 'fresh-token', base + 11));
  assert.equal(reclaimed.id, first.turn.id);
  assert.equal(reclaimed.attempt, 2);
  await assert.rejects(store.failTurn({ turnId: first.turn.id, leaseToken: 'expired-token', failureCode: 'PROVIDER_UNAVAILABLE', now: new Date(base + 12) }), (error) => error.code === 'LEASE_LOST');
  await assert.rejects(store.deliverAssistant({ turnId: first.turn.id, leaseToken: 'expired-token', message: finalMessage('stale'), now: new Date(base + 12) }), (error) => error.code === 'LEASE_LOST');
  await store.failTurn({ turnId: first.turn.id, leaseToken: 'fresh-token', failureCode: 'ANSWER_FAILED', now: new Date(base + 12) });
  await store.close();

  const reopened = new AtomicFileStore({ filePath });
  await reopened.init();
  t.after(() => reopened.close());
  const messages = await reopened.listMessages({ sessionId: owner.session.id, conversationId: owner.conversation.id, after: 0 });
  const events = await reopened.listEvents({ sessionId: owner.session.id, conversationId: owner.conversation.id, afterCursor: 0 });
  assert.equal(messages[0].status, 'failed');
  assert.equal(messages[0].failureCode, 'ANSWER_FAILED');
  assert.equal(events.at(-1).type, 'turn.failed');
  assert.equal(events.at(-1).payloadJson.failureCode, 'ANSWER_FAILED');
});

test('turn api dispatcher polling finds persisted work without wake and racing dispatchers deliver once', async (t) => {
  const { store } = await createStore(t);
  const owner = await createOwnedConversation(store);
  await accept(store, owner, '11111111-1111-4111-8111-111111111111', 'persisted before wake', '2026-08-25T00:00:01.000Z');
  let answerCalls = 0;
  const answerService = {
    async answer({ beforeProvider }) {
      answerCalls += 1;
      await beforeProvider();
      await new Promise((resolve) => setTimeout(resolve, 10));
      return finalMessage('one reply');
    },
  };
  const eventHub = new EventHub();
  const processor = createTurnProcessor({ store, answerService, eventHub });
  const first = createDispatcher({ store, processTurn: processor.processTurn, workerId: 'dispatcher-a', pollIntervalMs: 5, leaseDurationMs: 1000, renewalIntervalMs: 100 });
  const second = createDispatcher({ store, processTurn: processor.processTurn, workerId: 'dispatcher-b', pollIntervalMs: 5, leaseDurationMs: 1000, renewalIntervalMs: 100 });
  first.start();
  second.start();
  t.after(async () => { await first.stop(); await second.stop(); eventHub.close(); });

  const deadline = Date.now() + 2000;
  let delivered = [];
  while (Date.now() < deadline) {
    delivered = (await store.listMessages({ sessionId: owner.session.id, conversationId: owner.conversation.id, after: 0 })).filter((message) => message.role === 'assistant');
    if (delivered.length === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].text, 'one reply');
  assert.equal(answerCalls, 1);
});

test('turn api one dispatcher progresses another conversation and stop aborts every active lane', async (t) => {
  const { store } = await createStore(t);
  const blockedOwner = await createOwnedConversation(store, 'blocked-lane');
  const quickOwner = await createOwnedConversation(store, 'quick-lane');
  await accept(store, blockedOwner, '71000000-0000-4000-8000-000000000000', 'blocked conversation A', '2026-08-25T00:00:01.000Z');
  await accept(store, quickOwner, '72000000-0000-4000-8000-000000000000', 'quick conversation B', '2026-08-25T00:00:02.000Z');
  let blockedStartedResolve;
  const blockedStarted = new Promise((resolve) => { blockedStartedResolve = resolve; });
  let releaseBlocked;
  const blockedRelease = new Promise((resolve) => { releaseBlocked = resolve; });
  let blockedAborted = false;
  const answerService = {
    async answer({ text, beforeProvider, signal }) {
      await beforeProvider();
      if (text.includes('blocked')) {
        blockedStartedResolve();
        await Promise.race([
          blockedRelease,
          new Promise((resolve) => signal.addEventListener('abort', () => { blockedAborted = true; resolve(); }, { once: true })),
        ]);
      }
      return finalMessage(`reply to ${text}`);
    },
  };
  const processor = createTurnProcessor({ store, answerService, eventHub: new EventHub() });
  const dispatcher = createDispatcher({
    store,
    processTurn: processor.processTurn,
    workerId: 'multi-lane',
    concurrency: 2,
    pollIntervalMs: 5,
    leaseDurationMs: 1_000,
    renewalIntervalMs: 100,
  });
  dispatcher.start();
  t.after(async () => { releaseBlocked(); await dispatcher.stop(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('blocked lane did not start answering')), 2000);
    blockedStarted.then(() => {
      clearTimeout(timer);
      resolve();
    }, reject);
  });
  const deadline = Date.now() + 500;
  let quickDelivered = false;
  while (Date.now() < deadline) {
    const messages = await store.listMessages({ sessionId: quickOwner.session.id, conversationId: quickOwner.conversation.id, after: 0 });
    quickDelivered = messages.some((message) => message.role === 'assistant');
    if (quickDelivered) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(quickDelivered, true);
  await dispatcher.stop();
  assert.equal(blockedAborted, true);
});

test('turn api dispatcher default concurrency is bounded at four independent turns', async (t) => {
  const { store } = await createStore(t);
  const owners = [];
  for (let index = 0; index < 6; index += 1) {
    const owner = await createOwnedConversation(store, `bounded-${index}`);
    owners.push(owner);
    await accept(
      store,
      owner,
      `76000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      `bounded ${index}`,
      new Date(Date.parse('2026-08-25T00:00:01.000Z') + index),
    );
  }
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let active = 0;
  let maxActive = 0;
  const startedSignals = new Set();
  const answerService = {
    async answer({ beforeProvider, signal }) {
      await beforeProvider();
      active += 1;
      maxActive = Math.max(maxActive, active);
      startedSignals.add(signal);
      await gate;
      active -= 1;
      return finalMessage('bounded reply');
    },
  };
  const processor = createTurnProcessor({ store, answerService, eventHub: new EventHub() });
  const dispatcher = createDispatcher({
    store,
    processTurn: processor.processTurn,
    workerId: 'default-bounded',
    pollIntervalMs: 5,
    leaseDurationMs: 1_000,
    renewalIntervalMs: 100,
  });
  dispatcher.start();
  t.after(async () => { release(); await dispatcher.stop(); });
  const deadline = Date.now() + 500;
  while (startedSignals.size < 4 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(startedSignals.size, 4);
  assert.equal(maxActive, 4);
  release();
  const deliveredDeadline = Date.now() + 1_000;
  let delivered = 0;
  while (Date.now() < deliveredDeadline) {
    delivered = 0;
    for (const owner of owners) {
      const messages = await store.listMessages({ sessionId: owner.session.id, conversationId: owner.conversation.id, after: 0 });
      delivered += messages.filter((message) => message.role === 'assistant').length;
    }
    if (delivered === 6) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(delivered, 6);
  await dispatcher.stop();
});

test('turn api processes two accepted messages in order and duplicate client IDs create one assistant reply', async (t) => {
  const { store } = await createStore(t);
  const owner = await createOwnedConversation(store);
  const first = await accept(store, owner, '11111111-1111-4111-8111-111111111111', 'first user', '2026-08-25T00:00:01.000Z');
  const duplicate = await store.acceptMessage({
    sessionId: owner.session.id, conversationId: owner.conversation.id,
    clientMessageId: '11111111-1111-4111-8111-111111111111', requestHash: 'hash-11111111-1111-4111-8111-111111111111',
    text: 'first user', now: '2026-08-25T00:00:01.500Z',
  });
  const second = await accept(store, owner, '22222222-2222-4222-8222-222222222222', 'second user', '2026-08-25T00:00:02.000Z');
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.turn.id, first.turn.id);

  const answerService = {
    async answer({ text, beforeProvider }) {
      await beforeProvider();
      return finalMessage(`reply to ${text}`);
    },
  };
  const processor = createTurnProcessor({ store, answerService, eventHub: new EventHub() });
  const dispatcher = createDispatcher({ store, processTurn: processor.processTurn, workerId: 'ordered-worker', leaseDurationMs: 1000, renewalIntervalMs: 100 });
  assert.equal(await dispatcher.runOnce(), true);
  assert.equal(await dispatcher.runOnce(), true);
  assert.equal(await dispatcher.runOnce(), false);
  const messages = await store.listMessages({ sessionId: owner.session.id, conversationId: owner.conversation.id, after: 0 });
  assert.deepEqual(messages.map((message) => [message.role, message.text, message.turnId]), [
    ['user', 'first user', first.turn.id],
    ['user', 'second user', second.turn.id],
    ['assistant', 'reply to first user', first.turn.id],
    ['assistant', 'reply to second user', second.turn.id],
  ]);
  assert.equal(messages.filter((message) => message.role === 'assistant' && message.turnId === first.turn.id).length, 1);
});

test('turn api restart recovery can reclaim accepted, retrieving, and generating states once', async (t) => {
  const { store } = await createStore(t);
  const owners = await Promise.all(['accepted', 'retrieving', 'generating'].map((name) => createOwnedConversation(store, name)));
  const turns = [];
  for (let index = 0; index < owners.length; index += 1) {
    turns.push((await accept(store, owners[index], `${index + 1}0000000-0000-4000-8000-000000000000`, `state ${index}`, new Date(Date.parse('2026-08-25T00:00:01.000Z') + index))).turn);
  }
  const base = Date.parse('2026-08-25T00:01:00.000Z');
  const retrieving = await store.claimNextTurn(lease('old-retrieving', 'old-r', base, 5));
  await store.setTurnState({ turnId: retrieving.id, leaseToken: 'old-r', state: 'retrieving', now: new Date(base + 1) });
  const generating = await store.claimNextTurn(lease('old-generating', 'old-g', base, 5));
  await store.setTurnState({ turnId: generating.id, leaseToken: 'old-g', state: 'retrieving', now: new Date(base + 1) });
  await store.setTurnState({ turnId: generating.id, leaseToken: 'old-g', state: 'generating', now: new Date(base + 2) });

  const reclaimed = [];
  for (let index = 0; index < 3; index += 1) {
    reclaimed.push(await store.claimNextTurn(lease(`new-${index}`, `new-token-${index}`, base + 6)));
  }
  assert.deepEqual(new Set(reclaimed.map((turn) => turn.id)), new Set(turns.map((turn) => turn.id)));
  assert.equal(reclaimed.filter((turn) => turn.attempt === 2).length, 2);
  assert.equal(reclaimed.filter((turn) => turn.attempt === 1).length, 1);
  assert.equal(await store.claimNextTurn(lease('extra', 'extra-token', base + 6)), null);
});

test('turn api recovery keeps durable state events monotonic and same-state transitions are no-change', async (t) => {
  const { store } = await createStore(t);
  const owner = await createOwnedConversation(store, 'monotonic');
  const accepted = await accept(store, owner, '73000000-0000-4000-8000-000000000000', 'recover generating', '2026-08-25T00:00:01.000Z');
  const base = Date.parse('2026-08-25T00:01:00.000Z');
  await store.claimNextTurn(lease('old-worker', 'old-token', base, 10));
  await assert.rejects(
    store.setTurnState({ turnId: accepted.turn.id, leaseToken: 'old-token', state: 'generating', now: new Date(base + 1) }),
    (error) => error.code === 'INVALID_TURN_TRANSITION',
  );
  const retrieving = await store.setTurnState({ turnId: accepted.turn.id, leaseToken: 'old-token', state: 'retrieving', now: new Date(base + 1) });
  const duplicate = await store.setTurnState({ turnId: accepted.turn.id, leaseToken: 'old-token', state: 'retrieving', now: new Date(base + 2) });
  assert.equal(retrieving.changed, true);
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.event, null);
  await store.setTurnState({ turnId: accepted.turn.id, leaseToken: 'old-token', state: 'generating', now: new Date(base + 3) });
  const duplicateGenerating = await store.setTurnState({ turnId: accepted.turn.id, leaseToken: 'old-token', state: 'generating', now: new Date(base + 3) });
  assert.equal(duplicateGenerating.changed, false);
  assert.equal(duplicateGenerating.event, null);
  await assert.rejects(
    store.setTurnState({ turnId: accepted.turn.id, leaseToken: 'old-token', state: 'retrieving', now: new Date(base + 4) }),
    (error) => error.code === 'INVALID_TURN_TRANSITION',
  );
  const reclaimed = await store.claimNextTurn(lease('new-worker', 'new-token', base + 11));
  assert.equal(reclaimed.state, 'generating');
  const processor = createTurnProcessor({
    store,
    eventHub: new EventHub(),
    answerService: {
      async answer({ beforeProvider }) {
        await beforeProvider();
        return finalMessage('recovered once');
      },
    },
    now: () => new Date(base + 12),
  });
  const result = await processor.processTurn({ turn: reclaimed, leaseToken: 'new-token', signal: new AbortController().signal });
  assert.equal(result.delivered, true);
  const events = await store.listEvents({ sessionId: owner.session.id, conversationId: owner.conversation.id, afterCursor: 0 });
  assert.deepEqual(events.map((event) => [event.type, event.payloadJson.state ?? null]), [
    ['message.accepted', null],
    ['turn.state', 'retrieving'],
    ['turn.state', 'generating'],
    ['message.delivered', null],
  ]);
});

test('turn api reclaimed retrieving resumes without duplicating its durable state event', async (t) => {
  const { store } = await createStore(t);
  const owner = await createOwnedConversation(store, 'reclaimed-retrieving');
  const accepted = await accept(store, owner, '73100000-0000-4000-8000-000000000000', 'recover retrieving', '2026-08-25T00:00:01.000Z');
  const base = Date.parse('2026-08-25T00:01:00.000Z');
  await store.claimNextTurn(lease('retrieving-old', 'retrieving-old-token', base, 10));
  await store.setTurnState({ turnId: accepted.turn.id, leaseToken: 'retrieving-old-token', state: 'retrieving', now: new Date(base + 1) });
  const reclaimed = await store.claimNextTurn(lease('retrieving-new', 'retrieving-new-token', base + 11));
  const processor = createTurnProcessor({
    store,
    eventHub: new EventHub(),
    answerService: {
      async answer({ beforeProvider }) {
        await beforeProvider();
        return finalMessage('retrieving recovered');
      },
    },
    now: () => new Date(base + 12),
  });
  const result = await processor.processTurn({ turn: reclaimed, leaseToken: 'retrieving-new-token', signal: new AbortController().signal });
  assert.equal(result.delivered, true);
  const events = await store.listEvents({ sessionId: owner.session.id, conversationId: owner.conversation.id, afterCursor: 0 });
  assert.deepEqual(events.map((event) => [event.type, event.payloadJson.state ?? null]), [
    ['message.accepted', null],
    ['turn.state', 'retrieving'],
    ['turn.state', 'generating'],
    ['message.delivered', null],
  ]);
});

test('turn api persists generating once before delivering an answer that bypasses the provider callback', async (t) => {
  const { store } = await createStore(t);
  const owner = await createOwnedConversation(store, 'provider-bypass');
  const accepted = await accept(store, owner, '77000000-0000-4000-8000-000000000000', 'local safety answer', '2026-08-25T00:00:01.000Z');
  const base = Date.parse('2026-08-25T00:01:00.000Z');
  const claimed = await store.claimNextTurn(lease('bypass-worker', 'bypass-token', base));
  const processor = createTurnProcessor({
    store,
    eventHub: new EventHub(),
    answerService: { async answer() { return finalMessage('local deterministic answer'); } },
    now: () => new Date(base + 1),
  });
  const result = await processor.processTurn({ turn: claimed, leaseToken: 'bypass-token', signal: new AbortController().signal });
  assert.equal(result.delivered, true);
  const events = await store.listEvents({ sessionId: owner.session.id, conversationId: owner.conversation.id, afterCursor: 0 });
  assert.deepEqual(events.map((event) => [event.type, event.payloadJson.state ?? null]), [
    ['message.accepted', null],
    ['turn.state', 'retrieving'],
    ['turn.state', 'generating'],
    ['message.delivered', null],
  ]);
  assert.equal(events.at(-1).turnId, accepted.turn.id);
});

test('turn processor owns reply preferences from the claimed turn and prepares voice only after text delivery', async (t) => {
  const { store } = await createStore(t);
  const owner = await createOwnedConversation(store, 'immutable-preferences');
  const accepted = await store.acceptMessage({
    sessionId: owner.session.id,
    conversationId: owner.conversation.id,
    clientMessageId: '78000000-0000-4000-8000-000000000000',
    requestHash: 'immutable-preferences-hash',
    text: 'Answer in Cantonese',
    replyLanguage: 'yue-Hant-HK',
    replyMode: 'voice',
    now: '2026-08-25T00:00:01.000Z',
  });
  const base = Date.parse('2026-08-25T00:01:00.000Z');
  const claimed = await store.claimNextTurn(lease('preference-worker', 'preference-token', base));
  const calls = [];
  const processor = createTurnProcessor({
    store,
    eventHub: new EventHub(),
    answerService: {
      async answer(input) {
        calls.push({ type: 'answer', replyLanguage: input.replyLanguage, replyMode: input.replyMode });
        return finalMessage('先交付文字答案');
      },
    },
    voiceService: {
      prepareAssistantAudio(input) { calls.push({ type: 'voice', ...input }); }
    },
    voiceOutputGate: () => undefined,
    now: () => new Date(base + 1),
  });
  const result = await processor.processTurn({ turn: claimed, leaseToken: 'preference-token', signal: new AbortController().signal });
  assert.equal(result.delivered, true);
  assert.deepEqual(calls, [
    { type: 'answer', replyLanguage: 'yue-Hant-HK', replyMode: 'voice' },
    { type: 'voice', sessionId: owner.session.id, messageId: result.message.id, replyLanguage: 'yue-Hant-HK' },
  ]);
  assert.equal(result.message.text, '先交付文字答案');
  assert.equal(result.message.replyLanguage, 'yue-Hant-HK');
  assert.equal(result.message.replyMode, 'voice');
  assert.equal(accepted.turn.replyLanguage, 'yue-Hant-HK');
});

test('automatic voice preparation fails closed when release evidence does not verify voice output', async (t) => {
  const { store } = await createStore(t);
  const owner = await createOwnedConversation(store, 'unverified-voice-output');
  await store.acceptMessage({
    sessionId: owner.session.id,
    conversationId: owner.conversation.id,
    clientMessageId: '78010000-0000-4000-8000-000000000000',
    requestHash: 'unverified-voice-output-hash',
    text: 'Deliver text but do not expose it to unverified TTS',
    replyLanguage: 'en',
    replyMode: 'voice',
    now: '2026-08-25T00:00:01.000Z',
  });
  const base = Date.parse('2026-08-25T00:01:00.000Z');
  const claimed = await store.claimNextTurn(lease('unverified-worker', 'unverified-token', base));
  let voiceCalls = 0;
  const processor = createTurnProcessor({
    store,
    eventHub: new EventHub(),
    answerService: { async answer() { return finalMessage('Grounded text remains delivered.'); } },
    voiceOutputGate() {
      throw Object.assign(new Error('unverified'), { code: 'VOICE_NOT_RELEASE_VERIFIED' });
    },
    voiceService: { prepareAssistantAudio() { voiceCalls += 1; } },
    now: () => new Date(base + 1),
  });

  const result = await processor.processTurn({ turn: claimed, leaseToken: 'unverified-token', signal: new AbortController().signal });
  assert.equal(result.delivered, true);
  assert.equal(result.message.text, 'Grounded text remains delivered.');
  assert.equal(voiceCalls, 0);
});

test('voice locale mapping is explicit and asynchronous TTS failure cannot revoke delivered text', async (t) => {
  assert.deepEqual(
    ['en', 'yue-Hant-HK', 'cmn-Hans-CN'].map(providerResponseLanguage),
    ['en', 'yue-Hant-HK', 'cmn-Hans-CN'],
  );
  assert.throws(() => providerResponseLanguage('fr'), (error) => error.code === 'VOICE_SYNTHESIS_REJECTED');

  const { store } = await createStore(t);
  const owner = await createOwnedConversation(store, 'async-tts-failure');
  await store.acceptMessage({
    sessionId: owner.session.id,
    conversationId: owner.conversation.id,
    clientMessageId: '78100000-0000-4000-8000-000000000000',
    requestHash: 'async-tts-failure-hash',
    text: 'Keep the text even if audio fails',
    replyLanguage: 'en',
    replyMode: 'voice',
    now: '2026-08-25T00:00:01.000Z',
  });
  const base = Date.parse('2026-08-25T00:01:00.000Z');
  const claimed = await store.claimNextTurn(lease('async-tts-worker', 'async-tts-token', base));
  const processor = createTurnProcessor({
    store,
    eventHub: new EventHub(),
    answerService: { async answer() { return finalMessage('Grounded text survives.'); } },
    voiceService: {
      async prepareAssistantAudio() {
        throw Object.assign(new Error('private tts failure'), { code: 'VOICE_SYNTHESIS_REJECTED' });
      },
    },
    voiceOutputGate: () => undefined,
    now: () => new Date(base + 1),
  });
  const result = await processor.processTurn({ turn: claimed, leaseToken: 'async-tts-token', signal: new AbortController().signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.delivered, true);
  assert.equal(result.message.text, 'Grounded text survives.');
});

test('turn api renewal loss aborts provider work and session deletion cannot be undone', async (t) => {
  const { store } = await createStore(t);
  const owner = await createOwnedConversation(store);
  await accept(store, owner, '11111111-1111-4111-8111-111111111111', 'delete during work', '2026-08-25T00:00:01.000Z');
  let observedAbort = false;
  let signalProviderStarted;
  const providerStarted = new Promise((resolve) => { signalProviderStarted = resolve; });
  const answerService = {
    async answer({ beforeProvider, signal }) {
      await beforeProvider();
      await new Promise((resolve) => {
        signal.addEventListener('abort', () => { observedAbort = true; resolve(); }, { once: true });
        signalProviderStarted();
        setTimeout(resolve, 500);
      });
      return finalMessage('must never deliver');
    },
  };
  const processor = createTurnProcessor({ store, answerService, eventHub: new EventHub() });
  const dispatcher = createDispatcher({ store, processTurn: processor.processTurn, workerId: 'dispatcher', leaseDurationMs: 30, renewalIntervalMs: 10, pollIntervalMs: 1000 });
  const running = dispatcher.runOnce();
  await providerStarted;
  await store.deleteSession({ sessionId: owner.session.id });
  await running;
  assert.equal(observedAbort, true);
  assert.equal(await store.getSessionByTokenHash('token-one'), null);
});

async function startSseApp(t, configOverrides = {}) {
  const { store } = await createStore(t);
  const eventHub = new EventHub();
  const config = loadConfig({ NODE_ENV: 'test', V1_PUBLIC_ORIGIN: ORIGIN, V1_SESSION_SECRET: 'x'.repeat(32), ...configOverrides });
  const app = createApp({ config, store, eventHub });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    eventHub.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const createdResponse = await fetch(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: ORIGIN } });
  const created = await createdResponse.json();
  const cookie = createdResponse.headers.getSetCookie()[0].split(';')[0];
  return { baseUrl, cookie, store, eventHub, owner: { session: created.data.session, conversation: created.data.conversation } };
}

async function collectSse(response, predicate, timeoutMs = 1000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const timeout = setTimeout(() => reader.cancel(), timeoutMs);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (predicate(text)) break;
    }
  } finally {
    clearTimeout(timeout);
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

test('turn API requires supported wire preferences, returns them safely, and hashes them into idempotency', async (t) => {
  const runtime = await startSseApp(t);
  const post = (body) => fetch(`${runtime.baseUrl}/api/v1/messages`, {
    method: 'POST',
    headers: { Origin: ORIGIN, Cookie: runtime.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const base = {
    clientMessageId: '79000000-0000-4000-8000-000000000000',
    text: 'Use immutable preferences',
  };
  for (const body of [
    base,
    { ...base, replyLanguage: 'fr', replyMode: 'text' },
    { ...base, replyLanguage: 'en', replyMode: 'audio' },
  ]) {
    const response = await post(body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
  }
  const acceptedResponse = await post({ ...base, replyLanguage: 'cmn-Hans-CN', replyMode: 'voice' });
  assert.equal(acceptedResponse.status, 202);
  const accepted = await acceptedResponse.json();
  assert.equal(accepted.data.message.replyLanguage, 'cmn-Hans-CN');
  assert.equal(accepted.data.turn.replyMode, 'voice');
  const conflict = await post({ ...base, replyLanguage: 'en', replyMode: 'voice' });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'IDEMPOTENCY_CONFLICT');
});

function eventIds(stream) {
  return [...stream.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
}

test('turn api SSE replays monotonic durable cursors and Last-Event-ID takes precedence without allowing rewind', async (t) => {
  const runtime = await startSseApp(t, { V1_SSE_HEARTBEAT_MS: '20', V1_SSE_PAGE_SIZE: '2' });
  for (let index = 0; index < 5; index += 1) {
    await accept(runtime.store, runtime.owner, `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`, `message ${index}`, new Date(Date.now() + index));
  }

  const replay = await fetch(`${runtime.baseUrl}/api/v1/events?afterCursor=0`, { headers: { Cookie: runtime.cookie } });
  assert.equal(replay.status, 200);
  const replayText = await collectSse(replay, (text) => eventIds(text).length >= 5);
  assert.deepEqual(eventIds(replayText), [1, 2, 3, 4, 5]);
  assert.match(replayText, /^retry: 3000$/m);

  const reconnect = await fetch(`${runtime.baseUrl}/api/v1/events?afterCursor=0`, { headers: { Cookie: runtime.cookie, 'Last-Event-ID': '4' } });
  const reconnectText = await collectSse(reconnect, (text) => eventIds(text).length >= 1);
  assert.deepEqual(eventIds(reconnectText), [5]);

  const rewind = await fetch(`${runtime.baseUrl}/api/v1/events?afterCursor=5`, { headers: { Cookie: runtime.cookie, 'Last-Event-ID': '4' } });
  assert.equal(rewind.status, 400);
  assert.equal((await rewind.json()).error.code, 'INVALID_EVENT_CURSOR');
});

test('turn api SSE drains multi-page replay plus replay-race events exactly once and notifications never become payload truth', async (t) => {
  const runtime = await startSseApp(t, { V1_SSE_PAGE_SIZE: '2', V1_SSE_HEARTBEAT_MS: '20' });
  for (let index = 0; index < 5; index += 1) {
    await accept(runtime.store, runtime.owner, `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`, `message ${index}`, new Date(Date.now() + index));
  }
  const originalPage = runtime.store.listEventsPage.bind(runtime.store);
  let injected = false;
  runtime.store.listEventsPage = async (input) => {
    const page = await originalPage(input);
    if (!injected) {
      injected = true;
      const late = await accept(runtime.store, runtime.owner, '29999999-9999-4999-8999-999999999999', 'arrived during replay', new Date());
      runtime.eventHub.publish({ sessionId: runtime.owner.session.id, conversationId: runtime.owner.conversation.id, cursor: late.event.cursor, payloadJson: { forged: 'must-not-stream' } });
      runtime.eventHub.publish({ sessionId: runtime.owner.session.id, conversationId: runtime.owner.conversation.id, cursor: 2 });
      runtime.eventHub.publish({ sessionId: runtime.owner.session.id, conversationId: runtime.owner.conversation.id, cursor: late.event.cursor });
    }
    return page;
  };
  const response = await fetch(`${runtime.baseUrl}/api/v1/events?afterCursor=0`, { headers: { Cookie: runtime.cookie } });
  const stream = await collectSse(response, (text) => eventIds(text).includes(6));
  assert.deepEqual(eventIds(stream), [1, 2, 3, 4, 5, 6]);
  assert.equal(stream.includes('must-not-stream'), false);
});

test('turn api SSE replays delivery and terminal failure with stable safe payloads only', async (t) => {
  const runtime = await startSseApp(t, { V1_SSE_PAGE_SIZE: '2' });
  const first = await accept(runtime.store, runtime.owner, '25000000-0000-4000-8000-000000000000', 'deliver', new Date());
  const second = await accept(runtime.store, runtime.owner, '26000000-0000-4000-8000-000000000000', 'fail', new Date(Date.now() + 1));
  const base = Date.now() + 100;
  await runtime.store.claimNextTurn(lease('delivery-worker', 'delivery-token', base));
  await runtime.store.setTurnState({ turnId: first.turn.id, leaseToken: 'delivery-token', state: 'retrieving', now: new Date(base + 1) });
  await runtime.store.setTurnState({ turnId: first.turn.id, leaseToken: 'delivery-token', state: 'generating', now: new Date(base + 2) });
  await runtime.store.deliverAssistant({ turnId: first.turn.id, leaseToken: 'delivery-token', message: finalMessage(), now: new Date(base + 3) });
  await runtime.store.claimNextTurn(lease('failure-worker', 'failure-token', base + 4));
  await runtime.store.setTurnState({ turnId: second.turn.id, leaseToken: 'failure-token', state: 'retrieving', now: new Date(base + 5) });
  await runtime.store.failTurn({ turnId: second.turn.id, leaseToken: 'failure-token', failureCode: 'PROVIDER_TIMEOUT', now: new Date(base + 6) });
  const highWater = await runtime.store.getEventHighWater({ sessionId: runtime.owner.session.id, conversationId: runtime.owner.conversation.id });
  const response = await fetch(`${runtime.baseUrl}/api/v1/events?afterCursor=0`, { headers: { Cookie: runtime.cookie } });
  const stream = await collectSse(response, (text) => eventIds(text).includes(highWater));
  assert.match(stream, /event: message\.delivered/);
  assert.match(stream, /event: turn\.failed/);
  assert.match(stream, /"failureCode":"PROVIDER_TIMEOUT"/);
  assert.equal(stream.includes('delivery-token'), false);
  assert.equal(stream.includes('failure-token'), false);
  assert.equal(stream.includes('requestHash'), false);
});

test('turn api SSE overflow emits resync_required without id and reconnect drains durable truth', async (t) => {
  const runtime = await startSseApp(t, { V1_SSE_BUFFER_SIZE: '2', V1_SSE_PAGE_SIZE: '2', V1_SSE_HEARTBEAT_MS: '20' });
  const originalHighWater = runtime.store.getEventHighWater.bind(runtime.store);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  runtime.store.getEventHighWater = async (input) => { await gate; return originalHighWater(input); };
  const responsePromise = fetch(`${runtime.baseUrl}/api/v1/events?afterCursor=0`, { headers: { Cookie: runtime.cookie } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  runtime.eventHub.publish({ conversationId: runtime.owner.conversation.id, cursor: 1 });
  runtime.eventHub.publish({ conversationId: runtime.owner.conversation.id, cursor: 2 });
  runtime.eventHub.publish({ conversationId: runtime.owner.conversation.id, cursor: 3 });
  release();
  const response = await responsePromise;
  const overflow = await collectSse(response, (text) => text.includes('resync_required'));
  const block = overflow.split('\n\n').find((part) => part.includes('resync_required'));
  assert.match(block, /event: resync_required/);
  assert.doesNotMatch(block, /^id:/m);

  runtime.store.getEventHighWater = originalHighWater;
  for (let index = 0; index < 3; index += 1) {
    await accept(runtime.store, runtime.owner, `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`, `durable ${index}`, new Date(Date.now() + index));
  }
  const reconnect = await fetch(`${runtime.baseUrl}/api/v1/events?afterCursor=0`, { headers: { Cookie: runtime.cookie } });
  const replay = await collectSse(reconnect, (text) => eventIds(text).length >= 3);
  assert.deepEqual(eventIds(replay), [1, 2, 3]);
});

test('turn api SSE bounds unique live notifications while a durable drain is slow', async (t) => {
  const runtime = await startSseApp(t, { V1_SSE_BUFFER_SIZE: '2', V1_SSE_HEARTBEAT_MS: '1000' });
  const response = await fetch(`${runtime.baseUrl}/api/v1/events?afterCursor=0`, { headers: { Cookie: runtime.cookie } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const originalHighWater = runtime.store.getEventHighWater.bind(runtime.store);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  runtime.store.getEventHighWater = async (input) => { await gate; return originalHighWater(input); };
  for (const cursor of [1, 2, 3, 4]) runtime.eventHub.publish({ conversationId: runtime.owner.conversation.id, cursor });
  release();
  const stream = await collectSse(response, (text) => text.includes('resync_required'));
  const resync = stream.split('\n\n').find((part) => part.includes('resync_required'));
  assert.ok(resync);
  assert.doesNotMatch(resync, /^id:/m);
});

test('turn api SSE heartbeat has no cursor and session deletion cleans listeners', async (t) => {
  const runtime = await startSseApp(t, { V1_SSE_HEARTBEAT_MS: '20' });
  const response = await fetch(`${runtime.baseUrl}/api/v1/events?afterCursor=0`, { headers: { Cookie: runtime.cookie } });
  const stream = await collectSse(response, (text) => text.includes(': heartbeat'));
  const heartbeatBlock = stream.split('\n\n').find((part) => part.includes(': heartbeat'));
  assert.doesNotMatch(heartbeatBlock, /^id:/m);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runtime.eventHub.listenerCount(runtime.owner.conversation.id), 0);

  const live = await fetch(`${runtime.baseUrl}/api/v1/events?afterCursor=0`, { headers: { Cookie: runtime.cookie } });
  assert.equal(runtime.eventHub.listenerCount(runtime.owner.conversation.id), 1);
  const deleted = await fetch(`${runtime.baseUrl}/api/v1/session`, { method: 'DELETE', headers: { Origin: ORIGIN, Cookie: runtime.cookie } });
  assert.equal(deleted.status, 200);
  await collectSse(live, () => false, 100);
  assert.equal(runtime.eventHub.listenerCount(runtime.owner.conversation.id), 0);
});

test('turn api SSE heartbeat recovers a persisted-before-publish event on an already-live stream', async (t) => {
  const runtime = await startSseApp(t, { V1_SSE_HEARTBEAT_MS: '20' });
  const response = await fetch(`${runtime.baseUrl}/api/v1/events?afterCursor=0`, { headers: { Cookie: runtime.cookie } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await accept(runtime.store, runtime.owner, '40000000-0000-4000-8000-000000000000', 'persisted with missed publish', new Date());
  const stream = await collectSse(response, (text) => eventIds(text).includes(1));
  assert.deepEqual(eventIds(stream), [1]);
});

test('turn api SSE closes for replay on socket backpressure and emits resync_required without a cursor', async (t) => {
  const { store } = await createStore(t);
  const owner = await createOwnedConversation(store, 'backpressure');
  await accept(store, owner, '50000000-0000-4000-8000-000000000000', 'backpressure', new Date());
  const eventHub = new EventHub();
  const request = new EventEmitter();
  request.query = { afterCursor: '0' };
  request.get = () => undefined;
  const response = new EventEmitter();
  response.locals = { requestId: 'request-1' };
  response.writableEnded = false;
  response.destroyed = false;
  response.status = () => response;
  response.set = () => response;
  response.flushHeaders = () => {};
  const writes = [];
  response.write = (value) => {
    writes.push(value);
    return writes.length !== 2;
  };
  response.end = () => {
    response.writableEnded = true;
    response.emit('close');
  };
  const handler = createEventStreamHandler({ store, eventHub, resolveSession: async () => owner, pageSize: 2, bufferSize: 2, heartbeatMs: 20 });
  await handler(request, response);
  const deadline = Date.now() + 500;
  while (!response.writableEnded && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(response.writableEnded, true);
  const resync = writes.find((value) => value.includes('resync_required'));
  assert.ok(resync);
  assert.doesNotMatch(resync, /^id:/m);
  assert.equal(eventHub.listenerCount(owner.conversation.id), 0);
});

test('turn api SSE rejects empty, nonconsecutive, and duplicate durable pages without entering live mode', async () => {
  const cases = [
    ['empty page below high-water', []],
    ['gap', [2, 3]],
    ['duplicate', [1, 1, 2, 3]],
  ];
  for (const [name, cursors] of cases) {
    const eventHub = new EventHub();
    const owner = { session: { id: `session-${name}` }, conversation: { id: `conversation-${name}` } };
    let pageCalls = 0;
    const store = {
      async getEventHighWater() { return 3; },
      async listEventsPage() {
        pageCalls += 1;
        if (pageCalls > 1) return [];
        return cursors.map((cursor) => ({ cursor, type: 'turn.state', payloadJson: { cursor } }));
      },
    };
    const request = new EventEmitter();
    request.query = { afterCursor: '0' };
    request.get = () => undefined;
    const response = new EventEmitter();
    response.locals = { requestId: `request-${name}` };
    response.writableEnded = false;
    response.destroyed = false;
    response.status = () => response;
    response.set = () => response;
    response.flushHeaders = () => {};
    const writes = [];
    response.write = (value) => { writes.push(value); return true; };
    response.end = () => {
      if (response.writableEnded) return;
      response.writableEnded = true;
      response.emit('close');
    };
    const handler = createEventStreamHandler({ store, eventHub, resolveSession: async () => owner, pageSize: 10, bufferSize: 10, heartbeatMs: 10 });
    await handler(request, response);
    const forcedClose = setTimeout(() => request.emit('close'), 60);
    while (!response.writableEnded) await new Promise((resolve) => setTimeout(resolve, 5));
    clearTimeout(forcedClose);
    const rendered = writes.join('');
    const resync = rendered.split('\n\n').find((block) => block.includes('resync_required'));
    assert.ok(resync, name);
    assert.doesNotMatch(resync, /^id:/m, name);
    assert.equal(rendered.includes(': heartbeat'), false, name);
    assert.equal(eventHub.listenerCount(owner.conversation.id), 0, name);
  }
});

test('turn api SSE resyncs when query or Last-Event-ID is ahead of durable high-water', async () => {
  const cases = [
    ['query high-water plus one', { query: '4', header: undefined }],
    ['Last-Event-ID far ahead', { query: '0', header: '999' }],
  ];
  for (const [name, cursor] of cases) {
    const eventHub = new EventHub();
    const owner = { session: { id: `session-${name}` }, conversation: { id: `conversation-${name}` } };
    const store = {
      async getEventHighWater() { return 3; },
      async listEventsPage() { throw new Error('ahead cursor must fail before page drain'); },
    };
    const request = new EventEmitter();
    request.query = { afterCursor: cursor.query };
    request.get = (headerName) => (headerName === 'Last-Event-ID' ? cursor.header : undefined);
    const response = new EventEmitter();
    response.locals = { requestId: `request-${name}` };
    response.writableEnded = false;
    response.destroyed = false;
    response.status = () => response;
    response.set = () => response;
    response.flushHeaders = () => {};
    const writes = [];
    response.write = (value) => { writes.push(value); return true; };
    response.end = () => {
      if (response.writableEnded) return;
      response.writableEnded = true;
      response.emit('close');
    };
    const handler = createEventStreamHandler({ store, eventHub, resolveSession: async () => owner, pageSize: 10, bufferSize: 10, heartbeatMs: 10 });
    await handler(request, response);
    const deadline = Date.now() + 80;
    while (!response.writableEnded && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    if (!response.writableEnded) request.emit('close');
    const rendered = writes.join('');
    const resync = rendered.split('\n\n').find((block) => block.includes('resync_required'));
    assert.ok(resync, name);
    assert.doesNotMatch(resync, /^id:/m, name);
    assert.equal(rendered.includes(': heartbeat'), false, name);
    assert.equal(response.writableEnded, true, name);
    assert.equal(eventHub.listenerCount(owner.conversation.id), 0, name);
  }
});

test('turn api real server shutdown is idempotent and closes SSE while aborting blocked provider work', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-shutdown-'));
  const environment = {
    NODE_ENV: 'test',
    PORT: '0',
    V1_PUBLIC_ORIGIN: ORIGIN,
    V1_SESSION_SECRET: 's'.repeat(32),
    V1_ATOMIC_FILE_PATH: join(directory, 'store.json'),
    V1_LOCAL_MEDIA_PATH: join(directory, 'media'),
    V1_LLM_PROVIDER: 'deterministic',
    V1_SSE_HEARTBEAT_MS: '1000',
  };
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  let providerStartedResolve;
  const providerStarted = new Promise((resolve) => { providerStartedResolve = resolve; });
  let providerAborted = false;
  const blockedProvider = {
    provider: 'blocked-test-provider',
    async generate({ signal }) {
      providerStartedResolve();
      await new Promise((resolve) => {
        if (signal.aborted) { providerAborted = true; resolve(); return; }
        signal.addEventListener('abort', () => { providerAborted = true; resolve(); }, { once: true });
      });
      throw Object.assign(new Error('aborted'), { code: 'PROVIDER_TIMEOUT' });
    },
  };
  const voiceRuntimeLifecycle = [];
  const mediaStore = {
    init: async () => { voiceRuntimeLifecycle.push('media:init'); },
    close: async () => { voiceRuntimeLifecycle.push('media:close'); },
    createAttemptKey: () => 'attempts/voice/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  };
  const cleanupService = {
    start: () => { voiceRuntimeLifecycle.push('cleanup:start'); },
    stop: async () => { voiceRuntimeLifecycle.push('cleanup:stop'); },
    drainOnce: async () => ({ idle: true }),
  };
  let server;
  try {
    server = await startServer({
      environment,
      port: 0,
      host: '127.0.0.1',
      llmProvider: blockedProvider,
      mediaStore,
      cleanupService,
      now: () => new Date('2026-08-25T12:00:00+08:00'),
      dispatcherOptions: { concurrency: 2, pollIntervalMs: 5, leaseDurationMs: 1_000, renewalIntervalMs: 100 },
    });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  t.after(async () => {
    if (!server) return;
    if (typeof server.shutdown === 'function') await server.shutdown();
    else {
      server.runtime?.eventHub.close();
      await server.runtime?.dispatcher.stop();
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await server.runtime?.store.close();
    }
  });

  assert.equal(typeof server.shutdown, 'function');
  assert.deepEqual(voiceRuntimeLifecycle, ['media:init', 'cleanup:start']);
  assert.equal(server.runtime.mediaStore, mediaStore);
  assert.equal(server.runtime.cleanupService, cleanupService);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const createdResponse = await fetch(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: ORIGIN } });
  const created = await createdResponse.json();
  const cookie = createdResponse.headers.getSetCookie()[0].split(';')[0];
  const eventsResponse = await fetch(`${baseUrl}/api/v1/events?afterCursor=0`, { headers: { Cookie: cookie } });
  assert.equal(eventsResponse.status, 200);
  assert.equal(server.runtime.eventHub.listenerCount(created.data.conversation.id), 1);
  const acceptedResponse = await fetch(`${baseUrl}/api/v1/messages`, {
    method: 'POST',
    headers: { Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientMessageId: '74000000-0000-4000-8000-000000000000',
      text: 'Duo 换手机怎么办',
      replyLanguage: 'yue-Hant-HK',
      replyMode: 'text',
    }),
  });
  assert.equal(acceptedResponse.status, 202);
  await Promise.race([
    providerStarted,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('blocked provider did not start')), 1_000)),
  ]);
  const firstShutdown = server.shutdown();
  const secondShutdown = server.shutdown();
  assert.equal(firstShutdown, secondShutdown);
  await Promise.race([
    firstShutdown,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('server shutdown timed out')), 1_000)),
  ]);
  assert.equal(providerAborted, true);
  assert.equal(server.listening, false);
  assert.deepEqual(voiceRuntimeLifecycle, ['media:init', 'cleanup:start', 'cleanup:stop', 'media:close']);
  assert.equal(server.runtime.eventHub.listenerCount(created.data.conversation.id), 0);
  await eventsResponse.body.cancel().catch(() => undefined);
});
