import { elderlyVisitPlaybook } from './content/playbooks.js';

export function createPhrasebookView({
  list,
  onPractise,
  onTranslate,
} = {}) {
  function render() {
    if (!list) return elderlyVisitPlaybook;
    list.replaceChildren();
    for (const phrase of elderlyVisitPlaybook.phrases) {
      const card = document.createElement('article');
      card.className = 'phrasebook-card';
      card.innerHTML = '';
      const cantonese = document.createElement('p');
      cantonese.textContent = phrase.cantonese;
      const english = document.createElement('p');
      english.textContent = phrase.english;
      const practise = document.createElement('button');
      practise.type = 'button';
      practise.textContent = 'Practise this';
      practise.addEventListener('click', () => onPractise?.(phrase));
      const translate = document.createElement('button');
      translate.type = 'button';
      translate.textContent = 'Translate with this';
      translate.addEventListener('click', () => onTranslate?.(phrase));
      card.append(cantonese, english, practise, translate);
      list.append(card);
    }
    return elderlyVisitPlaybook;
  }

  return { render, phrases: elderlyVisitPlaybook.phrases };
}
