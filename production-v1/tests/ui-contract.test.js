import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const publicUrl = new URL('../public/', import.meta.url);

async function text(name) {
  return readFile(new URL(name, publicUrl), 'utf8');
}

function relativeLuminance(hex) {
  const channels = hex.match(/[a-f\d]{2}/gi).map((value) => Number.parseInt(value, 16) / 255);
  const linear = channels.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function pngDimensions(buffer) {
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('ui contract exposes one truthful mobile conversation and no legacy workspace', async () => {
  const html = await text('index.html');

  assert.equal((html.match(/<main\b/gi) ?? []).length, 1);
  assert.match(html, /<main[^>]+id="message-list"[^>]+aria-label="Conversation"/i);
  assert.doesNotMatch(html, /<main[^>]+role="log"/i);
  assert.match(html, /id="message-feed"[^>]+role="log"[^>]+aria-live="polite"[^>]+aria-atomic="false"/i);
  assert.match(html, /id="turn-status"[^>]+role="status"[^>]+aria-atomic="true"/i);
  assert.match(html, /<h1>Hong Kong Buddy<\/h1>/);
  assert.match(html, /Campus and Cantonese companion/);
  assert.match(html, /Your HKBU AI senior/);
  assert.match(html, /class="info-button"[^>]*>Info<\/button>/i);
  assert.match(html, /id="assistant-info"/);
  assert.match(html, /not a student or an official HKBU representative/i);
  assert.match(html, /id="clear-session"/);
  assert.match(html, /id="clear-status"[^>]+role="status"[^>]+aria-live="polite"/i);
  assert.match(html, /id="knowledge-snapshot-date"/i);
  assert.match(html, /id="message-template"/);
  assert.match(html, /id="source-template"/);
  assert.match(html, /id="action-card-template"/);
  const campusHtml = html.slice(html.indexOf('id="message-list"'), html.indexOf('id="practice-view"'));
  assert.doesNotMatch(campusHtml, />\s*(?:MODE|SCENARIO|START MISSION|Free Talk|Teaching)\s*</i);
  assert.doesNotMatch(html, /\btyping\b|\bonline\b|\bseen\b|last active|read receipt/i);
  assert.doesNotMatch(html, /aria-label="[^"]*(?:phone call|video call)|data-(?:online|presence|read-receipt)|class="[^"]*(?:online-dot|typing-dots|call-waveform)/i);
});

test('production shell presents the final plain-language privacy and data-use disclosure', async () => {
  const html = await text('index.html');
  assert.doesNotMatch(html, /Draft privacy notice/i);
  assert.match(html, /<h3>Privacy and data use<\/h3>/i);
  for (const disclosure of [
    /Text you send may be processed by the configured AI provider/i,
    /Voice is optional/i,
    /transcript remains editable and unsent until you tap Send/i,
    /Clear conversation[\s\S]{0,120}queue its stored data for deletion/i,
  ]) assert.match(html, disclosure);
});

test('ui contract places one accessible reply selector immediately above the composer panel', async () => {
  const html = await text('index.html');
  const app = await text('app.js');
  const composer = html.slice(html.indexOf('id="composer"'), html.indexOf('</form>', html.indexOf('id="composer"')));
  const triggerIndex = composer.indexOf('id="reply-preferences-trigger"');
  const panelIndex = composer.indexOf('class="composer-panel"');

  assert.ok(triggerIndex >= 0 && panelIndex > triggerIndex);
  assert.match(composer, /id="reply-preferences-trigger"[^>]+aria-controls="reply-preferences"[^>]+aria-expanded="false"/i);
  assert.match(html, /<dialog[^>]+id="reply-preferences"[^>]+aria-labelledby="reply-preferences-title"/i);
  assert.match(html, /<fieldset[\s\S]*?<legend>Reply language<\/legend>[\s\S]*?name="reply-language"[^>]+value="en"[\s\S]*?English[\s\S]*?value="yue-Hant-HK"[\s\S]*?廣東話[\s\S]*?value="cmn-Hans-CN"[\s\S]*?普通話[\s\S]*?<\/fieldset>/i);
  assert.match(html, /<fieldset[\s\S]*?<legend>Reply as<\/legend>[\s\S]*?name="reply-mode"[^>]+value="text"[\s\S]*?Text[\s\S]*?value="voice"[\s\S]*?Voice message[\s\S]*?<\/fieldset>/i);
  assert.match(html, /id="save-reply-preferences"[^>]+type="submit"/i);
  assert.match(html, /id="cancel-reply-preferences"[^>]+type="button"/i);
  assert.match(app, /chatController\.setReplyPreferences\(/);
  assert.ok((app.match(/currentReplyTupleIsFixed\(/g) ?? []).length >= 2);
  assert.match(app, /replyPreferences\.addEventListener\(['"]close['"][\s\S]{0,180}replyPreferencesTrigger\.focus\(\)/i);
});

test('ui contract keeps four starter questions and the composer after the timeline', async () => {
  const html = await text('index.html');
  const prompts = [...html.matchAll(/class="starter-prompt"/g)];
  const promptContracts = [...html.matchAll(/<button[^>]+class="starter-prompt"[^>]+data-prompt="([^"]+)"[^>]*>([^<]+)<\/button>/gi)];
  const timelineIndex = html.indexOf('id="message-list"');
  const statusIndex = html.indexOf('id="turn-status"');
  const composerIndex = html.indexOf('id="composer"');

  assert.equal(prompts.length, 4);
  assert.equal(promptContracts.length, 4);
  for (const [, sentText, visibleText] of promptContracts) {
    assert.equal(visibleText.trim().replace(/\s+/g, ' '), sentText.trim().replace(/\s+/g, ' '));
  }
  assert.ok(timelineIndex >= 0 && statusIndex > timelineIndex && composerIndex > statusIndex);
  assert.match(html, /id="message-input"[^>]+maxlength="4000"/i);
  assert.match(html, /id="voice-button"/i);
  assert.match(html, /id="send-button"[^>]+disabled/i);
});

test('ui contract exposes one consented asynchronous voice-message flow inside the composer', async () => {
  const html = await text('index.html');
  const app = await text('app.js');
  const css = await text('styles.css');

  assert.match(html, /id="voice-draft"[^>]+hidden/i);
  assert.match(html, /id="voice-draft-state"[^>]+role="status"[^>]+aria-live="polite"/i);
  assert.match(html, /id="voice-draft-help"/i);
  assert.match(html, /id="remove-voice-draft"[^>]+type="button"/i);
  assert.match(html, /id="retry-voice-cleanup"[^>]+type="button"[^>]+hidden/i);
  assert.match(html, /id="voice-button"[^>]+aria-pressed="false"[^>]+aria-describedby="voice-hint"/i);
  assert.match(html, /id="voice-button"[^>]+aria-label="Press or hold to record a voice message"/i);
  assert.match(html, /id="voice-hint"/i);
  assert.match(html, /id="cancel-voice"[^>]+type="button"/i);
  assert.match(html, /id="retry-voice-transcription"[^>]+type="button"[^>]+hidden/i);
  assert.match(html, /<dialog[^>]+id="voice-consent"[^>]+aria-labelledby="voice-consent-title"/i);
  assert.match(html, /id="voice-consent-continue"[^>]+type="button"/i);
  assert.match(html, /id="voice-consent-cancel"[^>]+type="button"/i);
  assert.match(html, /not sent to the chat until you tap Send/i);
  assert.doesNotMatch(html, /auto(?:matically)?[- ]send/i);
  assert.match(html, />Hold to speak<\/button>/i);
  assert.match(html, />Voice message<\/span>/i);

  assert.match(app, /from ['"]\.\/voice-capture\.js['"]/);
  assert.match(app, /from ['"]\.\/voice-upload-store\.js['"]/);
  assert.match(app, /from ['"]\.\/voice-transport\.js['"]/);
  assert.match(app, /from ['"]\.\/voice-upload-coordinator\.js['"]/);
  assert.match(app, /from ['"]\.\/voice-message-controller\.js['"]/);
  assert.match(app, /from ['"]\.\/assistant-audio-controller\.js['"]/);
  assert.match(app, /from ['"]\.\/assistant-audio-actions\.js['"]/);
  assert.match(app, /from ['"]\.\/voice-ui-guards\.js['"]/);
  assert.match(app, /pointerdown/i);
  assert.match(app, /pointerup/i);
  assert.match(app, /pointercancel/i);
  assert.match(app, /lostpointercapture/i);
  assert.match(app, /voiceButton\.addEventListener\(['"]click['"]/i);
  assert.match(app, /keyboardRecording\s*\?\s*['"]Press to stop and transcribe this voice message['"]/i);
  assert.match(app, /Press or hold to record a voice message/i);
  assert.match(app, /voiceButton\.addEventListener\(['"]keyup['"][\s\S]{0,180}markDirectActivation\(\)/i);
  assert.match(app, /addEventListener\(['"]pointerup['"][\s\S]{0,180}markDirectActivation\(\)[\s\S]{0,180}activePointerId\s*!==/i);
  assert.match(app, /voicePhaseCanCancelInteraction\(phase\)/i);
  assert.match(app, /createVoiceHoldFence/);
  assert.match(app, /currentVoiceIdentity\(identity\)[\s\S]{0,180}voiceHoldFence\.clear\(token\)/i);
  assert.match(app, /hasVoiceOperation\s*&&\s*!hasVoiceDraft\s*&&\s*VOICE_RETAINED_PHASES\.has\(phase\)/i);
  assert.match(app, /controller\.retryTranscription\(\)/i);
  assert.match(app, /phase\s*===\s*['"]processing['"][\s\S]{0,400}controller\.remove\(\)/i);
  assert.match(app, /performAssistantAudioAction\(/i);
  assert.doesNotMatch(app, /void\s+assistantAudioController\.(?:generate|play)\(/i);
  assert.match(app, /assistantAudioController\.handleHidden\(\)/i);
  assert.match(app, /assistantVoiceMessagesToPrepare\(/i);
  assert.match(app, /visibilitychange/i);
  assert.match(app, /pagehide/i);
  assert.match(app, /Escape/);
  const supportedCancelReasons = new Set([
    'cancel', 'escape', 'hidden', 'lostpointercapture', 'pagehide',
    'pointercancel', 'visible-cancel',
  ]);
  const wiredCancelReasons = [...app.matchAll(/cancelVoiceInteraction\(['"]([^'"]+)['"]\)/g)]
    .map(([, reason]) => reason);
  assert.ok(wiredCancelReasons.length >= 6);
  assert.deepEqual(wiredCancelReasons.filter((reason) => !supportedCancelReasons.has(reason)), []);

  assert.match(css, /#voice-button\s*\{[^}]*min-width:\s*(?:9[6-9]|1\d{2})px/is);
  assert.match(css, /#voice-button\s*\{[^}]*touch-action:\s*none/is);
  assert.match(css, /\.voice-draft\s*\{[^}]*background:\s*var\(--surface\)/is);
  assert.match(css, /\.voice-consent\s*\{[^}]*max-height:\s*min\(/is);
  assert.match(css, /\.composer-attribution img\s*\{[^}]*width:\s*(?:6[4-9]|7[0-2])px/is);
  assert.match(css, /\.composer-attribution img\s*\{[^}]*opacity:\s*\.(?:7[5-9]|8\d)/is);
});

test('ui contract preserves the exact source assets and serves an optimized avatar derivative', async () => {
  const html = await text('index.html');
  const wordmark = await readFile(new URL('assets/simplify-wordmark.svg', publicUrl));
  const avatar = await readFile(new URL('assets/ai-senior-avatar.png', publicUrl));
  const optimizedAvatar = await readFile(new URL('assets/ai-senior-avatar-128.png', publicUrl));

  assert.equal(wordmark.byteLength, 1033);
  assert.equal(createHash('sha256').update(wordmark).digest('hex'), '80b8c7a6b9368cfde4b41c776c48c7523d537350c28d300fd1f72736cbe5bb87');
  assert.equal(createHash('sha256').update(avatar).digest('hex'), '47ca07b1f03706e08640055d8c9975f7f4543c1686d051da5d209cd3455c05d0');
  assert.deepEqual(pngDimensions(avatar), { width: 1254, height: 1254 });
  assert.deepEqual(pngDimensions(optimizedAvatar), { width: 128, height: 128 });
  assert.ok(optimizedAvatar.byteLength < avatar.byteLength / 5);
  assert.match(html, /class="profile-avatar[^>]+src="\/assets\/ai-senior-avatar-128\.png"/i);
  assert.doesNotMatch(html, /class="profile-avatar[^>]+src="\/assets\/ai-senior-avatar\.png"/i);
  assert.match(html, /src="\/assets\/simplify-wordmark\.svg"/);
  assert.match(html, /aria-label="from Simplify"/);
  assert.match(html, /src="\/assets\/simplify-wordmark\.svg" alt="Simplify"/);
  assert.doesNotMatch(html, /ai-senior-avatar\.svg/);
});

test('ui contract locks the mobile-safe visual and accessibility fundamentals', async () => {
  const css = await text('styles.css');

  assert.match(css, /--canvas:\s*#f5f1ec/i);
  assert.match(css, /--ink:\s*#171816/i);
  assert.match(css, /--accent:\s*#2f6546/i);
  assert.match(css, /min-height:\s*100dvh/i);
  assert.match(css, /grid-template-rows:\s*calc\(56px \+ env\(safe-area-inset-top\)\)/i);
  assert.match(css, /height:\s*calc\(56px \+ env\(safe-area-inset-top\)\)/i);
  assert.match(css, /padding-top:\s*calc\(6px \+ env\(safe-area-inset-top\)\)/i);
  assert.match(css, /min-width:\s*44px/i);
  assert.match(css, /min-height:\s*44px/i);
  assert.match(css, /env\(safe-area-inset-bottom\)/i);
  assert.match(css, /env\(safe-area-inset-top\)/i);
  assert.match(css, /:focus-visible/i);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/i);
  assert.match(css, /overflow-x:\s*hidden/i);
  assert.match(css, /\.app-frame\s*\{[^}]*overflow:\s*hidden/is);
  assert.match(css, /\.chat-shell\s*\{[^}]*min-width:\s*0/is);
  assert.match(css, /\.chat-shell\s*\{[^}]*overflow:\s*hidden/is);
  assert.match(css, /\.reply-preferences-trigger\s*\{[^}]*min-height:\s*44px/is);
  assert.match(css, /\.reply-option\s*\{[^}]*min-height:\s*44px/is);
  assert.match(css, /\.sources-summary\s*\{[^}]*min-height:\s*44px/is);
  assert.match(css, /\.message-bubble\s*\{[^}]*font-size:\s*16px/is);
  assert.match(css, /\.composer textarea\s*\{[^}]*font-size:\s*16px/is);
  assert.match(css, /\.composer-panel\[data-voice-available="false"\]\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+62px/is);

  const retryRule = css.match(/\.retry-message\s*\{([^}]+)\}/i)?.[1] ?? '';
  assert.match(retryRule, /min-height:\s*44px/i);
  assert.doesNotMatch(retryRule, /min-height:\s*(?:3[0-9]|4[0-3])px/i);
  assert.match(css, /\.message-sources:empty,\s*\.message-actions:empty,\s*\.suggested-replies:empty\s*\{[^}]*display:\s*none/i);

  const canvas = css.match(/--canvas:\s*(#[a-f\d]{6})/i)?.[1];
  const subtle = css.match(/--ink-subtle:\s*(#[a-f\d]{6})/i)?.[1];
  assert.ok(contrastRatio(subtle, canvas) >= 4.5);
});

test('ui contract loads the canonical message client as an ES module', async () => {
  const html = await text('index.html');
  const app = await text('app.js');
  const controller = await text('chat-controller.js');

  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  assert.match(app, /from ['"]\.\/chat-controller\.js['"]/);
  assert.match(app, /from ['"]\.\/message-renderer\.js['"]/);
  assert.match(app, /from ['"]\.\/timeline-view\.js['"]/);
  assert.match(app, /from ['"]\.\/chat-copy\.js['"]/);
  assert.doesNotMatch(app, /messageFeed\.replaceChildren/);
  assert.match(app, /knowledgeSnapshotDate/);
  assert.match(app, /clearStatus/);
  assert.match(controller, /new EventSourceImpl\(/);
  assert.match(controller, /full \? 0 : state\.lastMessageSequence/);
});

test('ui contract publishes a self-contained mobile web app manifest', async () => {
  const html = await text('index.html');
  const manifest = JSON.parse(await text('manifest.webmanifest'));

  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon" href="\/assets\/ai-senior-avatar\.png"/);
  assert.deepEqual(manifest, {
    name: 'Hong Kong Buddy · Campus and Cantonese companion',
    short_name: 'HK Buddy',
    description: 'Campus next steps and everyday Cantonese practice for HKBU students. An AI assistant, not official HKBU.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f5f1ec',
    theme_color: '#f5f1ec',
    icons: [{
      src: '/assets/ai-senior-avatar.png',
      sizes: '1254x1254',
      type: 'image/png',
      purpose: 'any',
    }],
  });
});

test('ui contract syntax check covers every shipped client module', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const check = packageJson.scripts.check;

  assert.match(check, /node --check public\/app\.js/);
  assert.match(check, /node --check public\/app-shell\.js/);
  assert.match(check, /node --check public\/consent-controller\.js/);
  assert.match(check, /node --check public\/chat-controller\.js/);
  assert.match(check, /node --check public\/chat-state\.js/);
  assert.match(check, /node --check public\/message-renderer\.js/);
  assert.match(check, /node --check public\/timeline-view\.js/);
  assert.match(check, /node --check public\/chat-copy\.js/);
  assert.match(check, /node --check public\/voice-transport\.js/);
  assert.match(check, /node --check public\/voice-upload-coordinator\.js/);
  assert.match(check, /node --check public\/voice-message-controller\.js/);
  assert.match(check, /node --check public\/assistant-audio-controller\.js/);
  assert.match(check, /node --check public\/assistant-audio-actions\.js/);
  assert.match(check, /node --check public\/voice-ui-guards\.js/);
});
