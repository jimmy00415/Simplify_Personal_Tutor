import { evaluateClaimFreshness } from './corpus.js';
import { routeSafety } from './safety.js';

const INTENT_ALIASES = Object.freeze({
  student_card: ['student card', 'student e card', 'ecard', 'e card', '學生證', '学生证', '學生卡', '学生卡', '校卡', '補領學生證', '补领学生证'],
  account_password: ['ssoid', 'account password', 'forgot password', 'reset password', '帳戶密碼', '账户密码', '忘記密碼', '忘记密码', '學生帳戶', '学生账户'],
  duo: ['duo', 'mfa', 'multi factor authentication', 'two factor authentication', '雙重認證', '双重认证', '兩步驗證', '两步验证', '換咗電話', '换了手机'],
  it_help: ['ito', 'it help', 'it support', 'service call centre', '電腦支援', '电脑支援', '技術支援', '技术支持', 'rrs303'],
  residence_check_in: ['residence check in', 'residence hall', 'student residence', 'village care', 'hostel check in', 'hostel', 'residence', '宿舍', '住宿', '入住', '入宿', 'check in'],
  campus_ar_navigation: ['campus map', 'academic registry', 'ar office', 'ar', 'sce tower', 'jc3', 'jockey club campus of creativity', '校園地圖', '校园地图', '教務處', '教务处', '學術註冊處', '学术注册处'],
  library: ['library', 'main library', 'chinese medicine library', 'shek mun campus library', 'cml', 'smcl', '主館', '主馆', '圖書館', '图书馆', '書館', '书馆'],
  dining: ['canteen', 'catering', 'restaurant', 'food', 'bu fiesta', 'main canteen', 'nan yuan', 'h f c scholars court', '飯堂', '饭堂', '餐廳', '餐厅', '食堂', '食嘢', '吃饭'],
  medical: ['health centre', 'health center', 'medical', 'doctor', 'dental', 'clinic', '健康中心', '醫療', '医疗', '睇醫生', '看医生', '牙科'],
  osa_counselling: ['office of student affairs', 'osa', 'student affairs', 'counselling', 'counseling', 'cdc', '學生事務處', '学生事务处', '輔導', '辅导', '心理諮詢', '心理咨询'],
  transport: ['transport', 'mtr', 'minibus', 'bus', 'kowloon tong station', 'kowloon tong', '交通', '港鐵', '港铁', '地鐵', '地铁', '小巴', '巴士', '九龍塘', '九龙塘'],
  emergency: ['emergency contacts', 'hkbu security', 'security hotline', '保安', '緊急聯絡', '紧急联络'],
  hall_facilities: ['hall facilities', 'common facilities', 'residence hall services', 'services in the residence halls', 'services are in the residence halls', 'music practice room', 'hall laundry', 'student residence halls laundry', 'srh laundry', 'nttih', 'dr ng tor tai international house', '宿舍設施', '宿舍设施', '宿舍服務', '宿舍服务', '公共設施', '公共设施', '音樂練習室', '音乐练习室', '洗衣房', 'srh 洗衣', '洗衣點樣畀錢', '洗衣怎么付款', '接待處', '接待处'],
  hall_maintenance: ['hall room has a defect', 'room has a defect', 'report a defect', 'hall maintenance', '宿舍房有故障', '宿舍房間有故障', '宿舍房间有故障', '申報故障', '申报故障', '宿舍維修', '宿舍维修'],
  international_support: ['international association', 'cultural ambassador', 'international student support', 'support for international students', 'support is available for international students', 'international students get support', 'services for international students', '國際學生支援', '国际学生支援', '國際學生支持', '国际学生支持', '國際學生服務', '国际学生服务', '國際學生可以去邊度搵支援', '國際學生去邊度搵支援', '國際學生有咩支援', '国际学生可以去哪里找支持', '国际学生去哪里找支持', '国际学生有哪些支持', '文化大使'],
  orientation: ['orientation resources', 'new student orientation', 'university orientation workshop', 'uow', 'fye', 'first year experience', 'u life', '迎新資源', '迎新资源', '新生迎新', '迎新工作坊'],
  dining_inventory: ['food outlets', 'catering outlets', 'outlets at', 'what outlets', '餐飲店', '餐饮店', '餐飲點', '餐饮点', '有咩餐廳', '有哪些餐厅'],
  language_learning: ['cantonese course', 'cantonese courses', 'learn cantonese', 'learning cantonese', 'cantonese peer tutoring', 'cantonese speaking coaching', 'language course', '廣東話', '广东话', '粵語課', '粤语课', '粵語學習', '粤语学习', '粵語口語輔導', '粤语口语辅导', '學習夥伴', '学习伙伴'],
  living_supplies: ['student welfare shop', 'welfare shop', 'bedding', 'grocery', 'groceries', 'grocery store', 'sim card', 'sim 卡', 'daily necessities', 'stationery', 'living supplies', '學生福利店', '学生福利店', '床品', '床上用品', '雜貨', '杂货', '日用品', '生活用品', '文具'],
});

const BRANCH_ALIASES = ['main library', '主館', '主馆', '主圖書館', '主图书馆', 'fong shu chuen library', 'cml', 'chinese medicine library', '中醫藥圖書館', '中医药图书馆', 'smcl', 'shek mun', '石門', '石门'];
const COHORT_ALIASES = ['non local freshman', 'non local freshmen', 'non-local freshman', 'local freshman', 'local freshmen', 'exchange student', 'exchange students', 'returning student', 'returning students', 'research postgraduate', 'research postgraduates', 'rpg', '非本地新生', '本地新生', '交換生', '交换生', '研究生', '舊生', '旧生'];
const STUDENT_PHOTO_DEADLINES = Object.freeze([
  Object.freeze({ value: '2026-08-02', aliases: ['2 august 2026', 'august 2 2026', '2 aug 2026', '2026-08-02', '2026年8月2日', '8月2日'] }),
  Object.freeze({ value: '2026-08-07', aliases: ['7 august 2026', 'august 7 2026', '7 aug 2026', '2026-08-07', '2026年8月7日', '8月7日'] }),
  Object.freeze({ value: '2026-08-23', aliases: ['23 august 2026', 'august 23 2026', '23 aug 2026', '2026-08-23', '2026年8月23日', '8月23日'] }),
  Object.freeze({ value: '2026-09-01', aliases: ['1 september 2026', 'september 1 2026', '1 sep 2026', '2026-09-01', '2026年9月1日', '9月1日'] }),
]);
const CURRENT_HOURS_ALIASES = ['today', 'current', 'now', '今日', '今天', '而家', '現在', '现在', '幾點', '几点'];
const CURRENT_AVAILABILITY_ALIASES = [
  ...CURRENT_HOURS_ALIASES,
  'open', 'currently', 'availability', 'right now', 'can i get', 'can i join', 'apply today',
  '有冇得用', '可唔可以用', '可以用嗎', '可以用吗', '可唔可以申請', '可以申請', '可以申请',
  '開唔開', '开不开', '開門', '开门', '營業', '营业', '開放', '开放',
];
const DINING_OUTLET_ALIASES = [
  'bu fiesta', 'main canteen', 'nan yuan', 'h f c scholars court', '主飯堂', '主食堂',
];
const DINING_OPEN_STATE_ALIASES = ['open', 'closed', '營業', '营业', '開門', '开门', '開', '开'];
const DINING_OPEN_SET_ALIASES = [
  'what food', 'which canteen', 'what canteen', 'which restaurant', 'what restaurant',
  'what else', 'where else', 'anything else', 'other than', 'besides',
  '其他', '其它', '仲有', '還有', '还有', '有咩食', '有什么吃', '邊間', '边间', '哪間', '哪间',
];
const LIVE_DINING_TELEMETRY_ALIASES = [
  'queue', 'queue length', 'wait time', 'waiting time', 'how crowded', 'crowded',
  'occupancy', 'available seat', 'available seats', 'number of people',
  '排隊', '排队', '等候時間', '等待时间', '人流', '擠唔擠', '挤不挤', '多人', '多少人', '有位', '有座位',
];
const TRANSPORT_DIRECTION_ALIASES = [
  'how do i get', 'how to get', 'get from', 'route from', 'route to',
  '點去', '点去', '點樣去', '点样去', '怎麼去', '怎么去', '如何去',
];
const GENERIC_HALL_FACILITY_ALIASES = [
  'hall facilities', 'residence hall services', 'services in the residence halls',
  'services are in the residence halls',
  '宿舍設施', '宿舍设施', '宿舍服務', '宿舍服务',
];
const NTTIH_REVIEWED_INCLUSION_ALIASES = [
  'provide bedding', 'include bedding', 'bedding provided', 'basic bedding',
  '有冇床品', '提供床品', '提供床上用品', '有床上用品',
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeKnowledgeQuery(value) {
  return String(value ?? '')
    .slice(0, 8192)
    .normalize('NFKC')
    .replace(/[\p{Cf}\u180E]/gu, '')
    .replace(/([a-zA-Z0-9])([\p{Script=Han}])/gu, '$1 $2')
    .replace(/([\p{Script=Han}])([a-zA-Z0-9])/gu, '$1 $2')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function phraseMatches(query, rawPhrase) {
  const phrase = normalizeKnowledgeQuery(rawPhrase);
  if (!phrase) return false;
  if (/\p{Script=Han}/u.test(phrase)) return query.includes(phrase);
  const candidateQuery = phrase === 'jupas'
    ? query.replace(/(?:^|[^\p{L}\p{N}])non jupas(?=$|[^\p{L}\p{N}])/gu, ' ')
    : query;
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(phrase)}(?:$|[^\\p{L}\\p{N}])`, 'u').test(candidateQuery);
}

function scoreClaim(claim, query) {
  let score = 0;
  for (const keyword of claim.keywords ?? []) {
    if (phraseMatches(query, keyword)) score += 100 + normalizeKnowledgeQuery(keyword).length;
  }
  return score;
}

function matchedIntents(query) {
  const matches = [];
  for (const [intent, aliases] of Object.entries(INTENT_ALIASES)) {
    let score = 0;
    for (const alias of aliases) {
      if (phraseMatches(query, alias)) score = Math.max(score, 1_000 + normalizeKnowledgeQuery(alias).length);
    }
    if (score > 0) matches.push({ intent, score });
  }
  return matches;
}

function primaryIntent(query) {
  const matches = matchedIntents(query);
  const available = new Set(matches.map(({ intent }) => intent));
  if (available.has('hall_facilities')
    && hasAny(query, ['nttih', 'dr ng tor tai international house'])
    && (!available.has('living_supplies') || hasAny(query, NTTIH_REVIEWED_INCLUSION_ALIASES))) {
    return 'hall_facilities';
  }
  const contextualPriority = [
    ['living_supplies', INTENT_ALIASES.living_supplies],
    ['hall_maintenance', INTENT_ALIASES.hall_maintenance],
    ['orientation', INTENT_ALIASES.orientation],
    ['dining_inventory', INTENT_ALIASES.dining_inventory],
    ['language_learning', INTENT_ALIASES.language_learning],
    ['international_support', INTENT_ALIASES.international_support],
    ['hall_facilities', INTENT_ALIASES.hall_facilities],
  ];
  for (const [intent, aliases] of contextualPriority) {
    if (available.has(intent) && hasAny(query, aliases)) return intent;
  }
  if (available.has('transport') && hasAny(query, [
    'mtr', 'minibus', 'bus', '港鐵', '港铁', '地鐵', '地铁', '小巴', '巴士',
    ...TRANSPORT_DIRECTION_ALIASES,
  ])) {
    return 'transport';
  }
  return matches.sort((left, right) => right.score - left.score || left.intent.localeCompare(right.intent))[0]?.intent ?? null;
}

function sourceSpecificity(source, query) {
  let score = 0;
  if (phraseMatches(query, source.title)) score += 600 + normalizeKnowledgeQuery(source.title).length;
  for (const example of source.exampleQuestions) {
    if (phraseMatches(query, example)) score += 400 + normalizeKnowledgeQuery(example).length;
  }
  for (const tag of source.tags) {
    if (phraseMatches(query, tag)) score += 200 + normalizeKnowledgeQuery(tag).length;
  }
  const uniqueClaimKeywords = new Map();
  for (const claim of source.claims) {
    for (const keyword of claim.keywords ?? []) {
      uniqueClaimKeywords.set(normalizeKnowledgeQuery(keyword), keyword);
    }
  }
  for (const keyword of uniqueClaimKeywords.values()) {
    if (phraseMatches(query, keyword)) score += 120 + normalizeKnowledgeQuery(keyword).length;
  }
  return score;
}

function structuredStudentRoute(query) {
  const admissionRoute = hasAny(query, ['non jupas', 'non-jupas'])
    ? 'Non-JUPAS'
    : (hasAny(query, ['jupas']) ? 'JUPAS' : null);
  const matchedDeadline = STUDENT_PHOTO_DEADLINES.find(
    ({ aliases }) => hasAny(query, aliases),
  );
  return {
    admissionRoute,
    photoUploadDeadline: matchedDeadline?.value ?? null,
  };
}

function claimDeadlineDate(claim) {
  const value = claim.facts?.photoUploadDeadline;
  return typeof value === 'string' ? value.slice(0, 10) : null;
}

function explicitQueryYears(query) {
  return new Set(
    [...query.matchAll(/(?:^|[^\p{N}])((?:19|20)\d{2})(?=$|[^\p{N}])/gu)]
      .map((match) => Number(match[1])),
  );
}

function structuredClaimYears(claim) {
  const years = new Set();
  if (Number.isInteger(claim.facts?.scheduleYear)) years.add(claim.facts.scheduleYear);
  for (const field of [
    'photoUploadDeadline', 'collectionStarts', 'earliestCheckIn', 'onOrAfterDate', 'effectiveFrom',
  ]) {
    const match = String(claim.facts?.[field] ?? '').match(/(?:19|20)\d{2}/);
    if (match) years.add(Number(match[0]));
  }
  for (const field of ['academicYear', 'period']) {
    const match = String(claim.facts?.[field] ?? '').match(/(?:19|20)\d{2}/);
    if (match) years.add(Number(match[0]));
  }
  return years;
}

function structuredSourceYears(source) {
  const years = new Set();
  for (const claim of source.claims) {
    for (const year of structuredClaimYears(claim)) years.add(year);
  }
  return years;
}

function hasStructuredYearMismatch(source, query) {
  const queryYears = explicitQueryYears(query);
  const sourceYears = structuredSourceYears(source);
  return queryYears.size > 0 && sourceYears.size > 0
    && [...queryYears].some((year) => !sourceYears.has(year));
}

function isDiningOpenSetQuery(query) {
  return hasAny(query, INTENT_ALIASES.dining)
    && hasAny(query, DINING_OPEN_STATE_ALIASES)
    && hasAny(query, DINING_OPEN_SET_ALIASES);
}

function selectClaims(source, query) {
  const queryYears = explicitQueryYears(query);
  if (hasStructuredYearMismatch(source, query)) return [];
  const rows = source.claims.map((claim) => ({
    claim,
    source,
    claimScore: scoreClaim(claim, query),
  })).filter(({ claim }) => {
    const claimYears = structuredClaimYears(claim);
    return queryYears.size === 0 || claimYears.size === 0
      || [...queryYears].every((year) => claimYears.has(year));
  });
  if (source.id === 'hkbu.ar.student-card-collection') {
    const route = structuredStudentRoute(query);
    if (route.admissionRoute || route.photoUploadDeadline) {
      return rows.filter(({ claim }) => {
        if (route.photoUploadDeadline
          && claimDeadlineDate(claim) !== route.photoUploadDeadline) return false;
        if (route.admissionRoute && claim.facts?.requirements?.admissionRoute
          && claim.facts?.admissionRoute !== route.admissionRoute) return false;
        return true;
      });
    }
  }
  const maximum = Math.max(0, ...rows.map(({ claimScore }) => claimScore));
  if (maximum === 0 && [
    'hkbu.ar.exchange-language-courses',
    'hkbu.sa.student-welfare-shop',
    'hkbu.sa.u-life',
  ].includes(source.id)) return [];
  if (maximum === 0) return rows;
  return rows.filter(({ claimScore }) => claimScore === maximum);
}

function hasAny(query, aliases) {
  return aliases.some((alias) => phraseMatches(query, alias));
}

function rankSources(corpus, query, intent) {
  const selected = new Map();
  const asksCurrentHours = hasAny(query, CURRENT_HOURS_ALIASES);
  const asksCurrentDining = asksCurrentHours || hasAny(query, DINING_OPEN_STATE_ALIASES);
  const hasDiningOpenSetIntent = isDiningOpenSetQuery(query);
  const hasExplicitDiningOutlet = !hasDiningOpenSetIntent && hasAny(query, DINING_OUTLET_ALIASES);
  const requiresDiningSetGuard = hasDiningOpenSetIntent
    || (asksCurrentDining && !hasExplicitDiningOutlet);
  const asksGenericHallFacilities = intent === 'hall_facilities'
    && hasAny(query, GENERIC_HALL_FACILITY_ALIASES)
    && !hasAny(query, ['nttih', 'dr ng tor tai international house']);
  for (const { intent: matchedIntent, score: intentScore } of matchedIntents(query)) {
    if (matchedIntent !== intent) continue;
    const candidates = corpus.sources
      .filter((source) => source.intentGroups.includes(matchedIntent))
      .filter((source) => (
        matchedIntent !== 'dining'
        || !requiresDiningSetGuard
        || source.id === 'hkbu.eo.dining-overview'
      ))
      .filter((source) => (
        !asksGenericHallFacilities || source.id === 'hkbu.sa.hall-facilities'
      ))
      .map((source) => ({ source, specificity: sourceSpecificity(source, query) }));
    const maximum = Math.max(0, ...candidates.map(({ specificity }) => specificity));
    const gated = maximum > 0
      ? candidates.filter(({ specificity }) => specificity === maximum)
      : candidates;
    for (const { source, specificity } of gated) {
      const score = intentScore + specificity;
      const previous = selected.get(source.id);
      if (!previous || score > previous.score) selected.set(source.id, { source, score });
    }
  }

  const ranked = [...selected.values()]
    .sort((left, right) => right.score - left.score || left.source.id.localeCompare(right.source.id));
  const hasMainCanteen = ranked.some(({ source }) => source.id === 'hkbu.eo.dining.main-canteen');
  const hasDiningGuard = ranked.some(({ source }) => source.id === 'hkbu.eo.dining-overview');
  if (asksCurrentDining && hasMainCanteen && !hasDiningGuard) {
    const guard = corpus.sources.find((source) => source.id === 'hkbu.eo.dining-overview');
    if (guard) ranked.push({ source: guard, score: Math.max(1, (ranked[0]?.score ?? 2) - 1) });
  }
  return ranked.sort(
    (left, right) => right.score - left.score || left.source.id.localeCompare(right.source.id),
  );
}

function ambiguityFor(query, ranked, selectedClaims) {
  const codes = [];
  const yearMismatchSources = ranked
    .map(({ source }) => source)
    .filter((source) => hasStructuredYearMismatch(source, query));
  const collectionYearMismatch = yearMismatchSources.some(
    (source) => source.id === 'hkbu.ar.student-card-collection',
  );
  if (collectionYearMismatch) codes.push('STUDENT_CARD_ROUTE_YEAR_MISMATCH');
  if (yearMismatchSources.some((source) => source.id !== 'hkbu.ar.student-card-collection')) {
    codes.push('SCHEDULE_YEAR_MISMATCH');
  }
  const relevantOfficialClaims = selectedClaims
    .map(({ claim }) => claim)
    .filter((claim) => claim.verificationStatus === 'official_verified');

  const asksLiveDiningTelemetry = ranked.some(({ source }) => (
    source.intentGroups.includes('dining') || source.intentGroups.includes('dining_inventory')
  )) && hasAny(query, LIVE_DINING_TELEMETRY_ALIASES);
  if (asksLiveDiningTelemetry) codes.push('LIVE_DINING_STATUS_UNAVAILABLE');

  const hasLibrary = ranked.some(({ source }) => source.intentGroups.includes('library'));
  const libraryBranches = new Set(
    relevantOfficialClaims.map((claim) => claim.facts?.branch).filter(Boolean),
  );
  if (hasLibrary && (libraryBranches.size !== 1 || !hasAny(query, BRANCH_ALIASES))) {
    codes.push('LIBRARY_BRANCH_REQUIRED');
  }

  const residenceClaims = relevantOfficialClaims.filter((claim) => claim.facts?.residenceType);
  if (residenceClaims.length > 0) {
    const residenceTypes = new Set(residenceClaims.map((claim) => claim.facts.residenceType));
    const cohorts = new Set(residenceClaims.map((claim) => claim.facts.cohort));
    if (residenceTypes.size !== 1) codes.push('RESIDENCE_TYPE_REQUIRED');
    if (cohorts.size !== 1 || !hasAny(query, COHORT_ALIASES)) {
      codes.push('RESIDENCE_COHORT_REQUIRED');
    }
  }

  const collectionClaims = selectedClaims
    .filter(({ source }) => source.id === 'hkbu.ar.student-card-collection')
    .map(({ claim }) => claim);
  const collectionSource = ranked.find(
    ({ source }) => source.id === 'hkbu.ar.student-card-collection',
  )?.source;
  if (collectionSource) {
    const route = structuredStudentRoute(query);
    if (!collectionYearMismatch && route.admissionRoute
      && route.photoUploadDeadline && collectionClaims.length === 0) {
      codes.push('STUDENT_CARD_ROUTE_MISMATCH');
    }
    const requiresAdmissionRoute = collectionClaims.some(
      (claim) => claim.facts?.requirements?.admissionRoute,
    );
    const requiresPhotoUploadRoute = collectionClaims.some(
      (claim) => claim.facts?.requirements?.photoUploadRoute,
    );
    if (requiresAdmissionRoute && !route.admissionRoute) {
      codes.push('STUDENT_CARD_ADMISSION_ROUTE_REQUIRED');
    }
    if (requiresPhotoUploadRoute && !route.photoUploadDeadline) {
      codes.push('STUDENT_CARD_PHOTO_UPLOAD_ROUTE_REQUIRED');
    }
  }

  const asksCurrentDining = hasAny(query, CURRENT_HOURS_ALIASES)
    || hasAny(query, DINING_OPEN_STATE_ALIASES);
  const hasDiningOpenSetIntent = isDiningOpenSetQuery(query);
  const diningClaims = relevantOfficialClaims.filter((claim) => (
    claim.facts?.regularHoursOnly
    || claim.facts?.specialHoursOverrideRegular
    || claim.facts?.open === false
  ));
  const hasDefinitiveClosure = !hasDiningOpenSetIntent
    && hasAny(query, ['bu fiesta']) && diningClaims.some(
    (claim) => claim.facts?.open === false && claim.facts?.until === 'further_notice',
  );
  if (asksCurrentDining && diningClaims.length > 0 && !hasDefinitiveClosure) {
    codes.push('CATERING_SPECIAL_HOURS_REQUIRED');
  }
  const asksCurrentAvailability = hasAny(query, CURRENT_AVAILABILITY_ALIASES);
  if (!codes.includes('CATERING_SPECIAL_HOURS_REQUIRED')
    && asksCurrentAvailability && relevantOfficialClaims.some((claim) => (
    claim.facts?.inventoryOnly || claim.facts?.listedHoursOnly || claim.facts?.scopeOnly
  ))) {
    codes.push('CURRENT_AVAILABILITY_REQUIRED');
  }
  if (!codes.some((code) => code.startsWith('RESIDENCE_'))
    && selectedClaims.some(({ claim }) => claim.facts?.mustNotPromote)) {
    codes.push('CONFLICTED_LIVE_STATUS');
  }
  return [...new Set(codes)];
}

function isBlockedByClarification(claim, ambiguityCodes, query) {
  if (ambiguityCodes.includes('LIVE_DINING_STATUS_UNAVAILABLE')) return true;
  if (claim.sourceId === 'hkbu.ar.student-card-collection'
    && ambiguityCodes.some((code) => code.startsWith('STUDENT_CARD_'))) return true;
  if (claim.facts?.branch && ambiguityCodes.includes('LIBRARY_BRANCH_REQUIRED')) return true;
  if (claim.facts?.residenceType
    && ambiguityCodes.some((code) => code.startsWith('RESIDENCE_'))) return true;
  if (claim.sourceId === 'hkbu.sa.residence-halls-check-in'
    && !claim.facts?.mustNotPromote
    && ambiguityCodes.some((code) => code.startsWith('RESIDENCE_'))) return true;
  if (claim.facts?.regularHoursOnly
    && ambiguityCodes.includes('CATERING_SPECIAL_HOURS_REQUIRED')) return true;
  if ((claim.facts?.inventoryOnly || claim.facts?.listedHoursOnly || claim.facts?.scopeOnly)
    && (ambiguityCodes.includes('CURRENT_AVAILABILITY_REQUIRED')
      || (claim.facts?.inventoryOnly
        && ambiguityCodes.includes('CATERING_SPECIAL_HOURS_REQUIRED')))) return true;
  if (claim.facts?.open === false
    && ambiguityCodes.includes('CATERING_SPECIAL_HOURS_REQUIRED')
    && (!hasAny(query, ['bu fiesta']) || isDiningOpenSetQuery(query))) return true;
  return false;
}

function handoffFor(intent, ranked, ambiguityCodes) {
  const topSourceId = ranked[0]?.source.id ?? null;
  if (ambiguityCodes.includes('CURRENT_AVAILABILITY_REQUIRED') && topSourceId) return topSourceId;
  const fixed = {
    student_card: 'hkbu.ar.contact',
    account_password: 'hkbu.ito.contact',
    duo: 'hkbu.ito.contact',
    it_help: 'hkbu.ito.contact',
    residence_check_in: 'hkbu.sa.accm-contact',
    hall_facilities: 'hkbu.sa.accm-contact',
    hall_maintenance: 'hkbu.sa.accm-contact',
    international_support: 'hkbu.sa.international-support',
    orientation: topSourceId,
    library: 'hkbu.library.hours',
    dining: 'hkbu.eo.dining-overview',
    dining_inventory: 'hkbu.eo.dining-overview',
    transport: 'hkbu.eo.campus-map',
    language_learning: 'hkbu.ar.exchange-language-courses',
    living_supplies: 'hkbu.sa.accm-contact',
    medical: 'hkbu.eo.medical',
    osa_counselling: 'hkbu.sa.counselling',
  };
  return fixed[intent] ?? null;
}

function conflictMetadataRows(ranked, selectedClaims) {
  const selectedIds = new Set(selectedClaims.map(({ claim }) => claim.id));
  const rows = [];
  for (const { source } of ranked) {
    for (const claim of source.claims) {
      if (selectedIds.has(claim.id)) continue;
      if (claim.verificationStatus === 'conflicted' && claim.facts?.mustNotPromote) {
        rows.push({ claim, source, claimScore: 0 });
      }
    }
  }
  return rows;
}

export function createRetriever({ corpus, now = () => new Date() }) {
  if (!corpus?.sources) throw new Error('a validated corpus is required');
  if (typeof now !== 'function') throw new Error('now must be an injected clock function');

  function retrieve(input) {
    const safety = routeSafety(input);
    if (safety.kind === 'emergency') {
      return {
        ...safety,
        intent: 'emergency',
        topSourceId: 'hkbu.eo.security',
        claims: [],
        supportableClaims: [],
        staleClaims: [],
        evidenceIds: [],
        sources: [],
        needsClarification: false,
        ambiguityCodes: [],
        handoffSourceId: null,
      };
    }

    const query = normalizeKnowledgeQuery(input);
    const intent = query ? primaryIntent(query) : null;
    const ranked = query && intent ? rankSources(corpus, query, intent) : [];
    const selectedClaims = ranked.flatMap(({ source }) => selectClaims(source, query));
    const ambiguityCodes = query ? ambiguityFor(query, ranked, selectedClaims) : ['QUERY_REQUIRED'];
    if (query && intent !== 'language_learning'
      && (ranked.length === 0 || selectedClaims.length === 0)) {
      ambiguityCodes.push('NO_MATCHING_OFFICIAL_EVIDENCE');
    }
    if (intent === 'language_learning' && selectedClaims.length === 0) {
      ambiguityCodes.push('NO_CURRENT_PROGRAMME_EVIDENCE');
    }
    if (intent === 'living_supplies' && selectedClaims.length === 0) {
      ambiguityCodes.push('NO_MATCHING_OFFICIAL_EVIDENCE');
    }

    const current = now();
    if (!(current instanceof Date) || Number.isNaN(current.getTime())) throw new Error('injected clock returned an invalid instant');
    const claimRows = [];
    const sourceScores = new Map(ranked.map(({ source, score }) => [source.id, score]));
    const rowsWithMetadata = [
      ...selectedClaims,
      ...conflictMetadataRows(ranked, selectedClaims),
    ];
    for (const { claim, source, claimScore } of rowsWithMetadata) {
      if (isBlockedByClarification(claim, ambiguityCodes, query)) continue;
      claimRows.push({
        ...claim,
        status: evaluateClaimFreshness(claim, current),
        sourceTitle: source.title,
        canonicalUrl: source.canonicalUrl,
        _rank: (sourceScores.get(source.id) ?? 0) + claimScore,
      });
    }
    claimRows.sort((left, right) => right._rank - left._rank || left.id.localeCompare(right.id));
    const publicClaim = ({ _rank, ...claim }) => claim;
    const supportableClaims = claimRows.filter((claim) => claim.status === 'verified').map(publicClaim);
    const staleClaims = claimRows.filter((claim) => claim.status !== 'verified').map(publicClaim);
    const sources = ranked.map(({ source }) => ({
      id: source.id,
      title: source.title,
      publisher: source.publisher,
      canonicalUrl: source.canonicalUrl,
      risk: source.risk,
      verifiedAt: source.verifiedAt,
    }));

    return {
      kind: 'knowledge',
      intent,
      query,
      topSourceId: ranked[0]?.source.id ?? null,
      claims: supportableClaims,
      supportableClaims,
      staleClaims,
      evidenceIds: supportableClaims.map((claim) => claim.id),
      sources,
      needsClarification: ambiguityCodes.length > 0,
      ambiguityCodes: [...new Set(ambiguityCodes)],
      handoffSourceId: supportableClaims.length === 0
        ? handoffFor(intent, ranked, ambiguityCodes)
        : null,
    };
  }

  return { retrieve };
}
