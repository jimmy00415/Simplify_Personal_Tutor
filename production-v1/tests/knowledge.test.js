import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateClaimFreshness,
  loadDefaultCorpus,
  validateCorpus,
} from '../src/knowledge/corpus.js';
import { createRetriever, normalizeKnowledgeQuery } from '../src/knowledge/retriever.js';
import { routeSafety } from '../src/knowledge/safety.js';

const FIXED_NOW = '2026-08-25T12:00:00+08:00';
const corpus = await loadDefaultCorpus();
const retrieve = createRetriever({ corpus, now: () => new Date(FIXED_NOW) }).retrieve;

function copy(value) {
  return structuredClone(value);
}

function firstClaim(candidate = corpus) {
  return candidate.sources[0].claims[0];
}

test('knowledge corpus validates the reviewed official source and evidence contract', () => {
  const validated = validateCorpus(copy(corpus));
  const intentGroups = new Set(validated.sources.flatMap((source) => source.intentGroups));

  assert.equal(validated.governance.owner, 'Hong Kong Buddy knowledge owner');
  assert.equal(validated.governance.timeZone, 'Asia/Hong_Kong');
  assert.deepEqual(
    [...intentGroups].sort(),
    [
      'account_password', 'campus_ar_navigation', 'dining', 'dining_inventory', 'duo',
      'emergency', 'hall_facilities', 'hall_maintenance', 'international_support', 'it_help',
      'language_learning', 'library', 'living_supplies', 'medical', 'orientation',
      'osa_counselling', 'residence_check_in', 'student_card', 'transport',
    ],
  );

  for (const source of validated.sources) {
    const url = new URL(source.canonicalUrl);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    assert.ok(source.sourceGovernance.ownerOffice.startsWith('HKBU '));
    assert.deepEqual([...source.sourceGovernance.categories].sort(), [...source.intentGroups].sort());
    assert.deepEqual(source.sourceGovernance.languages, ['en']);
    assert.ok(['daily', 'weekly', 'biweekly', 'monthly', 'quarterly'].includes(source.sourceGovernance.volatility));
    assert.ok(['daily', 'weekly', 'biweekly', 'monthly', 'quarterly'].includes(source.sourceGovernance.reviewCadence));
    assert.ok(Number.isInteger(source.sourceGovernance.evidenceWindowDays));
    assert.equal(source.sourceGovernance.reviewAttestation.reviewedAt, source.verifiedAt);
    assert.equal(source.sourceGovernance.reviewAttestation.captureMethod, 'manual_review');
    assert.equal(source.sourceGovernance.reviewAttestation.sourceHash, null);
    for (const claim of source.claims) {
      assert.deepEqual(Object.keys(claim.text).sort(), ['en', 'zhHans', 'zhHant']);
      assert.equal(claim.reviewAttestation.sourceLocator, claim.sourceLocator);
      assert.ok(claim.evidenceNote.length > 0);
    }
  }
  assert.equal(
    validated.sources.find((source) => source.id === 'hkbu.sa.residence-halls-check-in')
      .sourceGovernance.ownerOffice,
    'HKBU Office of Student Affairs / Accommodation and Campus Management (ACCM)',
  );
  assert.equal(
    validated.sources.find((source) => source.id === 'hkbu.sa.fye').sourceGovernance.ownerOffice,
    'HKBU Office of Student Affairs / First Year Experience (FYE)',
  );
  assert.equal(
    validated.sources.find((source) => source.id === 'hkbu.sa.international-support')
      .sourceGovernance.ownerOffice,
    'HKBU Office of Student Affairs / Campus Life & Amenities',
  );
});

test('knowledge snapshot locks exact governed counts, hosts, and review-instant status distribution', () => {
  const claims = corpus.sources.flatMap((source) => source.claims);
  const intentGroups = new Set(corpus.sources.flatMap((source) => source.intentGroups));
  const hosts = [...new Set(corpus.sources.map((source) => new URL(source.canonicalUrl).hostname))].sort();
  const statuses = claims.reduce((counts, claim) => {
    const status = evaluateClaimFreshness(claim, new Date(corpus.snapshotAt));
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});

  assert.equal(corpus.sources.length, 29);
  assert.equal(claims.length, 61);
  assert.equal(intentGroups.size, 19);
  assert.deepEqual(hosts, [
    'ar.hkbu.edu.hk',
    'eo.hkbu.edu.hk',
    'ito.hkbu.edu.hk',
    'library.hkbu.edu.hk',
    'sa.hkbu.edu.hk',
  ]);
  assert.deepEqual(statuses, { verified: 56, conflicted: 4, not_yet_valid: 1 });
});

test('knowledge corpus rejects missing, loose, or fabricated source governance', () => {
  const cases = [
    [(source) => { delete source.sourceGovernance; }, /sourceGovernance/],
    [(source) => { source.sourceGovernance.ownerOffice = ''; }, /ownerOffice/],
    [(source) => { source.sourceGovernance.categories = []; }, /categories/],
    [(source) => { source.sourceGovernance.ownerOffice = 'Some invented office'; }, /ownerOffice/],
    [(source) => { source.sourceGovernance.languages = []; }, /languages/],
    [(source) => { source.sourceGovernance.languages = ['en', 'fr']; }, /languages/],
    [(source) => { source.sourceGovernance.volatility = 'yearly'; }, /volatility/],
    [(source) => { source.sourceGovernance.reviewCadence = 'monthly'; }, /reviewCadence.*looser/i],
    [(source) => { source.sourceGovernance.evidenceWindowDays = 0; }, /evidenceWindowDays/],
    [(source) => { source.sourceGovernance.evidenceWindowDays = 31; }, /evidenceWindowDays.*looser/i],
    [(source) => { source.sourceGovernance.reviewAttestation.reviewedAt = '2026-08-24T12:00:00+08:00'; }, /reviewedAt.*verifiedAt/i],
    [(source) => { source.sourceGovernance.reviewAttestation.sourceHash = '0'.repeat(64); }, /sourceHash/],
  ];

  for (const [mutate, expected] of cases) {
    const invalid = copy(corpus);
    mutate(invalid.sources[0]);
    assert.throws(() => validateCorpus(invalid), expected);
  }

  const looseActualHorizon = copy(corpus);
  const accountSource = looseActualHorizon.sources.find((source) => source.id === 'hkbu.ito.account');
  accountSource.sourceGovernance.volatility = 'quarterly';
  accountSource.sourceGovernance.reviewCadence = 'quarterly';
  accountSource.sourceGovernance.evidenceWindowDays = 92;
  assert.throws(
    () => validateCorpus(looseActualHorizon),
    /actual claim review horizon/i,
  );
});

test('knowledge corpus rejects unsafe or polluted canonical URLs', () => {
  const cases = [
    ['http://ito.hkbu.edu.hk/services/it-security/mfa.html', /HTTPS/],
    ['https://ito.hkbu.edu.hk.evil.example/services/it-security/mfa.html', /approved HKBU host/],
    ['https://evil-hkbu.edu.hk/services/it-security/mfa.html', /approved HKBU host/],
    ['https://user:pass@ito.hkbu.edu.hk/services/it-security/mfa.html', /credentials/],
    ['https://ito.hkbu.edu.hk/services/it-security/mfa.html?next=https://evil.example', /query or fragment/],
    ['https://ito.hkbu.edu.hk/services/it-security/mfa.html#spoofed', /query or fragment/],
  ];

  for (const [canonicalUrl, expected] of cases) {
    const invalid = copy(corpus);
    invalid.sources[0].canonicalUrl = canonicalUrl;
    assert.throws(() => validateCorpus(invalid), expected, canonicalUrl);
  }
});

test('knowledge corpus rejects incomplete evidence, invalid HKT windows, and fake hashes', () => {
  const mutations = [
    [(claim) => { claim.sourceLocator = ''; }, /sourceLocator/],
    [(claim) => { delete claim.reviewAttestation; }, /reviewAttestation/],
    [(claim) => { claim.reviewAttestation.sourceLocator = 'different section'; }, /attestation locator/],
    [(claim) => { claim.reviewAttestation.captureMethod = ''; }, /captureMethod/],
    [(claim) => { claim.reviewAttestation.sourceHash = 'placeholder'; }, /SHA-256/],
    [(claim) => { claim.reviewAttestation.sourceHash = '0'.repeat(64); }, /SHA-256/],
    [(claim) => { claim.reviewAttestation.sourceHash = '0123456789abcdef'.repeat(4); }, /SHA-256/],
    [(claim) => {
      claim.reviewAttestation.captureMethod = 'captured_fragment';
      claim.reviewAttestation.sourceHash = 'abcdef0123456789'.repeat(4);
    }, /captured_fragment.*unsupported|stored normalized fragment/i],
    [(claim) => { claim.verifiedAt = '2026-08-25T04:00:00Z'; }, /\+08:00/],
    [(claim) => { claim.verifiedAt = '2026-02-30T12:00:00+08:00'; }, /valid calendar|valid instant/],
    [(claim) => { claim.reviewAfter = '2026-08-20T12:00:00+08:00'; }, /reviewAfter/],
    [(claim) => {
      claim.validFrom = '2026-09-02T00:00:00+08:00';
      claim.validUntil = '2026-09-01T00:00:00+08:00';
    }, /validity window/],
  ];

  for (const [mutate, expected] of mutations) {
    const invalid = copy(corpus);
    mutate(firstClaim(invalid));
    assert.throws(() => validateCorpus(invalid), expected);
  }
});

test('knowledge corpus enforces one global source, claim, and action ID namespace', () => {
  const sourceClaimCollision = copy(corpus);
  sourceClaimCollision.sources[1].id = firstClaim(sourceClaimCollision).id;
  assert.throws(() => validateCorpus(sourceClaimCollision), /duplicate ID/);

  const actionSourceCollision = copy(corpus);
  const sourceWithAction = actionSourceCollision.sources.find((source) => source.actions?.length);
  sourceWithAction.actions[0].id = actionSourceCollision.sources[0].id;
  assert.throws(() => validateCorpus(actionSourceCollision), /duplicate ID/);
});

test('knowledge corpus fails closed when a required campus intent group is missing', () => {
  const incomplete = copy(corpus);
  for (const source of incomplete.sources) {
    source.intentGroups = source.intentGroups.filter((intent) => intent !== 'transport');
    source.sourceGovernance.categories = source.sourceGovernance.categories
      .filter((category) => category !== 'transport');
  }
  incomplete.sources = incomplete.sources.filter((source) => source.intentGroups.length > 0);
  assert.throws(() => validateCorpus(incomplete), /missing required intent group: transport/);
});

test('knowledge corpus validates fail-closed operational qualifiers instead of trusting truthy metadata', () => {
  const supportedFlags = ['inventoryOnly', 'listedHoursOnly', 'scopeOnly'];
  for (const flag of supportedFlags) {
    const invalid = copy(corpus);
    firstClaim(invalid).facts = { ...(firstClaim(invalid).facts ?? {}), [flag]: 'yes' };
    assert.throws(() => validateCorpus(invalid), new RegExp(`${flag}.*boolean`, 'i'));
  }

  const promotableConflict = copy(corpus);
  const conflict = promotableConflict.sources
    .flatMap((source) => source.claims)
    .find((claim) => claim.facts?.mustNotPromote);
  conflict.verificationStatus = 'official_verified';
  assert.throws(() => validateCorpus(promotableConflict), /mustNotPromote.*cannot.*official_verified/i);

  const malformedConflict = copy(corpus);
  const malformed = malformedConflict.sources
    .flatMap((source) => source.claims)
    .find((claim) => claim.facts?.mustNotPromote);
  malformed.facts.mustNotPromote = 1;
  assert.throws(() => validateCorpus(malformedConflict), /mustNotPromote.*boolean/i);
});

test('current dining-inventory wording fails closed in every supported query language', () => {
  const queries = [
    'Which food outlets at JC³ are open now?',
    'JC³ 餐飲店而家邊間開門？',
    'JC³ 餐饮店现在哪间开门？',
  ];
  for (const query of queries) {
    const result = retrieve(query);
    assert.equal(result.intent, 'dining_inventory');
    assert.deepEqual(result.evidenceIds, []);
    assert.ok(result.ambiguityCodes.includes('CURRENT_AVAILABILITY_REQUIRED'));
    assert.equal(result.handoffSourceId, 'hkbu.eo.dining-overview');
  }
});

test('bare open and operating wording fails closed for inventory and listed-hours claims', () => {
  const cases = [
    ['Is NTTIH reception open?', 'hall_facilities', 'hkbu.sa.nttih-facilities'],
    ['Is Music Practice Room 106A open?', 'hall_facilities', 'hkbu.sa.hall-facilities'],
    ['Which food outlets at JC³ are open?', 'dining_inventory', 'hkbu.eo.dining-overview'],
    ['NTTIH reception 係咪營業？', 'hall_facilities', 'hkbu.sa.nttih-facilities'],
    ['NTTIH 接待处营业吗？', 'hall_facilities', 'hkbu.sa.nttih-facilities'],
  ];
  const freshRetrieve = createRetriever({
    corpus,
    now: () => new Date('2026-08-26T12:00:00+08:00'),
  }).retrieve;

  for (const [query, intent, handoff] of cases) {
    const result = freshRetrieve(query);
    assert.equal(result.intent, intent, query);
    assert.deepEqual(result.evidenceIds, [], query);
    assert.ok(result.ambiguityCodes.includes('CURRENT_AVAILABILITY_REQUIRED'), query);
    assert.equal(result.handoffSourceId, handoff, query);
  }
});

test('natural trilingual category questions reach only their governed HKBU route', () => {
  const freshRetrieve = createRetriever({
    corpus,
    now: () => new Date('2026-08-26T12:00:00+08:00'),
  }).retrieve;
  const cases = [
    ['Where is the Student Welfare Shop?', 'living_supplies', 'evidence.sa.student-welfare-shop.categories'],
    ['學生福利店喺邊？', 'living_supplies', 'evidence.sa.student-welfare-shop.categories'],
    ['学生福利店在哪里？', 'living_supplies', 'evidence.sa.student-welfare-shop.categories'],
    ['Where can international students get support?', 'international_support', 'evidence.sa.international.association'],
    ['國際學生可以去邊度搵支援？', 'international_support', 'evidence.sa.international.association'],
    ['国际学生可以去哪里找支持？', 'international_support', 'evidence.sa.international.association'],
    ['What support is available for international students?', 'international_support', 'evidence.sa.international.association'],
    ['國際學生有咩支援？', 'international_support', 'evidence.sa.international.association'],
    ['国际学生有哪些支持？', 'international_support', 'evidence.sa.international.association'],
  ];

  for (const [query, intent, evidenceId] of cases) {
    const result = freshRetrieve(query);
    assert.equal(result.intent, intent, query);
    assert.ok(result.evidenceIds.includes(evidenceId), query);
    assert.equal(result.needsClarification, false, query);
  }

  for (const query of ['How can I learn Cantonese?', '廣東話可以點學？', '广东话怎么学？']) {
    const result = freshRetrieve(query);
    assert.equal(result.intent, 'language_learning', query);
    assert.deepEqual(result.evidenceIds, [], query);
    assert.ok(result.ambiguityCodes.includes('NO_CURRENT_PROGRAMME_EVIDENCE'), query);
    assert.equal(result.handoffSourceId, 'hkbu.ar.exchange-language-courses', query);
  }

  for (const query of ['Where can I find FYE?', 'FYE 喺邊度？', 'FYE 在哪里？']) {
    const result = freshRetrieve(query);
    assert.equal(result.intent, 'orientation', query);
    assert.deepEqual(result.evidenceIds, ['evidence.sa.fye.orientation-directory'], query);
    assert.equal(result.needsClarification, false, query);
  }

  // The captured U-Life claims cover specific UOW timing and routes, not a
  // definition of the whole U-Life requirement. Keep generic questions on the
  // category-owned page instead of expanding three narrow claims into an
  // unsupported overview.
  for (const query of ['What is U-Life?', 'U-Life 係咩？', 'U-Life 是什么？']) {
    const result = freshRetrieve(query);
    assert.equal(result.intent, 'orientation', query);
    assert.deepEqual(result.evidenceIds, [], query);
    assert.ok(result.ambiguityCodes.includes('NO_MATCHING_OFFICIAL_EVIDENCE'), query);
    assert.equal(result.handoffSourceId, 'hkbu.sa.u-life', query);
  }
});

test('generic hall-facility questions stay on the general SRH guide without NTTIH or check-in leakage', () => {
  const freshRetrieve = createRetriever({
    corpus,
    now: () => new Date('2026-08-26T12:00:00+08:00'),
  }).retrieve;
  for (const query of [
    'What hall facilities are there?',
    '宿舍設施有啲咩？',
    '宿舍设施有哪些？',
    'What services are in the residence halls?',
  ]) {
    const result = freshRetrieve(query);
    assert.equal(result.intent, 'hall_facilities', query);
    assert.deepEqual(result.sources.map((source) => source.id), ['hkbu.sa.hall-facilities'], query);
    assert.equal(result.supportableClaims.every((claim) => claim.sourceId === 'hkbu.sa.hall-facilities'), true, query);
    assert.equal(result.staleClaims.length, 0, query);
    assert.equal(result.ambiguityCodes.some((code) => code.startsWith('RESIDENCE_')), false, query);
    assert.equal(result.ambiguityCodes.includes('CONFLICTED_LIVE_STATUS'), false, query);
  }
});

test('explicit NTTIH bedding questions use the reviewed room-inclusions claim', () => {
  const freshRetrieve = createRetriever({
    corpus,
    now: () => new Date('2026-08-26T12:00:00+08:00'),
  }).retrieve;
  for (const query of [
    'Does NTTIH provide bedding?',
    'NTTIH 有冇床品？',
    'NTTIH 提供床上用品吗？',
  ]) {
    const result = freshRetrieve(query);
    assert.equal(result.intent, 'hall_facilities', query);
    assert.deepEqual(result.evidenceIds, ['evidence.sa.nttih.room-inclusions'], query);
    assert.deepEqual(result.sources.map((source) => source.id), ['hkbu.sa.nttih-facilities'], query);
    assert.deepEqual(result.ambiguityCodes, [], query);
  }
});

test('NTTIH context never promotes unsupported SIM-card or grocery guidance', () => {
  const freshRetrieve = createRetriever({
    corpus,
    now: () => new Date('2026-08-26T12:00:00+08:00'),
  }).retrieve;
  for (const query of [
    'Where can I buy a SIM card near NTTIH?',
    'NTTIH 附近邊度可以買 SIM 卡？',
    'NTTIH 附近哪里可以买 SIM 卡？',
    'Is there a grocery store near NTTIH?',
    'NTTIH 附近有冇雜貨店？',
    'NTTIH 附近有杂货店吗？',
  ]) {
    const result = freshRetrieve(query);
    assert.equal(result.intent, 'living_supplies', query);
    assert.deepEqual(result.evidenceIds, [], query);
    assert.deepEqual(result.sources.map((source) => source.id), ['hkbu.sa.student-welfare-shop'], query);
    assert.deepEqual(result.ambiguityCodes, ['NO_MATCHING_OFFICIAL_EVIDENCE'], query);
    assert.equal(result.handoffSourceId, 'hkbu.sa.accm-contact', query);
  }
});

test('knowledge freshness is claim-level and only current official evidence is supportable', () => {
  const base = copy(firstClaim());
  assert.equal(evaluateClaimFreshness(base, new Date(FIXED_NOW)), 'verified');

  const cases = [
    [{ ...base, reviewAfter: '2026-08-25T11:59:59+08:00' }, 'review_overdue'],
    [{ ...base, validUntil: '2026-08-25T11:59:59+08:00' }, 'expired'],
    [{ ...base, validFrom: '2026-08-25T12:00:01+08:00' }, 'not_yet_valid'],
    [{ ...base, verificationStatus: 'conflicted' }, 'conflicted'],
    [{ ...base, verificationStatus: 'unverified' }, 'unverified'],
  ];
  for (const [claim, status] of cases) {
    assert.equal(evaluateClaimFreshness(claim, new Date(FIXED_NOW)), status);
  }

  const library = retrieve('Main Library opening hours');
  assert.equal(library.supportableClaims.every((claim) => claim.status === 'verified'), true);
  assert.equal(library.staleClaims.some((claim) => claim.status === 'not_yet_valid'), true);
  assert.equal(library.evidenceIds.every((id) => id.startsWith('evidence.')), true);
  assert.equal(library.evidenceIds.includes(library.topSourceId), false);

  const expiredCorpus = copy(corpus);
  const closure = expiredCorpus.sources.find((source) => source.id === 'hkbu.eo.dining.bu-fiesta').claims[0];
  closure.validUntil = '2026-08-25T11:59:59+08:00';
  const expired = createRetriever({ corpus: expiredCorpus, now: () => new Date(FIXED_NOW) }).retrieve('BU Fiesta open');
  assert.equal(expired.supportableClaims.some((claim) => claim.id === closure.id), false);
  assert.equal(expired.staleClaims.find((claim) => claim.id === closure.id).status, 'expired');
});

test('knowledge retrieval returns reviewed Duo and BU Fiesta facts deterministically', () => {
  const duo = retrieve('Duo 换手机怎么办');
  const fiesta = retrieve('BU Fiesta 今日开吗');

  assert.equal(duo.topSourceId, 'hkbu.ito.duo');
  assert.equal(duo.supportableClaims.some((claim) => claim.facts.issue === 'new_phone'), true);
  assert.equal(fiesta.topSourceId, 'hkbu.eo.dining.bu-fiesta');
  assert.equal(fiesta.claims[0].status, 'verified');
  assert.equal(fiesta.claims[0].facts.open, false);
  assert.match(fiesta.claims[0].text.en, /closed for renovation until further notice/i);
  assert.deepEqual(retrieve('BU Fiesta 今日开吗').evidenceIds, fiesta.evidenceIds);
});

test('knowledge residence evidence keeps 2026 schedules separate from stale 2025/26 reminders', () => {
  const village = retrieve('Village CARE non-local freshman check-in 2026');
  const halls = retrieve('Student Residence Halls local freshman check-in 2026');

  for (const result of [village, halls]) {
    assert.equal(result.supportableClaims.some((claim) => claim.facts.scheduleYear === 2026), true);
    assert.equal(result.supportableClaims.some((claim) => JSON.stringify(claim).includes('2025/26')), false);
    assert.equal(result.staleClaims.some((claim) => claim.status === 'conflicted'), true);
  }
});

test('knowledge corpus stores atomic current student-card and residence schedule rows', () => {
  const nonJupas = retrieve('Non-JUPAS uploaded photo by 2 August 2026 student card collection');
  const latePhoto = retrieve('student card photo uploaded by 23 August 2026 collection');
  const villageFreshman = retrieve('Village CARE non-local freshman check-in 2026');
  const villageExchange = retrieve('Village CARE exchange students check-in 2026');
  const hallsLocal = retrieve('Student Residence Halls local freshman check-in 2026');

  const nonJupasClaim = nonJupas.supportableClaims.find(
    (claim) => claim.id === 'evidence.ar.student-card-collection.non-jupas-photo-by-2026-08-02',
  );
  assert.ok(nonJupasClaim);
  assert.equal(nonJupasClaim.facts.photoUploadDeadline, '2026-08-02');
  assert.deepEqual(nonJupasClaim.facts.collectionDates, ['2026-08-10', '2026-08-11', '2026-08-24']);
  assert.equal(nonJupasClaim.facts.venuesByDate['2026-08-10'], 'WYS201 (Tsang Chan Sik Yue Auditorium)');
  assert.equal(nonJupasClaim.facts.venuesByDate['2026-08-24'], 'WLB103/WLB104');

  const latePhotoClaim = latePhoto.supportableClaims.find(
    (claim) => claim.id === 'evidence.ar.student-card-collection.photo-by-2026-08-23',
  );
  assert.ok(latePhotoClaim);
  assert.equal(latePhotoClaim.facts.collectionStarts, '2026-09-01');
  assert.equal(latePhotoClaim.facts.venue, 'Academic Registry, SCE301');
  assert.deepEqual(latePhotoClaim.facts.weekdayHours, ['09:00-12:45', '14:00-17:00']);

  const villageFreshmanClaim = villageFreshman.supportableClaims.find(
    (claim) => claim.id === 'evidence.sa.village-care-check-in.non-local-freshmen-2026',
  );
  assert.ok(villageFreshmanClaim);
  assert.deepEqual(villageFreshmanClaim.facts.checkInDates, [
    '2026-08-20', '2026-08-25', '2026-08-26', '2026-08-27',
  ]);
  assert.equal(villageFreshmanClaim.facts.officeVenue, 'Rooms 302-303, 3/F, JC3');

  const villageExchangeClaim = villageExchange.supportableClaims.find(
    (claim) => claim.id === 'evidence.sa.village-care-check-in.exchange-students-2026',
  );
  assert.ok(villageExchangeClaim);
  assert.equal(villageExchangeClaim.facts.earliestCheckIn, '2026-08-25');
  assert.deepEqual(villageExchangeClaim.facts.checkInDates, ['2026-08-25', '2026-08-26', '2026-08-27']);
  assert.equal(villageExchangeClaim.facts.onOrAfterDate, '2026-08-28');

  const hallsLocalClaim = hallsLocal.supportableClaims.find(
    (claim) => claim.id === 'evidence.sa.residence-halls-check-in.local-freshmen-2026',
  );
  assert.ok(hallsLocalClaim);
  assert.deepEqual(hallsLocalClaim.facts.checkInDates, ['2026-08-27']);
  assert.equal(hallsLocalClaim.facts.officeVenue, 'Rev. James Mau Memorial Chapel G9');
  assert.equal(hallsLocalClaim.facts.outsideOfficeHoursVenue, 'Security Counter, G/F, North Tower, Student Residence Halls');
});

test('knowledge retrieval asks for branch, cohort, or current special-hours detail instead of guessing', () => {
  const library = retrieve('图书馆今天几点关门');
  const residence = retrieve('宿舍什么时候 check in');
  const catering = retrieve('Main Canteen 今日开到几点');

  assert.equal(library.needsClarification, true);
  assert.ok(library.ambiguityCodes.includes('LIBRARY_BRANCH_REQUIRED'));
  assert.equal(residence.needsClarification, true);
  assert.ok(residence.ambiguityCodes.includes('RESIDENCE_COHORT_REQUIRED'));
  assert.equal(catering.needsClarification, true);
  assert.ok(catering.ambiguityCodes.includes('CATERING_SPECIAL_HOURS_REQUIRED'));
});

test('knowledge retrieval does not promote static dining guidance as live queue telemetry', () => {
  const result = retrieve('What is the exact queue length at every canteen right now?');

  assert.equal(result.needsClarification, true);
  assert.ok(result.ambiguityCodes.includes('LIVE_DINING_STATUS_UNAVAILABLE'));
  assert.deepEqual(result.supportableClaims, []);
  assert.deepEqual(result.evidenceIds, []);
});

test('knowledge retrieval gates sources, claims, and clarification by the matched route', () => {
  const village = retrieve('Village CARE non-local freshman check-in 2026');
  assert.deepEqual(village.sources.map((source) => source.id), ['hkbu.sa.village-care-check-in']);
  assert.equal(village.supportableClaims.every(
    (claim) => claim.sourceId === 'hkbu.sa.village-care-check-in',
  ), true);

  const genericHostel = retrieve('When can non-local freshmen check into the hostel?');
  assert.equal(genericHostel.needsClarification, true);
  assert.ok(genericHostel.ambiguityCodes.includes('RESIDENCE_TYPE_REQUIRED'));
  assert.equal(genericHostel.supportableClaims.length, 0);

  const card = retrieve('When can I collect my student card?');
  assert.deepEqual(card.sources.map((source) => source.id), ['hkbu.ar.student-card-collection']);
  assert.ok(card.ambiguityCodes.includes('STUDENT_CARD_ADMISSION_ROUTE_REQUIRED'));
  assert.ok(card.ambiguityCodes.includes('STUDENT_CARD_PHOTO_UPLOAD_ROUTE_REQUIRED'));
  assert.equal(card.supportableClaims.length, 0);
  assert.equal(card.staleClaims.some((claim) => /replacement|e-card/.test(claim.id)), false);

  const mainLibrary = retrieve('Main Library opening hours');
  assert.deepEqual(mainLibrary.sources.map((source) => source.id), ['hkbu.library.hours']);
  assert.equal(mainLibrary.supportableClaims.every((claim) => claim.facts.branch === 'Main Library'), true);
  assert.equal(mainLibrary.supportableClaims.some((claim) => claim.id.startsWith('evidence.ar.')), false);

  const canteen = retrieve('Main Canteen current hours today');
  assert.ok(canteen.ambiguityCodes.includes('CATERING_SPECIAL_HOURS_REQUIRED'));
  assert.equal(canteen.evidenceIds.includes('evidence.eo.dining.main-canteen.regular'), false);
  assert.equal(canteen.evidenceIds.includes('evidence.eo.dining-overview.special-hours'), true);
});

test('student-card collection matches exact structured admission and photo routes', () => {
  const nonJupas = retrieve('Non-JUPAS uploaded photo by 2 August 2026 student card collection');
  assert.deepEqual(nonJupas.evidenceIds, [
    'evidence.ar.student-card-collection.non-jupas-photo-by-2026-08-02',
  ]);
  assert.equal(nonJupas.needsClarification, false);

  const jupas = retrieve('JUPAS uploaded photo by 7 August 2026 at 12 noon student card collection');
  assert.deepEqual(jupas.evidenceIds, [
    'evidence.ar.student-card-collection.jupas-photo-by-2026-08-07-noon',
  ]);
  assert.equal(jupas.needsClarification, false);

  const conflicts = [
    'JUPAS uploaded photo by 2 August 2026 student card collection',
    'Non-JUPAS uploaded photo by 7 August 2026 student card collection',
  ];
  for (const input of conflicts) {
    const result = retrieve(input);
    assert.equal(result.needsClarification, true, input);
    assert.ok(result.ambiguityCodes.includes('STUDENT_CARD_ROUTE_MISMATCH'), input);
    assert.equal(result.supportableClaims.length, 0, input);
  }
});

test('structured schedules reject an explicit year outside the reviewed schedule', () => {
  const validChineseRoutes = [
    'Non-JUPAS 已於2026年8月2日上載電子相片，學生證幾時領取',
    'Non-JUPAS 已於8月2日上传电子照片，学生证什么时候领取',
  ];
  for (const input of validChineseRoutes) {
    const result = retrieve(input);
    assert.deepEqual(result.evidenceIds, [
      'evidence.ar.student-card-collection.non-jupas-photo-by-2026-08-02',
    ], input);
    assert.equal(result.needsClarification, false, input);
  }

  const wrongYears = [
    'Non-JUPAS 已於2025年8月2日上載電子相片，學生證幾時領取',
    'Non-JUPAS 已于2027年8月2日上传电子照片，学生证什么时候领取',
  ];
  for (const input of wrongYears) {
    const result = retrieve(input);
    assert.equal(result.needsClarification, true, input);
    assert.ok(result.ambiguityCodes.includes('STUDENT_CARD_ROUTE_YEAR_MISMATCH'), input);
    assert.equal(result.supportableClaims.length, 0, input);
  }

  const residenceWrongYear = retrieve('Village CARE non-local freshman 2027年8月20日 check-in');
  assert.ok(residenceWrongYear.ambiguityCodes.includes('SCHEDULE_YEAR_MISMATCH'));
  assert.equal(residenceWrongYear.supportableClaims.length, 0);
});

test('generic current dining asks for reviewed special hours while explicit outlets stay scoped', () => {
  for (const input of [
    'what food is open now',
    'which canteen is open today',
    'BU Fiesta is closed, what food is open now?',
    'Other than BU Fiesta, which canteen is open today?',
    'BU Fiesta 已經關門，仲有咩飯堂而家開？',
    '除了 BU Fiesta，其他哪间食堂今天开门？',
  ]) {
    const generic = retrieve(input);
    assert.equal(generic.needsClarification, true, input);
    assert.ok(generic.ambiguityCodes.includes('CATERING_SPECIAL_HOURS_REQUIRED'), input);
    assert.equal(generic.supportableClaims.some((claim) => claim.facts?.open !== undefined), false, input);
    assert.equal(generic.supportableClaims.some((claim) => claim.facts?.regularHoursOnly), false, input);
  }

  const fiesta = retrieve('Is BU Fiesta open today?');
  assert.equal(fiesta.needsClarification, false);
  assert.equal(fiesta.supportableClaims[0].facts.open, false);

  const main = retrieve('Is Main Canteen open today?');
  assert.ok(main.ambiguityCodes.includes('CATERING_SPECIAL_HOURS_REQUIRED'));
  assert.equal(main.evidenceIds.includes('evidence.eo.dining.main-canteen.regular'), false);
});

test('knowledge retrieval normalizes bilingual aliases without Latin substring false positives', () => {
  assert.equal(normalizeKnowledgeQuery('  JC³\u200b， Room 201　'), 'jc3 room 201');
  assert.equal(normalizeKnowledgeQuery('主\u2060馆　几点关门'), '主馆 几点关门');
  assert.equal(retrieve('JC3 Room 201 在哪').topSourceId, 'hkbu.eo.campus-map');
  assert.notEqual(retrieve('library').topSourceId, 'hkbu.ar.contact');
  assert.equal(retrieve('雙重認證換咗電話').topSourceId, 'hkbu.ito.duo');
  assert.equal(retrieve('双重认证换了手机').topSourceId, 'hkbu.ito.duo');
  assert.equal(retrieve('點樣搵學生事務處').topSourceId, 'hkbu.sa.contact');
  assert.equal(retrieve('主馆几点关门').topSourceId, 'hkbu.library.hours');
  assert.equal(retrieve('Village CARE exchange students check-in').topSourceId, 'hkbu.sa.village-care-check-in');
});

test('future-dated Main Library schedule activates with exact official hours', () => {
  const august = retrieve('Main Library opening hours');
  const futureInAugust = august.staleClaims.find(
    (claim) => claim.id === 'evidence.library.main.from-september-2026',
  );
  assert.equal(futureInAugust.status, 'not_yet_valid');

  const afterActivation = createRetriever({
    corpus,
    now: () => new Date('2026-09-02T12:00:00+08:00'),
  }).retrieve('Main Library opening hours');
  const active = afterActivation.supportableClaims.find(
    (claim) => claim.id === 'evidence.library.main.from-september-2026',
  );
  assert.ok(active);
  assert.equal(active.status, 'verified');
  assert.deepEqual(
    { weekday: active.facts.weekday, saturday: active.facts.saturday, sunday: active.facts.sunday },
    { weekday: '08:30-23:00', saturday: '09:00-21:00', sunday: '13:00-19:00' },
  );
  assert.doesNotMatch(active.text.en, /future/i);
});

test('knowledge retrieval is stable for empty, long, punctuation, and emoji-only inputs', () => {
  for (const input of ['', ' '.repeat(40), '🔥🙂', '，。！？', `Duo ${'x'.repeat(20_000)}`]) {
    const result = retrieve(input);
    assert.equal(typeof result.needsClarification, 'boolean');
    assert.ok(Array.isArray(result.supportableClaims));
    assert.ok(Array.isArray(result.sources));
  }
});

test('knowledge corpus keeps time-sensitive replacement, dental, MTR, and catering facts honest', () => {
  const replacement = retrieve('student card replacement fee');
  const dental = retrieve('student dental scheme fee');
  const transport = retrieve('MTR student travel scheme 2025/26');

  assert.equal(replacement.supportableClaims.some((claim) => claim.facts.feeHkd === 100), true);
  assert.equal(dental.supportableClaims.some((claim) => claim.sourceLocator.toLowerCase().includes('dental')), false);
  assert.equal(dental.staleClaims.some((claim) => claim.status === 'conflicted'), true);
  assert.equal(transport.supportableClaims.some((claim) => JSON.stringify(claim).includes('2025/26')), false);
});

test('knowledge safety bypasses retrieval for immediate danger in English, Traditional, and Simplified Chinese', () => {
  const emergencies = [
    ['Someone is badly injured and bleeding heavily now', 'injury'],
    ['My roommate is unconscious and not breathing', 'injury'],
    ['有人受傷，流好多血', 'injury'],
    ['有人受伤流很多血', 'injury'],
    ['The building is on fire right now', 'fire'],
    ['宿舍而家火警', 'fire'],
    ['宿舍现在着火了', 'fire'],
    ['I am going to kill myself now', 'self_harm'],
    ['I want to kill myself right now', 'self_harm'],
    ['My roommate wants to kill herself now', 'self_harm'],
    ['我而家想自殺', 'self_harm'],
    ['我朋友现在要自杀', 'self_harm'],
    ['佢而家想自殺', 'self_harm'],
    ['他现在要自杀', 'self_harm'],
    ['Someone has a knife and is attacking people', 'violence'],
    ['有人持刀傷人', 'violence'],
    ['有人持刀伤人', 'violence'],
    ['我而家想死', 'self_harm'],
    ['朋友说不想活了', 'self_harm'],
    ['我朋友話唔想再活', 'self_harm'],
    ['有人拎刀要斬人', 'violence'],
    ['有人拿刀要砍人', 'violence'],
    ['而家已經流好多血，不用報警', 'injury'],
    ['现在流很多血，不要报警', 'injury'],
    ['我而家想\u2060死', 'self_harm'],
  ];

  for (const [input, category] of emergencies) {
    const routed = routeSafety(input, { emergencyNumber: '000', securityNumber: '0000' });
    assert.equal(routed.kind, 'emergency', input);
    assert.equal(routed.category, category, input);
    assert.deepEqual(routed.contacts.map((contact) => contact.phone), ['999', '3411 7777']);
    assert.equal(routed.bypassRetrieval, true);
  }

  const bypassed = retrieve('宿舍现在着火了');
  assert.equal(bypassed.kind, 'emergency');
  assert.equal(bypassed.supportableClaims.length, 0);
});

test('knowledge safety does not misroute drills, account help, figures of speech, or non-urgent care', () => {
  const nearMisses = [
    'Duo emergency access code',
    'firewall login problem',
    'There is a scheduled fire drill tomorrow',
    'I am dying to know the library hours',
    'Where is the non-urgent Health Centre?',
    'violence prevention workshop',
    'self-harm research resources',
    '冇火警，只係演習',
    '没有火灾，只是演习',
  ];

  for (const input of nearMisses) {
    assert.equal(routeSafety(input).kind, 'normal', input);
  }

  assert.equal(routeSafety('This is not a drill: the building is on fire').kind, 'emergency');
  assert.equal(routeSafety('A fire drill is planned, but a room is on fire now').kind, 'emergency');
  assert.equal(routeSafety('I am not joking, I will kill myself now').kind, 'emergency');
  assert.equal(routeSafety('I was reading self-harm research, but my friend is trying to kill himself now').kind, 'emergency');
  assert.equal(routeSafety('At a violence prevention workshop, someone has a knife and is attacking people').kind, 'emergency');
});
