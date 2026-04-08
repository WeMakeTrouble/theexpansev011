import pool from './db/pool.js';
import commonWordFilter from './utils/commonWordFilter.js';
import referenceDetector from './services/referenceDetector.js';

let passed = 0;
let failed = 0;
let total = 0;

function check(testName, result, expectShouldAsk, expectMinCandidates, expectMaxCandidates, expectPhrase) {
  total++;
  const shouldAskOk = result.shouldAsk === expectShouldAsk;
  const countOk = result.candidates.length >= expectMinCandidates
    && result.candidates.length <= expectMaxCandidates;
  const phraseOk = !expectPhrase
    || result.candidates.some(c => c.phrase.toLowerCase() === expectPhrase.toLowerCase());

  const ok = shouldAskOk && countOk && phraseOk;

  if (ok) {
    passed++;
    console.log('PASS  ' + testName);
  } else {
    failed++;
    console.log('FAIL  ' + testName);
    if (!shouldAskOk) console.log('       shouldAsk: got ' + result.shouldAsk + ', expected ' + expectShouldAsk);
    if (!countOk) console.log('       candidates: got ' + result.candidates.length + ', expected ' + expectMinCandidates + '-' + expectMaxCandidates);
    if (expectPhrase && !phraseOk) console.log('       missing phrase: ' + expectPhrase);
    console.log('       candidates: ' + result.candidates.map(c => c.phrase + '(' + c.signal + ',' + c.context_score + ')').join(', '));
  }
}

async function runTests() {
  console.log('Warming up commonWordFilter...');
  await commonWordFilter.warmUp(pool);
  console.log('Ready.\n');

  const uid = '#D00006';

  console.log('=== CONTEXTUAL GUARD TESTS (Signal 1 false positive rejection) ===\n');

  check('indefinite article: a Person',
    await referenceDetector.detectReferences('a Person', uid),
    false, 0, 0, null);

  check('indefinite article: a Country',
    await referenceDetector.detectReferences('a Country', uid),
    false, 0, 0, null);

  check('indefinite article: an Animal',
    await referenceDetector.detectReferences('an Animal', uid),
    false, 0, 0, null);

  check('negation + article: not a Person',
    await referenceDetector.detectReferences('not a Person', uid),
    false, 0, 0, null);

  check('negation + article: its a Country not a Person',
    await referenceDetector.detectReferences('its a Country not a Person', uid),
    false, 0, 0, null);

  check('negation + article: never a Problem',
    await referenceDetector.detectReferences('never a Problem', uid),
    false, 0, 0, null);

  check('all caps: PERSON',
    await referenceDetector.detectReferences('PERSON', uid),
    false, 0, 0, null);

  check('all caps: I LOVE SCHOOL',
    await referenceDetector.detectReferences('I LOVE SCHOOL', uid),
    false, 0, 0, null);

  check('all caps mid-sentence: that was totally AWESOME dude',
    await referenceDetector.detectReferences('that was totally AWESOME dude', uid),
    false, 0, 0, null);

  check('definition pattern: a House is where you live',
    await referenceDetector.detectReferences('a House is where you live', uid),
    false, 0, 0, null);

  check('correction pattern: I said a Book not a Movie',
    await referenceDetector.detectReferences('I said a Book not a Movie', uid),
    false, 0, 0, null);

  console.log('\n=== COMMON NOUN REJECTION (vocabulary filter) ===\n');

  check('common noun: my homework is due',
    await referenceDetector.detectReferences('my homework is due', uid),
    false, 0, 0, null);

  check('common noun: going to school tomorrow',
    await referenceDetector.detectReferences('going to School tomorrow', uid),
    false, 0, 0, null);

  check('common noun: I love my house',
    await referenceDetector.detectReferences('I love my House', uid),
    false, 0, 0, null);

  check('common noun: at the park today',
    await referenceDetector.detectReferences('we went to Park today', uid),
    false, 0, 0, null);

  check('common noun: my friend is nice',
    await referenceDetector.detectReferences('my Friend is nice', uid),
    false, 0, 0, null);

  check('common noun: the teacher was good',
    await referenceDetector.detectReferences('the Teacher was good', uid),
    false, 0, 0, null);

  check('common noun: my brother is tall',
    await referenceDetector.detectReferences('my Brother is tall', uid),
    false, 0, 0, null);

  check('common noun: going to church',
    await referenceDetector.detectReferences('going to Church on Sunday', uid),
    false, 0, 0, null);

  check('common noun: at hospital',
    await referenceDetector.detectReferences('she is at Hospital', uid),
    false, 0, 0, null);

  check('common noun: my phone is broken',
    await referenceDetector.detectReferences('my Phone is broken', uid),
    false, 0, 0, null);

  console.log('\n=== SIGNAL 1: CAPITALISED NON-SENTENCE-INITIAL ===\n');

  check('simple name mid-sentence: I saw Tom',
    await referenceDetector.detectReferences('I saw Tom yesterday', uid),
    true, 1, 1, 'Tom');

  check('name mid-sentence: hanging out with Max',
    await referenceDetector.detectReferences('I was hanging out with Max yesterday', uid),
    true, 1, 1, 'Max');

  check('apostrophe name: met O\'Connor today',
    await referenceDetector.detectReferences('I met O\'Connor today', uid),
    true, 1, 1, 'O\'Connor');

  check('hyphenated name: talked to Jean-Luc',
    await referenceDetector.detectReferences('I talked to Jean-Luc about it', uid),
    true, 1, 1, 'Jean-Luc');

  check('multiple names: with Tom and Sarah',
    await referenceDetector.detectReferences('I went with Tom and Sarah', uid),
    true, 2, 2, 'Tom');

  check('sentence-initial should be skipped: Tom went home. Sarah left.',
    await referenceDetector.detectReferences('Tom went home. Sarah left.', uid),
    false, 0, 0, null);

  check('after period is sentence start: I left. Tom arrived.',
    await referenceDetector.detectReferences('I left. Tom arrived.', uid),
    false, 0, 0, null);

  check('after exclamation: wow! Max came over',
    await referenceDetector.detectReferences('wow! Max came over', uid),
    false, 0, 0, null);

  check('after question mark: really? Sarah said that',
    await referenceDetector.detectReferences('really? Sarah said that', uid),
    false, 0, 0, null);

  console.log('\n=== SIGNAL 2: POSSESSIVE + CAPITALISED ===\n');

  check('my + name: my Max is cute',
    await referenceDetector.detectReferences('my Max is cute', uid),
    true, 1, 1, 'Max');

  check('our + name: our Sarah won',
    await referenceDetector.detectReferences('our Sarah won the race', uid),
    true, 1, 1, 'Sarah');

  check('his + name: his Rex barked',
    await referenceDetector.detectReferences('his Rex barked all night', uid),
    true, 1, 1, 'Rex');

  check('her + name: her Luna is sweet',
    await referenceDetector.detectReferences('her Luna is sweet', uid),
    true, 1, 1, 'Luna');

  check('their + name: their Bella escaped',
    await referenceDetector.detectReferences('their Bella escaped again', uid),
    true, 1, 1, 'Bella');

  check('possessive + common rejected: my School',
    await referenceDetector.detectReferences('my School is big', uid),
    false, 0, 0, null);

  check('possessive + common rejected: my Computer',
    await referenceDetector.detectReferences('my Computer is slow', uid),
    false, 0, 0, null);

  console.log('\n=== SIGNAL 3: PREPOSITION + CAPITALISED ===\n');

  check('going to + place: going to Bondi',
    await referenceDetector.detectReferences('going to Bondi after lunch', uid),
    true, 1, 1, 'Bondi');

  check('at + place: at Shibuya',
    await referenceDetector.detectReferences('I am at Shibuya right now', uid),
    true, 1, 1, 'Shibuya');

  check('from + place: from Melbourne',
    await referenceDetector.detectReferences('she came from Melbourne', uid),
    true, 1, 1, 'Melbourne');

  check('near + place: near Coogee',
    await referenceDetector.detectReferences('we live near Coogee', uid),
    true, 1, 1, 'Coogee');

  check('live in + place: live in Surry',
    await referenceDetector.detectReferences('I live in Surry', uid),
    true, 1, 1, 'Surry');

  check('moved to + place: moved to Darwin',
    await referenceDetector.detectReferences('we moved to Darwin last year', uid),
    true, 1, 1, 'Darwin');

  check('been to + place: been to Kyoto',
    await referenceDetector.detectReferences('have you been to Kyoto', uid),
    true, 1, 1, 'Kyoto');

  check('preposition + common rejected: going to School',
    await referenceDetector.detectReferences('going to School now', uid),
    false, 0, 0, null);

  console.log('\n=== SIGNAL 4: RELATIONSHIP INTRODUCTION ===\n');

  check('name is my dog: Max is my dog',
    await referenceDetector.detectReferences('Max is my dog', uid),
    true, 1, 1, 'Max');

  check('name is a friend: Sarah is a friend',
    await referenceDetector.detectReferences('Sarah is a friend from school', uid),
    true, 1, 1, 'Sarah');

  check('name is my sister: Luna is my sister',
    await referenceDetector.detectReferences('Luna is my sister', uid),
    true, 1, 1, 'Luna');

  check('name is the teacher: Rex is the teacher',
    await referenceDetector.detectReferences('Rex is the teacher', uid),
    true, 1, 1, 'Rex');

  check('name is an artist: Kai is an artist',
    await referenceDetector.detectReferences('Kai is an artist', uid),
    true, 1, 1, 'Kai');

  check('score is 0.88: relationship intro score',
    await referenceDetector.detectReferences('Zara is my cat', uid),
    true, 1, 1, 'Zara');

  console.log('\n=== SIGNAL 5: QUALIFIED POSSESSIVE ===\n');

  check('my little + name: my little Rex',
    await referenceDetector.detectReferences('my little Rex is sleeping', uid),
    true, 1, 1, 'Rex');

  check('my best + name: my best Sarah',
    await referenceDetector.detectReferences('my best Sarah always helps', uid),
    true, 1, 1, 'Sarah');

  check('my old + name: my old Benny',
    await referenceDetector.detectReferences('my old Benny passed away', uid),
    true, 1, 1, 'Benny');

  check('my dear + name: my dear Nana',
    await referenceDetector.detectReferences('my dear Nana visited us', uid),
    true, 1, 1, 'Nana');

  check('our favourite + name: our favourite Mochi',
    await referenceDetector.detectReferences('our favourite Mochi is fluffy', uid),
    true, 1, 1, 'Mochi');

  check('score is 0.91: qualified possessive highest',
    await referenceDetector.detectReferences('my lovely Bella is here', uid),
    true, 1, 1, 'Bella');

  console.log('\n=== DEDUPLICATION ===\n');

  check('same name twice: I saw Max and Max ran',
    await referenceDetector.detectReferences('I saw Max and Max ran away', uid),
    true, 1, 1, 'Max');

  check('dedup keeps highest score: Max is my dog Max',
    await referenceDetector.detectReferences('Max is my dog and Max is cute', uid),
    true, 1, 1, 'Max');

  console.log('\n=== EDGE CASES ===\n');

  check('empty string',
    await referenceDetector.detectReferences('', uid),
    false, 0, 0, null);

  check('null input',
    await referenceDetector.detectReferences(null, uid),
    false, 0, 0, null);

  check('undefined input',
    await referenceDetector.detectReferences(undefined, uid),
    false, 0, 0, null);

  check('single word: hi',
    await referenceDetector.detectReferences('hi', uid),
    false, 0, 0, null);

  check('all lowercase: max is my dog',
    await referenceDetector.detectReferences('max is my dog', uid),
    false, 0, 0, null);

  check('all lowercase names: i saw tom and sarah',
    await referenceDetector.detectReferences('i saw tom and sarah', uid),
    false, 0, 0, null);

  check('numbers only: 12345',
    await referenceDetector.detectReferences('12345', uid),
    false, 0, 0, null);

  check('special characters: @$%^&',
    await referenceDetector.detectReferences('@$%^&', uid),
    false, 0, 0, null);

  check('very short name: I saw Jo',
    await referenceDetector.detectReferences('I saw Jo yesterday', uid),
    true, 1, 1, 'Jo');

  check('single char name rejected: I met A today',
    await referenceDetector.detectReferences('I met A today', uid),
    false, 0, 0, null);

  check('no userId: still detects but skips gazetteer',
    await referenceDetector.detectReferences('I saw Max yesterday', null),
    true, 1, 1, 'Max');

  console.log('\n=== AMBIGUOUS NAME WORDS ===\n');

  check('ambiguous: my Grace is lovely',
    await referenceDetector.detectReferences('my Grace is lovely', uid),
    true, 1, 1, 'Grace');

  check('ambiguous: my Hope keeps me going',
    await referenceDetector.detectReferences('my Hope keeps me going', uid),
    true, 1, 1, 'Hope');

  check('ambiguous: I talked to Rose',
    await referenceDetector.detectReferences('I talked to Rose yesterday', uid),
    true, 1, 1, 'Rose');

  check('ambiguous: with Dawn at the park',
    await referenceDetector.detectReferences('I was with Dawn at the park', uid),
    true, 1, 1, 'Dawn');

  check('ambiguous: my Faith is strong (context dependent)',
    await referenceDetector.detectReferences('my Faith is strong', uid),
    true, 1, 1, 'Faith');

  check('ambiguous: met Holly today',
    await referenceDetector.detectReferences('I met Holly today', uid),
    true, 1, 1, 'Holly');

  check('ambiguous: with Lily at school',
    await referenceDetector.detectReferences('I was with Lily at school', uid),
    true, 1, 1, 'Lily');

  check('ambiguous: Jack is my mate',
    await referenceDetector.detectReferences('Jack is my mate', uid),
    true, 1, 1, 'Jack');

  console.log('\n=== MULTI-SIGNAL OVERLAP (correct dedup + highest score) ===\n');

  check('capitalised + relationship: Max is my dog (keeps 0.88)',
    await referenceDetector.detectReferences('Max is my dog', uid),
    true, 1, 1, 'Max');

  check('capitalised + possessive: my Max (keeps 0.82)',
    await referenceDetector.detectReferences('I love my Max so much', uid),
    true, 1, 1, 'Max');

  check('capitalised + preposition: to Bondi (keeps 0.78)',
    await referenceDetector.detectReferences('I went to Bondi yesterday', uid),
    true, 1, 1, 'Bondi');

  check('capitalised + qualified: my little Rex (keeps 0.91)',
    await referenceDetector.detectReferences('my little Rex is the best', uid),
    true, 1, 1, 'Rex');

  console.log('\n=== SCORE HIERARCHY VERIFICATION ===\n');

  const relResult = await referenceDetector.detectReferences('Zara is my cat', uid);
  check('relationship intro = 0.88',
    relResult, true, 1, 1, 'Zara');
  if (relResult.candidates[0]) {
    const scoreOk = relResult.candidates[0].context_score === 0.88;
    console.log(scoreOk ? 'PASS  score confirmed 0.88' : 'FAIL  score was ' + relResult.candidates[0].context_score);
    if (scoreOk) passed++; else failed++;
    total++;
  }

  const qualResult = await referenceDetector.detectReferences('my lovely Pepper runs fast', uid);
  check('qualified possessive = 0.91',
    qualResult, true, 1, 1, 'Pepper');
  if (qualResult.candidates[0]) {
    const scoreOk = qualResult.candidates[0].context_score === 0.91;
    console.log(scoreOk ? 'PASS  score confirmed 0.91' : 'FAIL  score was ' + qualResult.candidates[0].context_score);
    if (scoreOk) passed++; else failed++;
    total++;
  }

  const possResult = await referenceDetector.detectReferences('my Teddy is fluffy', uid);
  check('possessive = 0.82',
    possResult, true, 1, 1, 'Teddy');
  if (possResult.candidates[0]) {
    const scoreOk = possResult.candidates[0].context_score === 0.82;
    console.log(scoreOk ? 'PASS  score confirmed 0.82' : 'FAIL  score was ' + possResult.candidates[0].context_score);
    if (scoreOk) passed++; else failed++;
    total++;
  }

  const prepResult = await referenceDetector.detectReferences('going to Camden tonight', uid);
  check('preposition = 0.78',
    prepResult, true, 1, 1, 'Camden');
  if (prepResult.candidates[0]) {
    const scoreOk = prepResult.candidates[0].context_score === 0.78;
    console.log(scoreOk ? 'PASS  score confirmed 0.78' : 'FAIL  score was ' + prepResult.candidates[0].context_score);
    if (scoreOk) passed++; else failed++;
    total++;
  }

  const capResult = await referenceDetector.detectReferences('I saw Yuki today', uid);
  check('capitalised only = 0.65',
    capResult, true, 1, 1, 'Yuki');
  if (capResult.candidates[0]) {
    const scoreOk = capResult.candidates[0].context_score === 0.65;
    console.log(scoreOk ? 'PASS  score confirmed 0.65' : 'FAIL  score was ' + capResult.candidates[0].context_score);
    if (scoreOk) passed++; else failed++;
    total++;
  }

  console.log('\n=== AUSTRALIAN SLANG / CASUAL INPUT ===\n');

  check('ngl that was mid: no detection',
    await referenceDetector.detectReferences('ngl that was mid', uid),
    false, 0, 0, null);

  check('bruh moment: no detection',
    await referenceDetector.detectReferences('bruh that was so funny', uid),
    false, 0, 0, null);

  check('yeah nah: no detection',
    await referenceDetector.detectReferences('yeah nah not really', uid),
    false, 0, 0, null);

  check('arvo at the servo: no detection',
    await referenceDetector.detectReferences('went to the servo this arvo', uid),
    false, 0, 0, null);

  console.log('\n=== REALISTIC USER SENTENCES ===\n');

  check('I was at Bondi with Max and Jess yesterday',
    await referenceDetector.detectReferences('I was at Bondi with Max and Jess yesterday', uid),
    true, 3, 3, 'Bondi');

  check('my nan lives near Parramatta',
    await referenceDetector.detectReferences('my nan lives near Parramatta', uid),
    true, 1, 1, 'Parramatta');

  check('Tom and I went to footy practice',
    await referenceDetector.detectReferences('Tom and I went to footy practice', uid),
    true, 1, 1, 'Tom');

  check('talked to Mum about it',
    await referenceDetector.detectReferences('I talked to Mum about it', uid),
    true, 1, 1, 'Mum');

  check('heading to Newtown for dinner with Kai',
    await referenceDetector.detectReferences('heading to Newtown for dinner with Kai', uid),
    true, 2, 2, 'Newtown');

  check('pure lowercase no caps at all',
    await referenceDetector.detectReferences('i went to the shops and bought some stuff', uid),
    false, 0, 0, null);

  console.log('\n=== FILTER STATS ===\n');
  const stats = commonWordFilter.getStats();
  console.log('Version:          ' + stats.version);
  console.log('Common nouns:     ' + stats.commonNouns);
  console.log('Function words:   ' + stats.functionWords);
  console.log('Ambiguous names:  ' + stats.ambiguousNames);
  console.log('LTLM vocabulary:  ' + stats.ltlmVocabulary);
  console.log('isCommon calls:   ' + stats.metrics.isCommonCalls);
  console.log('isCommon hits:    ' + stats.metrics.isCommonHits);
  console.log('Context checks:   ' + stats.metrics.contextChecks);
  console.log('Context rejects:  ' + stats.metrics.contextRejections);
  console.log('Rejection reasons:', stats.metrics.rejectionReasons);

  console.log('\n════════════════════════════════════════');
  console.log('  TOTAL:  ' + total);
  console.log('  PASSED: ' + passed);
  console.log('  FAILED: ' + failed);
  console.log('  RATE:   ' + ((passed / total) * 100).toFixed(1) + '%');
  console.log('════════════════════════════════════════\n');

  await pool.end();
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
