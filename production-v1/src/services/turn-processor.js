import { SAFE_TURN_FAILURE_CODES } from '../stores/store-contract.js';

function publish(eventHub, result) {
  if (result?.event) {
    eventHub?.publish({
      sessionId: result.event.sessionId,
      conversationId: result.event.conversationId,
      cursor: result.event.cursor,
    });
  }
}

export function createTurnProcessor({
  store, answerService, tutorService, voiceService, voiceOutputGate, eventHub, acceptanceTimingRecorder,
  now = () => new Date(),
} = {}) {
  if (!store || typeof answerService?.answer !== 'function') throw new Error('turn processor dependencies are required');

  async function processTurn({ turn, leaseToken, signal }) {
    try {
      let state = turn.state;
      if (!['accepted', 'retrieving', 'generating'].includes(state)) {
        throw Object.assign(new Error('LEASE_LOST'), { code: 'LEASE_LOST' });
      }
      const transition = async (nextState) => {
        if (state === nextState) return;
        const result = await store.setTurnState({ turnId: turn.id, leaseToken, state: nextState, now: now() });
        publish(eventHub, result);
        state = result.turn.state;
      };
      if (state === 'accepted') await transition('retrieving');
      const context = await store.getTurnContext({ turnId: turn.id });
      const current = context.messages.at(-1);
      const ensureGenerating = async () => {
        if (state === 'retrieving') await transition('generating');
      };
      const practice = (context.conversation?.kind ?? 'campus') === 'practice';
      const answerer = practice ? tutorService : answerService;
      if (typeof answerer?.answer !== 'function') {
        throw Object.assign(new Error('ANSWER_FAILED'), { code: 'ANSWER_FAILED' });
      }
      const answer = await answerer.answer({
        turnId: turn.id,
        text: current.text,
        replyLanguage: turn.replyLanguage,
        replyMode: turn.replyMode,
        mode: context.conversation?.mode ?? 'teaching',
        scenario: context.conversation?.scenario ?? 'freeConversation',
        context: context.messages,
        signal,
        beforeProvider: async () => {
          if (signal?.aborted) throw Object.assign(new Error('LEASE_LOST'), { code: 'LEASE_LOST' });
          await ensureGenerating();
        },
      });
      if (signal?.aborted) return { leaseLost: true };
      await ensureGenerating();
      const delivered = await store.deliverAssistant({ turnId: turn.id, leaseToken, message: answer, now: now() });
      publish(eventHub, delivered);
      acceptanceTimingRecorder?.completeText?.({
        turnId: turn.id,
        messageId: delivered.message.id,
        providerLatencyMs: answer.provider === 'deterministic' ? null : answer.providerLatencyMs,
      });
      if (turn.replyMode === 'voice') {
        try {
          if (typeof voiceOutputGate !== 'function') {
            throw Object.assign(new Error('VOICE_NOT_RELEASE_VERIFIED'), { code: 'VOICE_NOT_RELEASE_VERIFIED' });
          }
          voiceOutputGate();
          const acceptanceContext = acceptanceTimingRecorder?.beginTts?.(delivered.message.id);
          const preparation = voiceService?.prepareAssistantAudio?.({
            sessionId: turn.sessionId,
            messageId: delivered.message.id,
            replyLanguage: turn.replyLanguage,
            ...(acceptanceContext ? { acceptanceContext } : {}),
          });
          void Promise.resolve(preparation).catch(() => undefined);
        } catch { /* grounded text delivery is terminal even when TTS preparation fails */ }
      }
      return { delivered: true, message: delivered.message };
    } catch (error) {
      if (signal?.aborted || error?.code === 'LEASE_LOST') return { leaseLost: true };
      const failureCode = SAFE_TURN_FAILURE_CODES.has(error?.code) ? error.code : 'ANSWER_FAILED';
      try {
        const failed = await store.failTurn({ turnId: turn.id, leaseToken, failureCode, now: now() });
        publish(eventHub, failed);
        return { failed: true, failureCode };
      } catch (failureError) {
        if (failureError?.code === 'LEASE_LOST') return { leaseLost: true };
        throw failureError;
      }
    }
  }

  return { processTurn };
}
