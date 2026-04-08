/**
 * =============================================================================
 * PorterStemmer — Martin Porter's Stemming Algorithm (1980)
 * =============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Full implementation of the Porter Stemming Algorithm for English.
 * Reduces words to their morphological root for term matching.
 * Zero dependencies, pure computation, no side effects.
 *
 * Reference: https://tartarus.org/martin/PorterStemmer/
 *
 * RULES (DO NOT VIOLATE):
 * ---------------------------------------------------------------------------
 *   1. No refactors of algorithm — this is a verified port
 *   2. No DB access — pure functions only
 *   3. No logger needed — pure text transformation
 *   4. No side effects — deterministic input/output
 *
 * CONSUMED BY:
 * ---------------------------------------------------------------------------
 *   SemanticAnswerEvaluator.js — tokenization and term matching
 *
 * EXPORT:
 * ---------------------------------------------------------------------------
 *   Default: singleton instance with .stem(word) method
 *   Usage: stemmer.stem('running') → 'run'
 *
 * =============================================================================
 */

class PorterStemmer {

  /* ═══════════════════════════════════════════════
     HELPER METHODS
  ═══════════════════════════════════════════════ */

  isConsonant(word, i) {
    const ch = word[i];
    if (ch === 'a' || ch === 'e' || ch === 'i' || ch === 'o' || ch === 'u') {
      return false;
    }
    if (ch === 'y') {
      return i === 0 ? true : !this.isConsonant(word, i - 1);
    }
    return true;
  }

  hasVowel(stem) {
    for (let i = 0; i < stem.length; i++) {
      if (!this.isConsonant(stem, i)) {
        return true;
      }
    }
    return false;
  }

  getMeasure(stem) {
    let m = 0;
    const length = stem.length;
    let i = 0;
    while (i < length && this.isConsonant(stem, i)) {
      i++;
    }
    if (i === length) {
      return 0;
    }
    while (i < length) {
      while (i < length && !this.isConsonant(stem, i)) {
        i++;
      }
      if (i === length) {
        return m;
      }
      while (i < length && this.isConsonant(stem, i)) {
        i++;
      }
      m++;
    }
    return m;
  }

  endsWithDoubleConsonant(stem) {
    const len = stem.length;
    if (len < 2) {
      return false;
    }
    return this.isConsonant(stem, len - 1) &&
           this.isConsonant(stem, len - 2) &&
           stem[len - 1] === stem[len - 2];
  }

  endsWithCVC(stem) {
    const len = stem.length;
    if (len < 3) {
      return false;
    }
    return this.isConsonant(stem, len - 3) &&
           !this.isConsonant(stem, len - 2) &&
           this.isConsonant(stem, len - 1) &&
           stem[len - 1] !== 'w' &&
           stem[len - 1] !== 'x' &&
           stem[len - 1] !== 'y';
  }

  replaceSuffix(stem, suffix, replacement, minM) {
    if (stem.endsWith(suffix)) {
      const base = stem.slice(0, -suffix.length);
      if (this.getMeasure(base) > minM) {
        return base + replacement;
      }
    }
    return stem;
  }

  /* ═══════════════════════════════════════════════
     STEP 1a: Plurals
  ═══════════════════════════════════════════════ */

  step1a(stem) {
    if (stem.endsWith('sses')) {
      return stem.slice(0, -4) + 'ss';
    }
    if (stem.endsWith('ies')) {
      return stem.slice(0, -3) + 'i';
    }
    if (stem.endsWith('ss')) {
      return stem;
    }
    if (stem.endsWith('s')) {
      return stem.slice(0, -1);
    }
    return stem;
  }

  /* ═══════════════════════════════════════════════
     STEP 1b: -ED and -ING
  ═══════════════════════════════════════════════ */

  step1b(stem) {
    if (stem.endsWith('eed')) {
      const base = stem.slice(0, -3);
      if (this.getMeasure(base) > 0) {
        return base + 'ee';
      }
      return stem;
    }
    let endsWithEd = stem.endsWith('ed');
    let endsWithIng = stem.endsWith('ing');
    if (endsWithEd || endsWithIng) {
      const suffixLen = endsWithEd ? 2 : 3;
      const base = stem.slice(0, -suffixLen);
      if (this.hasVowel(base)) {
        stem = base;
        if (stem.endsWith('at')) {
          stem = stem.slice(0, -2) + 'ate';
        } else if (stem.endsWith('bl')) {
          stem = stem.slice(0, -2) + 'ble';
        } else if (stem.endsWith('iz')) {
          stem = stem.slice(0, -2) + 'ize';
        } else if (this.endsWithDoubleConsonant(stem) &&
                   stem[stem.length - 1] !== 'l' &&
                   stem[stem.length - 1] !== 's' &&
                   stem[stem.length - 1] !== 'z') {
          stem = stem.slice(0, -1);
        } else if (this.getMeasure(stem) === 1 && this.endsWithCVC(stem)) {
          stem += 'e';
        }
        return stem;
      }
    }
    return stem;
  }

  /* ═══════════════════════════════════════════════
     STEP 1c: Y to I
  ═══════════════════════════════════════════════ */

  step1c(stem) {
    if (stem.endsWith('y') && this.hasVowel(stem.slice(0, -1))) {
      return stem.slice(0, -1) + 'i';
    }
    return stem;
  }

  /* ═══════════════════════════════════════════════
     STEP 2: Common suffixes (m>0)
  ═══════════════════════════════════════════════ */

  step2(stem) {
    const rules = [
      ['ational', 'ate'],
      ['tional', 'tion'],
      ['enci', 'ence'],
      ['anci', 'ance'],
      ['izer', 'ize'],
      ['abli', 'able'],
      ['alli', 'al'],
      ['entli', 'ent'],
      ['eli', 'e'],
      ['ousli', 'ous'],
      ['ization', 'ize'],
      ['ation', 'ate'],
      ['ator', 'ate'],
      ['alism', 'al'],
      ['iveness', 'ive'],
      ['fulness', 'ful'],
      ['ousness', 'ous'],
      ['aliti', 'al'],
      ['iviti', 'ive'],
      ['biliti', 'ble']
    ];
    for (const [suffix, replacement] of rules) {
      const newStem = this.replaceSuffix(stem, suffix, replacement, 0);
      if (newStem !== stem) {
        return newStem;
      }
    }
    return stem;
  }

  /* ═══════════════════════════════════════════════
     STEP 3: More suffixes (m>0)
  ═══════════════════════════════════════════════ */

  step3(stem) {
    const rules = [
      ['icate', 'ic'],
      ['ative', ''],
      ['alize', 'al'],
      ['iciti', 'ic'],
      ['ical', 'ic'],
      ['ful', ''],
      ['ness', '']
    ];
    for (const [suffix, replacement] of rules) {
      const newStem = this.replaceSuffix(stem, suffix, replacement, 0);
      if (newStem !== stem) {
        return newStem;
      }
    }
    return stem;
  }

  /* ═══════════════════════════════════════════════
     STEP 4: Final suffixes (m>1)
  ═══════════════════════════════════════════════ */

  step4(stem) {
    const rules = [
      'al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant',
      'ement', 'ment', 'ent', 'ou', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize'
    ];
    for (const suffix of rules) {
      const newStem = this.replaceSuffix(stem, suffix, '', 1);
      if (newStem !== stem) {
        return newStem;
      }
    }
    if (stem.endsWith('ion')) {
      const base = stem.slice(0, -3);
      const lastChar = base[base.length - 1];
      if ((lastChar === 's' || lastChar === 't') && this.getMeasure(base) > 1) {
        return base;
      }
    }
    return stem;
  }

  /* ═══════════════════════════════════════════════
     STEP 5: Clean up
  ═══════════════════════════════════════════════ */

  step5(stem) {
    let newStem = stem;
    if (newStem.endsWith('e')) {
      const base = newStem.slice(0, -1);
      const m = this.getMeasure(base);
      if (m > 1 || (m === 1 && !this.endsWithCVC(base))) {
        newStem = base;
      }
    }
    if (newStem.endsWith('ll') && this.getMeasure(newStem) > 1) {
      newStem = newStem.slice(0, -1);
    }
    return newStem;
  }

  /* ═══════════════════════════════════════════════
     MAIN STEM METHOD
  ═══════════════════════════════════════════════ */

  stem(word) {
    if (!word || word.length < 3) {
      return word || '';
    }

    let stem = word.toLowerCase();

    stem = this.step1a(stem);
    stem = this.step1b(stem);
    stem = this.step1c(stem);
    stem = this.step2(stem);
    stem = this.step3(stem);
    stem = this.step4(stem);
    stem = this.step5(stem);

    return stem;
  }
}

export default new PorterStemmer();
