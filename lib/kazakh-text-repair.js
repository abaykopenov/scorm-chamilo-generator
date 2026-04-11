/**
 * kazakh-text-repair.js
 * 
 * Central utility for repairing Kazakh/Cyrillic text broken by Docling PDF parsing.
 * Applied at GENERATION TIME (not indexing), so re-indexing is NEVER needed.
 * 
 * Handles:
 * 1. Fragmented words: "қолда у" → "қолдау", "зертте у" → "зерттеу"
 * 2. Merged words: "арналғанзаманауи" → "арналған заманауи"
 * 3. Known prefix fragments: "про цесі" → "процесі"
 * 4. Merged prepositions (Russian + Kazakh)
 */

// Cyrillic char class (including Kazakh special chars)
const C = 'а-яёәғқңөұүіһА-ЯЁӘҒҚҢӨҰҮІҺ';

// ─── Known prefix fragments from PDF parsing ───
const KNOWN_PREFIXES = [
  'про', 'при', 'пре', 'рас', 'нес', 'бес', 'пер',
  'қам', 'мод', 'кон', 'фор', 'сек', 'тех', 'алг',
  'мет', 'ком', 'тот', 'бло', 'объ', 'инт', 'авт',
  'мат', 'ста', 'фун', 'пар', 'опт', 'кри', 'мон',
  'сар', 'бас', 'жүй', 'тұж', 'стр',
];

// ─── Long postpositions/suffixes (safe to split AFTER) ───
// Only 4+ char boundaries to avoid false positives
const SPLIT_AFTER = [
  // Long Kazakh postpositions  
  'бойынша', 'арқылы', 'туралы', 'сияқты', 'ретінде', 'кезінде',
  'негізінде', 'арасында', 'барысында', 'аясында', 'жөнінде',
  'салыстырғанда', 'қарағанда', 'дейін', 'кейін', 'бұрын', 'бері',
  'үшін',
];

// ─── Conjunctions that merge with adjacent words ───
const CONJUNCTIONS = ['және', 'немесе', 'бірақ', 'алайда', 'яғни', 'сондай', 'сонымен', 'осылай'];

// ─── Function words that merge with adjacent words ───
const FUNC_WORDS = ['деп', 'емес', 'болып', 'ғана', 'өте'];

/**
 * Main repair function. Fixes all Kazakh/Cyrillic text issues.
 * Safe to apply multiple times (idempotent).
 */
export function repairKazakhText(text) {
  if (!text || typeof text !== 'string') return text || '';

  let s = text;

  // ── 1. Fix fragmented words: join Cyrillic word + space + 1-2 char suffix ──
  // "қолда у" → "қолдау", "зертте у" → "зерттеу", "жүйесіні ң" → "жүйесінің"
  s = s.replace(new RegExp(`([${C}]{2,})\\s([${C}]{1,2})(?=\\s|[.,;:!?)\\]"]|$)`, 'g'), '$1$2');

  // ── 2. Fix fragmented words: join 1-2 char prefix + space + Cyrillic word ──
  s = s.replace(new RegExp(`(^|\\s)([${C}]{1,2})\\s([${C}]{3,})`, 'g'), '$1$2$3');

  // ── 3. Fix known prefix fragments: "про цесі" → "процесі" ──
  // Use lookahead/lookbehind to ensure prefix is standalone (preceded by space or start)
  for (const prefix of KNOWN_PREFIXES) {
    s = s.replace(
      new RegExp(`(^|\\s)(${esc(prefix)})\\s([${C}]{3,})`, 'giu'),
      (match, before, pfx, rest) => `${before}${pfx}${rest}`
    );
  }

  // ── 4. Split merged words at long postposition/suffix boundaries ──
  // "арналғанзаманауи" → "арналған заманауи"
  // "БОЙЫНШАЗЕРТТЕУ" → "БОЙЫНША ЗЕРТТЕУ"
  // Sort by length descending to match longest first
  const sortedBoundaries = [...SPLIT_AFTER].sort((a, b) => b.length - a.length);
  
  for (const boundary of sortedBoundaries) {
    // Pattern 1: [word][boundary][nextword] — split after boundary
    const re1 = new RegExp(
      `([${C}]{3,}${esc(boundary)})([${C}]{3,})`,
      'giu'
    );
    s = s.replace(re1, '$1 $2');
    
    // Pattern 2: [boundary][nextword] at word start — e.g. "БОЙЫНШАЗЕРТТЕУ"
    // The postposition itself is the entire left part
    if (boundary.length >= 4) {
      const re2 = new RegExp(
        `(?<=\\s|^)(${esc(boundary)})([${C}]{3,})`,
        'giu'
      );
      s = s.replace(re2, '$1 $2');
    }
  }
  
  // Also split at common 3-char verb endings: ған/ген/қан/кен
  // "арналғанзаманауи" → "арналған заманауи"
  const verbEndings3 = ['ған', 'ген', 'қан', 'кен'];
  for (const ve of verbEndings3) {
    const re = new RegExp(
      `([${C}]{3,}${esc(ve)})([${C}]{3,})`,
      'giu'
    );
    s = s.replace(re, (match, left, right) => {
      // Don't split if right side looks like a suffix continuation
      const rl = right.toLowerCase();
      if (/^(ын|ін|ыл|іл|ші|ні|лі|ді|сі|ау|еу|да|де|ды|ді|на|не|ға|ге)/.test(rl)) return match;
      return `${left} ${right}`;
    });
  }

  // ── 5. Split at conjunctions merged INTO words ──
  // "ЖӘНЕТАЛДАУ" → "ЖӘНЕ ТАЛДАУ"
  for (const conj of CONJUNCTIONS) {
    // Conjunction merged between two words
    s = s.replace(
      new RegExp(`([${C}]{3,})(${esc(conj)})(\\s*)([${C}]{3,})`, 'giu'),
      (match, left, cj, sp, right) => sp ? match : `${left} ${cj} ${right}`
    );
    // Conjunction merged only to the right: "жәнеталдау"  
    s = s.replace(
      new RegExp(`(?<=\\s|^)(${esc(conj)})([${C}]{3,})`, 'giu'),
      (match, cj, right) => `${cj} ${right}`
    );
  }

  // ── 6. Split function words merged between words ──
  // "болыптабылады" → "болып табылады"
  for (const fw of FUNC_WORDS) {
    s = s.replace(
      new RegExp(`([${C}]{3,})(${esc(fw)})(\\s*)([${C}]{3,})`, 'giu'),
      (match, left, fword, sp, right) => sp ? match : `${left} ${fword} ${right}`
    );
  }

  // ── 7. Fix merged Russian prepositions ──
  const ruPreps = ['для', 'при', 'без', 'под', 'над', 'между', 'также', 'однако'];
  for (const prep of ruPreps) {
    s = s.replace(
      new RegExp(`([${C}]{3,})(${esc(prep)})(?=\\s|[.,;:!?)]|$)`, 'giu'),
      `$1 ${prep}`
    );
    s = s.replace(
      new RegExp(`(?<=\\s|^)(${esc(prep)})([${C}]{3,})`, 'giu'),
      `${prep} $2`
    );
  }

  // ── 8. Split "ең" (most/very) merged to following word ──
  // "еңкөп" → "ең көп", "еңаз" → "ең аз"
  s = s.replace(new RegExp(`(?<=\\s|^)(ең)([${C}]{2,})`, 'giu'), 'ең $2');
  
  // ── 9. Split "бір"/"екі"/"үш" merged to following word ──
  s = s.replace(new RegExp(`(?<=\\s|^)(бір|екі|үш)([${C}]{3,})`, 'giu'), '$1 $2');

  // ── 10. Split "кем" (less/at least) when merged: "кемдегенде" → "кем дегенде"
  s = s.replace(new RegExp(`(?<=\\s|^)(кем)(дегенде)`, 'giu'), '$1 $2');

  // ── 11. Clean up multiple spaces ──
  s = s.replace(/\s{2,}/g, ' ').trim();

  return s;
}

/**
 * Lighter repair for titles — only fix the most obvious issues.
 */
export function repairKazakhTitle(title) {
  if (!title || typeof title !== 'string') return title || '';
  return repairKazakhText(title);
}

function esc(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
