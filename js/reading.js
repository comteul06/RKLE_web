// 일본어 가사의 읽기 자동 생성 (데스크톱 편집기 Services/JapaneseReading.cs 를 옮긴 것).
//  - 위 줄(ruby): 한자 덩어리마다 히라가나.  예) 終わり → 終[お]
//  - 아래 줄(kor): 일본어 단어(한자·히라가나·가타카나)마다 한글 독음.  예) 終わり → 오와리, は(조사) → 와
// 형태소 분석은 kuromoji.js (IPA 사전, 데스크톱판의 NMeCab 과 같은 사전). 히라가나 → 한글은 정해진 표로 변환.
//
// 편집용 표기
//  - 히라가나 칸: 星[ほし]が今日[きょう]の   (한자가 아닌 글자까지 묶으려면 {終わり}[おわり])
//  - 한글 칸    : 星[호시]が[가]今日[쿄우]の[노]   (']' 다음부터 '[' 까지가 한 단어)

import { displayText, isValidFor } from './model.js';

let tokenizer = null;

/** 사전 불러오기 (수 MB, 처음 한 번). 끝나면 resolve. */
export function initReading(dicPath) {
  return new Promise((resolve, reject) => {
    if (!window.kuromoji) { reject(new Error('kuromoji.js 를 불러오지 못했습니다')); return; }
    window.kuromoji.builder({ dicPath }).build((err, t) => {
      if (err) { reject(err); return; }
      tokenizer = t;
      resolve();
    });
  });
}

export const isReadingReady = () => tokenizer != null;

export const isKanji = c => {
  const x = c.codePointAt(0);
  return (x >= 0x4E00 && x <= 0x9FFF) || (x >= 0x3400 && x <= 0x4DBF) || (x >= 0xF900 && x <= 0xFAFF)
    || c === '々' || c === '〆' || c === 'ヶ';
};
export const isKana = c => {
  const x = c.codePointAt(0);
  return (x >= 0x3041 && x <= 0x3096) || (x >= 0x30A1 && x <= 0x30FA) || c === 'ー';
};
export const isJapanese = c => isKanji(c) || isKana(c);
export const hasKanji = s => [...s].some(isKanji);
export const hasJapanese = s => [...s].some(isJapanese);

// ---------------------------------------------------------------------------
// 문장 단위 처리
// ---------------------------------------------------------------------------

/**
 * 문장의 표시 텍스트가 바뀌었으면 읽기를 다시 만든다. 같은 글자(같은 순번)의 기존 읽기는 그대로 둬서
 * 손으로 고친 읽기가 글자를 고칠 때마다 사라지지 않게 한다. 바뀌었으면 true.
 * 사전이 아직 준비되지 않았으면 아무것도 하지 않는다 (준비되면 다시 부른다).
 */
export function updateReading(line) {
  const text = displayText(line);
  if (line.rubyText === text || !tokenizer) return false;
  const { ruby, kor } = analyze(text);
  line.ruby = keepOld(ruby, line.ruby);
  line.kor = keepOld(kor, line.kor);
  line.rubyText = text;
  return true;
}

function keepOld(fresh, old) {
  const seen = new Map();
  for (const r of fresh) {
    const k = seen.get(r.base) ?? 0;
    seen.set(r.base, k + 1);
    const keep = old.filter(o => o.base === r.base)[k];
    if (keep) r.text = keep.text;
  }
  return fresh;
}

/** 기존 읽기를 버리고 자동으로 다시 만든다 */
export function regenerateReading(line) {
  if (!tokenizer) return false;
  const text = displayText(line);
  const { ruby, kor } = analyze(text);
  line.ruby = ruby; line.kor = kor; line.rubyText = text;
  return true;
}

/** 히라가나(위 줄)를 손으로 고친 뒤: 고친 한자가 들어 있는 단어의 한글 독음을 새 히라가나로 다시 만든다. */
export function applyRubyEdit(line, newRuby) {
  const text = displayText(line);
  const oldRuby = line.ruby;
  line.ruby = newRuby;
  line.rubyText = text;
  const key = rs => rs.map(r => `${r.at}:${r.base}:${r.text}`).join('\u0001');
  for (const k of line.kor) {
    const a = k.at, b = k.at + k.base.length;
    const inSpan = rs => rs.filter(r => r.at < b && r.at + r.base.length > a).sort((x, y) => x.at - y.at);
    if (key(inSpan(oldRuby)) === key(inSpan(newRuby))) continue;
    const pron = kanaOf(text, a, k.base.length, newRuby);
    if (!hasKanji(pron)) k.text = toHangul(pron);
  }
}

/** 문장 전체를 분석해 위 줄(한자 → 히라가나)과 아래 줄(단어 → 한글) 목록을 만든다 */
export function analyze(text) {
  const ruby = [], kor = [], korPron = [];
  if (!hasJapanese(text) || !tokenizer) return { ruby, kor };

  let pos = 0;
  for (const n of tokenizer.tokenize(text)) {
    const surface = n.surface_form || '';
    if (!surface) continue;
    const at = text.indexOf(surface, pos);
    if (at < 0) continue;
    pos = at + surface.length;
    if (!hasJapanese(surface)) continue;

    const reading = toHiragana(n.reading && n.reading !== '*' ? n.reading : '');
    const hasReading = reading.length > 0 && [...reading].some(isKana) && !hasKanji(reading);

    // 1) 위 줄: 한자 부분의 히라가나
    if (hasKanji(surface)) {
      const last = ruby[ruby.length - 1];
      if ([...surface].every(c => c === '々') && last && last.at + last.base.length === at) {
        // "々" 만 따로 잘린 경우 (星々): 바로 앞 한자 읽기를 되풀이한다
        last.base += surface;
        last.text += last.text.repeat(surface.length);
      } else if (hasReading) {
        for (const [offset, base, kana] of align(surface, reading))
          ruby.push({ at: at + offset, base, text: kana });
      }
    }

    // 2) 아래 줄: 단어 전체의 발음. 조사 は/へ/を 는 실제 발음(わ/え/お)으로
    let pron;
    if (n.pos === '助詞' && (surface === 'は' || surface === 'へ' || surface === 'を'))
      pron = toHiragana(n.pronunciation && n.pronunciation !== '*' ? n.pronunciation : reading);
    else if ([...surface].every(isKana)) pron = toHiragana(surface);   // 가나만 있는 단어는 글자 그대로
    else if (hasReading) pron = reading;
    else pron = kanaOf(text, at, surface.length, ruby);

    // っ ん ー ゃ 등으로 시작하는 조각은 앞 단어에 붙인다 (받침·요음이 앞 글자와 합쳐지도록)
    const glue = 'っッんンーゃゅょぁぃぅぇぉャュョァィゥェォ'.includes(surface[0]);
    const lastK = kor[kor.length - 1];
    if (glue && lastK && lastK.at + lastK.base.length === at) {
      lastK.base += surface;
      korPron[korPron.length - 1] += pron;
    } else {
      kor.push({ at, base: surface, text: '' });
      korPron.push(pron);
    }
  }

  for (let i = kor.length - 1; i >= 0; i--) {
    const p = korPron[i];
    if (hasKanji(p) || ![...p].some(isKana)) { kor.splice(i, 1); continue; }   // 사전에 없는 한자: 손으로 넣도록 비워 둔다
    kor[i].text = toHangul(p);
  }
  return { ruby, kor };
}

/** text[at..at+len] 의 발음: 위 줄 히라가나가 있는 한자는 그 히라가나로, 가나는 그대로, 나머지는 버린다 */
function kanaOf(text, at, len, ruby) {
  let sb = '';
  for (let i = at; i < at + len;) {
    const r = ruby.find(x => x.at === i && isValidFor(x, text));
    if (r) { sb += r.text; i += r.base.length; continue; }
    const c = text[i++];
    if (isJapanese(c)) sb += isKana(c) ? toHiragana(c) : c;
  }
  return sb;
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 단어 표기와 읽기를 맞춰 한자 덩어리마다 읽기를 나눈다. 맞추지 못하면 단어 전체에 읽기 전체를 붙인다. */
function align(surface, reading) {
  const runs = [];
  for (let i = 0; i < surface.length;) {
    const k = isKanji(surface[i]);
    let j = i;
    while (j < surface.length && isKanji(surface[j]) === k) j++;
    runs.push({ start: i, text: surface.slice(i, j), kanji: k });
    i = j;
  }
  const pattern = '^' + runs.map(r => r.kanji ? '(.+?)' : escapeRe(toHiragana(r.text))).join('') + '$';
  const m = new RegExp(pattern, 'u').exec(reading);
  if (!m) return [[0, surface, reading]];
  const out = [];
  let g = 1;
  for (const r of runs) if (r.kanji) out.push([r.start, r.text, m[g++]]);
  return out;
}

// ---------------------------------------------------------------------------
// 편집용 표기 — 히라가나 칸  星[ほし]が  /  {終わり}[おわり]
// ---------------------------------------------------------------------------

export function formatRuby(text, ruby) {
  let sb = '', pos = 0;
  for (const r of ruby.filter(r => isValidFor(r, text)).sort((a, b) => a.at - b.at)) {
    if (r.at < pos) continue;
    sb += text.slice(pos, r.at);
    const plain = [...r.base].every(isKanji) && (r.at === 0 || !isKanji(text[r.at - 1]));
    sb += plain ? r.base : '{' + r.base + '}';
    sb += '[' + r.text + ']';
    pos = r.at + r.base.length;
  }
  return sb + text.slice(pos);
}

/** 히라가나 칸 표기를 읽는다. 괄호가 맞지 않으면 null. */
export function parseRuby(notation) {
  let text = '';
  const ruby = [];
  let braceStart = null, lastBrace = -1, lastBraceEnd = -1;
  for (let i = 0; i < notation.length; i++) {
    const c = notation[i];
    if (c === '{') { if (braceStart != null) return null; braceStart = text.length; continue; }
    if (c === '}') {
      if (braceStart == null) return null;
      lastBrace = braceStart; lastBraceEnd = text.length; braceStart = null;
      continue;
    }
    if (c === '[') {
      const close = notation.indexOf(']', i + 1);
      if (close < 0 || braceStart != null) return null;
      const kana = notation.slice(i + 1, close).trim();
      let start;
      if (lastBraceEnd === text.length && lastBrace >= 0) start = lastBrace;
      else {
        start = text.length;
        while (start > 0 && isKanji(text[start - 1])) start--;
      }
      if (start === text.length) return null;   // 읽기를 붙일 글자가 없음
      if (kana.length > 0) ruby.push({ at: start, base: text.slice(start), text: kana });
      lastBrace = lastBraceEnd = -1;
      i = close;
      continue;
    }
    if (c === ']') return null;
    text += c;
  }
  if (braceStart != null) return null;
  return { text, ruby };
}

// ---------------------------------------------------------------------------
// 편집용 표기 — 한글 칸  星[호시]が[가]今日[쿄우]
// ---------------------------------------------------------------------------

/** 단어마다 뒤에 [한글]. 독음이 없는 구간이 단어 앞에 끼어 있으면 그 구간 뒤에 빈 [] 를 둬서 구분한다. */
export function formatKor(text, kor) {
  let sb = '', pos = 0;
  for (const k of kor.filter(k => isValidFor(k, text)).sort((a, b) => a.at - b.at)) {
    if (k.at < pos) continue;
    if (k.at > pos) sb += text.slice(pos, k.at) + '[]';
    sb += k.base + '[' + k.text + ']';
    pos = k.at + k.base.length;
  }
  return sb + text.slice(pos);
}

/** 한글 칸 표기를 읽는다: 앞 ']' 다음부터 '[' 앞까지가 그 독음의 글자. 괄호가 맞지 않으면 null. */
export function parseKor(notation) {
  let text = '';
  const kor = [];
  let segStart = 0;
  for (let i = 0; i < notation.length; i++) {
    const c = notation[i];
    if (c === '[') {
      const close = notation.indexOf(']', i + 1);
      if (close < 0) return null;
      const hangul = notation.slice(i + 1, close).trim();
      if (hangul.length > 0 && text.length > segStart) kor.push({ at: segStart, base: text.slice(segStart), text: hangul });
      segStart = text.length;
      i = close;
      continue;
    }
    if (c === ']') return null;
    text += c;
  }
  return { text, kor };
}

// ---------------------------------------------------------------------------
// 가나 → 한글
// ---------------------------------------------------------------------------

export function toHiragana(s) {
  let out = '';
  for (const c of s) {
    const x = c.codePointAt(0);
    out += x >= 0x30A1 && x <= 0x30F6 ? String.fromCodePoint(x - 0x60) : c;
  }
  return out;
}

const KANA = (() => {
  const d = new Map();
  const row = (k, h) => { const ks = k.split(' '), hs = h.split(' '); ks.forEach((x, i) => d.set(x, hs[i])); };
  row('あ い う え お ぁ ぃ ぅ ぇ ぉ', '아 이 우 에 오 아 이 우 에 오');
  row('か き く け こ が ぎ ぐ げ ご', '카 키 쿠 케 코 가 기 구 게 고');
  row('さ し す せ そ ざ じ ず ぜ ぞ', '사 시 스 세 소 자 지 즈 제 조');
  row('た ち つ て と だ ぢ づ で ど', '타 치 츠 테 토 다 지 즈 데 도');
  row('な に ぬ ね の', '나 니 누 네 노');
  row('は ひ ふ へ ほ ば び ぶ べ ぼ ぱ ぴ ぷ ぺ ぽ', '하 히 후 헤 호 바 비 부 베 보 파 피 푸 페 포');
  row('ま み む め も', '마 미 무 메 모');
  row('や ゆ よ ゃ ゅ ょ', '야 유 요 야 유 요');
  row('ら り る れ ろ', '라 리 루 레 로');
  row('わ ゐ ゑ を ゎ ゔ ゕ ゖ', '와 이 에 오 와 부 카 케');
  row('きゃ きゅ きょ ぎゃ ぎゅ ぎょ', '캬 큐 쿄 갸 규 교');
  row('しゃ しゅ しょ じゃ じゅ じょ しぇ じぇ', '샤 슈 쇼 자 주 조 셰 제');
  row('ちゃ ちゅ ちょ ぢゃ ぢゅ ぢょ ちぇ', '차 추 초 자 주 조 체');
  row('にゃ にゅ にょ ひゃ ひゅ ひょ', '냐 뉴 뇨 햐 휴 효');
  row('びゃ びゅ びょ ぴゃ ぴゅ ぴょ', '뱌 뷰 뵤 퍄 퓨 표');
  row('みゃ みゅ みょ りゃ りゅ りょ', '먀 뮤 묘 랴 류 료');
  row('てぃ でぃ とぅ どぅ てゅ でゅ', '티 디 투 두 튜 듀');
  row('ふぁ ふぃ ふぇ ふぉ ふゅ', '화 휘 훼 훠 휴');
  row('うぃ うぇ うぉ いぇ つぁ', '위 웨 워 예 차');
  row('ゔぁ ゔぃ ゔぇ ゔぉ', '바 비 베 보');
  return d;
})();

/** 히라가나/가타카나 → 한글 독음 (か=카, っ=ㅅ받침, ん=ㄴ받침, ー=-). 표에 없는 글자는 그대로. */
export function toHangul(kana) {
  const s = toHiragana(kana);
  const out = [];
  const addFinal = (final, fallback) => {
    const p = out[out.length - 1];
    if (p && p.length === 1) {
      const x = p.codePointAt(0);
      if (x >= 0xAC00 && x <= 0xD7A3 && (x - 0xAC00) % 28 === 0) { out[out.length - 1] = String.fromCodePoint(x + final); return; }
    }
    if (fallback) out.push(fallback);
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === 'ん') { addFinal(4, '응'); continue; }
    if (c === 'っ') { addFinal(19, ''); continue; }
    if (c === 'ー') { out.push('-'); continue; }
    const two = i + 1 < s.length ? KANA.get(s.slice(i, i + 2)) : undefined;
    if (two) { out.push(two); i++; continue; }
    out.push(KANA.get(c) ?? c);
  }
  return out.join('');
}
