/**
 * =============================================================================
 * SemanticAnswerEvaluator — Multi-Dimensional Answer Scoring Engine
 * =============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Evaluates student answers against knowledge items using three dimensions:
 *   1. Term matching — exact vocabulary recall (stemmed, weighted, multi-word)
 *   2. Semantic similarity — conceptual understanding via embeddings
 *   3. Concept coverage — structural recall of key ideas
 *
 * Scoring weights shift by belt level (Bloom's Taxonomy progression):
 *   White belt: semantic-heavy (gist understanding rewarded)
 *   Black belt: term-heavy (precise nomenclature required)
 *
 * CONSUMED BY:
 * ---------------------------------------------------------------------------
 *   EvaluatorComponent.js — recall task scoring
 *
 * DEPENDENCIES:
 * ---------------------------------------------------------------------------
 *   SemanticEmbedder.js — cosine similarity via SVD embeddings
 *   PorterStemmer.js — morphological root extraction
 *   FSRSConstants.js — FSRS_GOOD_THRESHOLD for pass/fail determination
 *
 * SCORING OUTPUT:
 * ---------------------------------------------------------------------------
 *   Returns FSRS-compatible score (1-5) with granular bands:
 *     1 = again (0-0.20), 2 = hard (0.20-0.40), 3 = good (0.40-0.60),
 *     4 = good_plus (0.60-0.80), 5 = easy (0.80-1.00)
 *
 * ANTI-GAMING MEASURES:
 * ---------------------------------------------------------------------------
 *   - Low coverage penalty: prevents single golden-term gaming
 *   - White belt zero-term penalty: prevents fluent paraphrase without terms
 *   - Semantic redistribution: graceful fallback when embedder fails
 *
 * v010 STANDARDS:
 * ---------------------------------------------------------------------------
 *   - Structured logger for debug tracing
 *   - FSRS_GOOD_THRESHOLD imported (not hardcoded)
 *   - Named export alongside singleton default
 *   - All constants frozen via Object.freeze
 *   - No console.log
 *
 * =============================================================================
 */

import semanticEmbedder from '../../services/SemanticEmbedder.js';
import stemmer from './PorterStemmer.js';
import { FSRS_GOOD_THRESHOLD } from '../constants/FSRSConstants.js';
import { createModuleLogger } from '../../utils/logger.js';

const logger = createModuleLogger('SemanticAnswerEvaluator');

/* ==========================================================================
   CONFIGURATION CONSTANTS
   All magic numbers and configurable values in one place
========================================================================== */

const CONFIG = Object.freeze({
  // Scoring adjustments
  PHRASE_BONUS: 0.05,
  LOW_COVERAGE_PENALTY: 0.8,
  PARTIAL_MATCH_THRESHOLD: 0.5,
  FULL_MATCH_THRESHOLD: 0.999,

  // Token weighting
  STOPWORD_WEIGHT: 0.2,
  NORMAL_WORD_WEIGHT: 1.0,

  // Weight redistribution when semantic fails
  SEMANTIC_REDISTRIBUTION_TO_TERM: 0.7,
  SEMANTIC_REDISTRIBUTION_TO_CONCEPT: 0.3,

  // Concept extraction
  MIN_CONCEPT_LENGTH: 8,
  MIN_CONCEPT_WORDS: 2,

  // Feedback limits (cognitive load optimisation)
  MAX_MISSING_CONCEPTS_IN_FEEDBACK: 2,
  MAX_MISSING_TERMS_IN_FEEDBACK: 3,

  // Access control
  ADMIN_ACCESS_LEVEL: 11,

  // White belt term floor penalty (fixes semantic dominance issue)
  WHITE_BELT_ZERO_TERM_PENALTY: 0.7,

  // Low-score reference reveal (ITS best practice)
  // Shows model answer when score is at or below threshold
  LOW_SCORE_REFERENCE_THRESHOLD: 2,
  REFERENCE_MAX_LENGTH: 180,

  // Belt weight configurations
  // Progression: white (semantic-heavy) -> black (term-heavy)
  BELT_WEIGHTS: Object.freeze({
    white_belt:  { term: 0.20, semantic: 0.50, concept: 0.30 },
    blue_belt:   { term: 0.30, semantic: 0.45, concept: 0.25 },
    purple_belt: { term: 0.40, semantic: 0.35, concept: 0.25 },
    brown_belt:  { term: 0.50, semantic: 0.30, concept: 0.20 },
    black_belt:  { term: 0.60, semantic: 0.25, concept: 0.15 },
    default:     { term: 0.50, semantic: 0.30, concept: 0.20 }
  }),

  // Belt threshold configurations
  // Thresholds tighten as mastery increases
  BELT_THRESHOLDS: Object.freeze({
    white_belt: {
      termMatch: 0.60,
      conceptHit: 0.55,
      semanticGood: 0.70,
      minCoverage: 0.30
    },
    blue_belt: {
      termMatch: 0.65,
      conceptHit: 0.58,
      semanticGood: 0.72,
      minCoverage: 0.33
    },
    purple_belt: {
      termMatch: 0.70,
      conceptHit: 0.62,
      semanticGood: 0.75,
      minCoverage: 0.36
    },
    brown_belt: {
      termMatch: 0.75,
      conceptHit: 0.65,
      semanticGood: 0.78,
      minCoverage: 0.40
    },
    black_belt: {
      termMatch: 0.80,
      conceptHit: 0.70,
      semanticGood: 0.82,
      minCoverage: 0.45
    },
    default: {
      termMatch: 0.75,
      conceptHit: 0.65,
      semanticGood: 0.78,
      minCoverage: 0.40
    }
  })
});

/* ==========================================================================
   SCORE MAPPING BANDS
   More granular than simple Math.round() for human-like difficulty perception
   Maps weighted sum (0-1) to FSRS score (1-5)
========================================================================== */

const SCORE_BANDS = Object.freeze([
  { max: 0.20, score: 1, label: 'again' },
  { max: 0.40, score: 2, label: 'hard' },
  { max: 0.60, score: 3, label: 'good' },
  { max: 0.80, score: 4, label: 'good_plus' },
  { max: 1.00, score: 5, label: 'easy' }
]);

/* ==========================================================================
   STOPWORDS (down-weighted in term matching)
   Includes both original and stemmed versions to fix mismatch bug
========================================================================== */

const STOPWORDS_ORIGINAL = [
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'in', 'on', 'for',
  'with', 'at', 'by', 'from', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'this', 'that', 'these', 'those', 'it', 'its'
];

const STOPWORDS_STEMMED = new Set(
  STOPWORDS_ORIGINAL.map(word => stemmer.stem(word))
);

const STOPWORDS = new Set([
  ...STOPWORDS_ORIGINAL,
  ...STOPWORDS_STEMMED
]);

/* ==========================================================================
   FEEDBACK TEMPLATES
   Structured templates for actionable, learner-friendly explanations
========================================================================== */

const FEEDBACK = Object.freeze({
  UNDERSTANDING: {
    STRONG: 'Excellent! You clearly understand this concept.',
    GOOD: 'Good grasp of the main idea.',
    PARTIAL: 'You have some understanding, but key elements are missing.',
    WEAK: 'This needs more work. Review the material and try again.'
  },
  TERMS: {
    EXCELLENT: 'Your terminology is spot on.',
    GOOD: 'Good use of key terms.',
    MISSING: (terms) => `Key terms to remember: ${terms.join(', ')}.`,
    NONE_REQUIRED: ''
  },
  CONCEPTS: {
    COMPLETE: 'You covered all the important points.',
    PARTIAL: (concepts) => `Also consider: ${concepts.join('; ')}.`,
    MISSING: (concepts) => `Important ideas you missed: ${concepts.join('; ')}.`
  },
  ENCOURAGEMENT: {
    SCORE_5: 'Outstanding work!',
    SCORE_4: 'Well done!',
    SCORE_3: 'Keep it up!',
    SCORE_2: 'You are making progress.',
    SCORE_1: 'Do not give up - review and try again.'
  },
  REFERENCE: {
    PREFIX: 'Reference:'
  }
});

/* ==========================================================================
   SemanticAnswerEvaluator CLASS
========================================================================== */

class SemanticAnswerEvaluator {

  /* ═══════════════════════════════════════════════
     TEXT NORMALISATION
  ═══════════════════════════════════════════════ */

  stem(word) {
    return stemmer.stem(word);
  }

  _normalizeApostrophes(text) {
    return text.replace(/[''´`]/g, "'");
  }

  _removePossessives(text) {
    return text.replace(/\b([a-z]+)'s\b/g, '$1');
  }

  _convertPunctuationToSpaces(text) {
    return text.replace(/[^a-z0-9]+/g, ' ');
  }

  _collapseWhitespace(text) {
    return text.trim().replace(/\s+/g, ' ');
  }

  normalizeText(text) {
    if (text === null || text === undefined) return '';

    let result = String(text).toLowerCase();
    result = this._normalizeApostrophes(result);
    result = this._removePossessives(result);
    result = this._convertPunctuationToSpaces(result);
    result = this._collapseWhitespace(result);

    return result;
  }

  tokenizeAndStem(text) {
    const normalized = this.normalizeText(text);
    if (!normalized) return [];
    return normalized
      .split(' ')
      .filter(Boolean)
      .map(w => this.stem(w));
  }

  preprocess(text) {
    return this.tokenizeAndStem(text);
  }

  countTokens(tokens) {
    const m = new Map();
    for (const t of tokens) {
      m.set(t, (m.get(t) ?? 0) + 1);
    }
    return m;
  }

  containsOrderedPhrase(haystack, needle) {
    if (needle.length === 0 || needle.length > haystack.length) return false;
    outer:
    for (let i = 0; i <= haystack.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return true;
    }
    return false;
  }

  /* ═══════════════════════════════════════════════
     SAFE SIMILARITY WRAPPER
  ═══════════════════════════════════════════════ */

  sim(textA, textB) {
    if (!textA || !textB || !textA.trim() || !textB.trim()) return 0;
    const result = semanticEmbedder.similarity(textA, textB);
    return (result === null || Number.isNaN(result)) ? 0 : result;
  }

  /* ═══════════════════════════════════════════════
     BELT CONFIGURATION ACCESSORS
  ═══════════════════════════════════════════════ */

  getWeights(beltLevel) {
    return CONFIG.BELT_WEIGHTS[beltLevel] || CONFIG.BELT_WEIGHTS.default;
  }

  getThresholds(beltLevel) {
    return CONFIG.BELT_THRESHOLDS[beltLevel] || CONFIG.BELT_THRESHOLDS.default;
  }

  /* ═══════════════════════════════════════════════
     CONCEPT EXTRACTION
  ═══════════════════════════════════════════════ */

  extractConcepts(answerStatement) {
    const text = (answerStatement || '').trim();
    if (!text) return [];

    const sentences = text
      .split(/[.!?;]/)
      .map(s => s.trim())
      .filter(Boolean);

    const concepts = [];
    for (const sentence of sentences) {
      const parts = sentence
        .split(/,\s*|\s+(?:and|or|but)\s+/i)
        .map(p => p.trim())
        .filter(Boolean);

      for (const p of parts) {
        const wordCount = p.split(/\s+/).length;
        if (p.length > CONFIG.MIN_CONCEPT_LENGTH && wordCount >= CONFIG.MIN_CONCEPT_WORDS) {
          concepts.push(p);
        }
      }
    }

    const seen = new Set();
    return concepts.filter(c => {
      if (seen.has(c)) return false;
      seen.add(c);
      return true;
    });
  }

  /* ═══════════════════════════════════════════════
     SCORE MAPPING
  ═══════════════════════════════════════════════ */

  _mapToFsrsScore(weightedSum) {
    const clamped = Math.max(0, Math.min(1, weightedSum));

    for (const band of SCORE_BANDS) {
      if (clamped <= band.max) {
        return { score: band.score, label: band.label };
      }
    }

    return { score: 5, label: 'easy' };
  }

  /* ═══════════════════════════════════════════════
     EXPLANATION BUILDER
  ═══════════════════════════════════════════════ */

  _buildExplanation(params) {
    const {
      score,
      semanticScore,
      thresholds,
      matchedTerms,
      missingTerms,
      matchedConcepts,
      missingConcepts,
      requiredTermsCount,
      conceptsCount,
      answerStatement,
      intentHint,
      accessLevel
    } = params;

    const parts = [];

    if (semanticScore >= thresholds.semanticGood) {
      parts.push(FEEDBACK.UNDERSTANDING.STRONG);
    } else if (semanticScore >= 0.5) {
      parts.push(FEEDBACK.UNDERSTANDING.GOOD);
    } else if (semanticScore >= 0.3) {
      parts.push(FEEDBACK.UNDERSTANDING.PARTIAL);
    } else {
      parts.push(FEEDBACK.UNDERSTANDING.WEAK);
    }

    if (requiredTermsCount > 0) {
      if (missingTerms.length === 0) {
        parts.push(FEEDBACK.TERMS.EXCELLENT);
      } else if (missingTerms.length <= CONFIG.MAX_MISSING_TERMS_IN_FEEDBACK) {
        parts.push(FEEDBACK.TERMS.MISSING(missingTerms));
      } else {
        const sample = missingTerms.slice(0, CONFIG.MAX_MISSING_TERMS_IN_FEEDBACK);
        parts.push(FEEDBACK.TERMS.MISSING([...sample, `and ${missingTerms.length - CONFIG.MAX_MISSING_TERMS_IN_FEEDBACK} more`]));
      }
    }

    if (conceptsCount > 0) {
      if (missingConcepts.length === 0) {
        parts.push(FEEDBACK.CONCEPTS.COMPLETE);
      } else if (missingConcepts.length <= CONFIG.MAX_MISSING_CONCEPTS_IN_FEEDBACK) {
        parts.push(FEEDBACK.CONCEPTS.MISSING(missingConcepts));
      } else {
        const sample = missingConcepts.slice(0, CONFIG.MAX_MISSING_CONCEPTS_IN_FEEDBACK);
        parts.push(FEEDBACK.CONCEPTS.PARTIAL(sample));
      }
    }

    const encouragementKey = `SCORE_${score}`;
    if (FEEDBACK.ENCOURAGEMENT[encouragementKey]) {
      parts.push(FEEDBACK.ENCOURAGEMENT[encouragementKey]);
    }

    if (score <= CONFIG.LOW_SCORE_REFERENCE_THRESHOLD && answerStatement) {
      const maxLen = CONFIG.REFERENCE_MAX_LENGTH;
      const shortRef = answerStatement.length > maxLen
        ? answerStatement.slice(0, maxLen - 3) + '...'
        : answerStatement;
      parts.push(`${FEEDBACK.REFERENCE.PREFIX} ${shortRef}`);
    }

    if (accessLevel === CONFIG.ADMIN_ACCESS_LEVEL && intentHint?.centroid) {
      parts.push(`[Debug - Intent: ${intentHint.centroid}, sim=${intentHint.similarity.toFixed(2)}]`);
    }

    return parts.join(' ');
  }

  /* ═══════════════════════════════════════════════
     MAIN EVALUATION
  ═══════════════════════════════════════════════ */

  evaluate(userAnswer, knowledgeItem, options = {}) {

    if (!knowledgeItem) {
      logger.warn('evaluate called with no knowledgeItem');
      return {
        score: 1,
        termScore: 0,
        semanticScore: 0,
        conceptScore: 0,
        matched_terms: [],
        missing_terms: [],
        matched_concepts: [],
        missing_concepts: [],
        explanation: 'Evaluation error: No knowledge item provided.',
        scoreLabel: 'again',
        passed: false
      };
    }

    const {
      required_terms = [],
      answer_statement = '',
      belt_level = 'white_belt',
      semantic_anchors = null
    } = knowledgeItem;

    const { accessLevel = 1 } = options;

    const weights = this.getWeights(belt_level);
    const thresholds = this.getThresholds(belt_level);
    const userText = (userAnswer || '').trim();

    /* ───────────────────────────────────────────
       EMPTY ANSWER FAIL-FAST
    ─────────────────────────────────────────── */

    if (!userText) {
      return {
        score: 1,
        termScore: 0,
        semanticScore: 0,
        conceptScore: 0,
        matched_terms: [],
        missing_terms: required_terms,
        matched_concepts: [],
        missing_concepts: this.extractConcepts(answer_statement),
        explanation: 'No answer provided. Please try again.',
        scoreLabel: 'again',
        passed: false
      };
    }

    /* ───────────────────────────────────────────
       1. TERM SCORE (GRADED, MULTI-WORD AWARE)
    ─────────────────────────────────────────── */

    const userTokens = this.tokenizeAndStem(userText);
    const perTermScores = [];
    const matchedTerms = [];
    const missingTerms = [];

    for (const term of required_terms) {
      const termTokens = this.tokenizeAndStem(term);

      if (termTokens.length === 0) {
        perTermScores.push(0);
        missingTerms.push(term);
        continue;
      }

      const userCounts = this.countTokens(userTokens);

      let matchedWeight = 0;
      let totalWeight = 0;

      for (const tok of termTokens) {
        const weight = STOPWORDS.has(tok) ? CONFIG.STOPWORD_WEIGHT : CONFIG.NORMAL_WORD_WEIGHT;
        totalWeight += weight;

        const available = userCounts.get(tok) ?? 0;
        if (available > 0) {
          matchedWeight += weight;
          userCounts.set(tok, available - 1);
        }
      }

      let score = totalWeight > 0 ? matchedWeight / totalWeight : 0;

      if (score > 0 && score < 1.0 && this.containsOrderedPhrase(userTokens, termTokens)) {
        score = Math.min(1.0, score + CONFIG.PHRASE_BONUS);
      }

      if (score >= CONFIG.FULL_MATCH_THRESHOLD) {
        perTermScores.push(1);
        matchedTerms.push(term);
        continue;
      }

      if (score > 0) {
        perTermScores.push(score);
        if (score >= CONFIG.PARTIAL_MATCH_THRESHOLD) {
          matchedTerms.push(term);
        } else {
          missingTerms.push(term);
        }
        continue;
      }

      const anchor = semantic_anchors?.[term] || term;
      const s = this.sim(userText, anchor);
      perTermScores.push(s);

      if (s >= thresholds.termMatch) {
        matchedTerms.push(term);
      } else {
        missingTerms.push(term);
      }
    }

    const termScore = required_terms.length > 0
      ? perTermScores.reduce((sum, v) => sum + v, 0) / required_terms.length
      : 1;

    /* ───────────────────────────────────────────
       2. SEMANTIC SCORE
    ─────────────────────────────────────────── */

    const semanticScore = this.sim(userText, answer_statement);

    /* ───────────────────────────────────────────
       3. CONCEPT COVERAGE
    ─────────────────────────────────────────── */

    const concepts = this.extractConcepts(answer_statement);
    const perConceptScores = [];
    const matchedConcepts = [];
    const missingConcepts = [];

    for (const concept of concepts) {
      const s = this.sim(userText, concept);
      perConceptScores.push(s);

      if (s >= thresholds.conceptHit) {
        matchedConcepts.push(concept);
      } else {
        missingConcepts.push(concept);
      }
    }

    let conceptScore = concepts.length > 0
      ? perConceptScores.reduce((sum, v) => sum + v, 0) / concepts.length
      : semanticScore;

    /* ───────────────────────────────────────────
       4. LOW COVERAGE PENALTY (ANTI-GAMING)
    ─────────────────────────────────────────── */

    const lowCoverage = (
      semanticScore < thresholds.minCoverage &&
      conceptScore < thresholds.minCoverage
    );

    if (lowCoverage) {
      conceptScore *= CONFIG.LOW_COVERAGE_PENALTY;
    }

    /* ───────────────────────────────────────────
       5. FINAL SCORE (1-5 for FSRS)
    ─────────────────────────────────────────── */

    let effectiveTermWeight = weights.term;
    let effectiveSemanticWeight = weights.semantic;
    let effectiveConceptWeight = weights.concept;

    if (semanticScore === 0 && conceptScore === 0 && termScore > 0) {
      effectiveTermWeight = 1.0;
      effectiveSemanticWeight = 0;
      effectiveConceptWeight = 0;
    } else if (semanticScore === 0 && termScore > 0) {
      effectiveTermWeight += effectiveSemanticWeight * CONFIG.SEMANTIC_REDISTRIBUTION_TO_TERM;
      effectiveConceptWeight += effectiveSemanticWeight * CONFIG.SEMANTIC_REDISTRIBUTION_TO_CONCEPT;
      effectiveSemanticWeight = 0;
    }

    let weightedSum =
      (effectiveTermWeight * termScore) +
      (effectiveSemanticWeight * semanticScore) +
      (effectiveConceptWeight * conceptScore);

    /* ───────────────────────────────────────────
       5a. WHITE BELT ZERO-TERM PENALTY
    ─────────────────────────────────────────── */

    let zeroTermPenaltyApplied = false;
    if (
      belt_level === 'white_belt' &&
      required_terms.length > 0 &&
      matchedTerms.length === 0
    ) {
      weightedSum *= CONFIG.WHITE_BELT_ZERO_TERM_PENALTY;
      zeroTermPenaltyApplied = true;
      logger.debug('White belt zero-term penalty applied', {
        belt_level,
        requiredTerms: required_terms.length,
        weightedSum
      });
    }

    const { score, label: scoreLabel } = this._mapToFsrsScore(weightedSum);

    /* ───────────────────────────────────────────
       6. INTENT DIAGNOSTIC (DEBUG AID)
    ─────────────────────────────────────────── */

    let intentHint = null;
    try {
      intentHint = semanticEmbedder.getNearestCentroid(userText);
    } catch (e) {
      intentHint = null;
    }

    /* ───────────────────────────────────────────
       7. EXPLANATION (ACTIONABLE)
    ─────────────────────────────────────────── */

    const explanation = this._buildExplanation({
      score,
      semanticScore,
      thresholds,
      matchedTerms,
      missingTerms,
      matchedConcepts,
      missingConcepts,
      requiredTermsCount: required_terms.length,
      conceptsCount: concepts.length,
      answerStatement: answer_statement,
      intentHint,
      accessLevel
    });

    /* ───────────────────────────────────────────
       8. RETURN RESULT
    ─────────────────────────────────────────── */

    return {
      score,
      scoreLabel,
      passed: score >= FSRS_GOOD_THRESHOLD,
      termScore,
      semanticScore,
      conceptScore,
      matched_terms: matchedTerms,
      missing_terms: missingTerms,
      matched_concepts: matchedConcepts,
      missing_concepts: missingConcepts,
      explanation,
      weights: {
        effective: {
          term: effectiveTermWeight,
          semantic: effectiveSemanticWeight,
          concept: effectiveConceptWeight
        },
        configured: weights
      },
      thresholds,
      debug: accessLevel === CONFIG.ADMIN_ACCESS_LEVEL ? {
        weightedSum,
        lowCoverageApplied: lowCoverage,
        zeroTermPenaltyApplied,
        intentHint,
        perTermScores,
        perConceptScores
      } : undefined
    };
  }
}

export { SemanticAnswerEvaluator };
export default new SemanticAnswerEvaluator();
