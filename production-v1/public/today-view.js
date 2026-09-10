import { elderlyVisitPlaybook } from './content/playbooks.js';

export const HABIT_KEY = 'hk-buddy:v1.1:habitState';

function todayStamp(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong' }).format(now);
}

export function readHabitState(storage = globalThis.localStorage) {
  try {
    return JSON.parse(storage.getItem(HABIT_KEY) ?? 'null') ?? { lastPractisedOn: null };
  } catch {
    return { lastPractisedOn: null };
  }
}

export function markHabitPractised({ storage = globalThis.localStorage, now = new Date() } = {}) {
  const state = { lastPractisedOn: todayStamp(now), savedLocally: true };
  try { storage.setItem(HABIT_KEY, JSON.stringify(state)); } catch { /* device-local only */ }
  return state;
}

export function createTodayView({
  greeting,
  habitStatus,
  phraseText,
  storage = globalThis.localStorage,
} = {}) {
  const phrase = elderlyVisitPlaybook.phrases[0];

  function render({ language = 'en' } = {}) {
    if (greeting) {
      greeting.textContent = language === 'yue-Hant-HK'
        ? '今日見到你就好。'
        : language === 'cmn-Hans-CN'
          ? '很高兴今天见到你。'
          : 'Good to see you.';
    }
    const habit = readHabitState(storage);
    if (habitStatus) {
      habitStatus.textContent = habit.lastPractisedOn === todayStamp()
        ? 'Practised today'
        : 'Not practised yet';
    }
    if (phraseText && phrase) {
      phraseText.textContent = `${phrase.cantonese} — ${phrase.english}`;
    }
    return phrase;
  }

  return { render, markHabitPractised, readHabitState, phrase };
}
