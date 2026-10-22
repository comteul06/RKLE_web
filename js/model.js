// 데이터 모델: lyrics.json ↔ 편집용 문장/하위 블럭, 박↔초 변환, 저장 형식.
// 데스크톱 편집기의 Models/LyricModel.cs · TempoMap.cs · Services/ChartIO.cs 를 옮긴 것.

export const DEFAULT_LINE_BEATS = 4;

/** 박(beat) ↔ 초(second) 변환. BPM 변화를 지원한다. */
export class TempoMap {
  constructor(bpm, offset, changes) {
    if (!(bpm > 0)) bpm = 120;
    this.segments = [{ beat: 0, time: offset || 0, bpm }];
    const list = (changes || []).filter(c => c.bpm > 0 && c.beat > 0).sort((a, b) => a.beat - b.beat);
    for (const c of list) {
      const prev = this.segments[this.segments.length - 1];
      const time = prev.time + (c.beat - prev.beat) * 60 / prev.bpm;
      this.segments.push({ beat: c.beat, time, bpm: c.bpm });
    }
  }
  segByBeat(beat) {
    for (let i = this.segments.length - 1; i >= 0; i--) if (beat >= this.segments[i].beat) return this.segments[i];
    return this.segments[0];
  }
  beatToSeconds(beat) {
    const s = this.segByBeat(beat);
    return s.time + (beat - s.beat) * 60 / s.bpm;
  }
  secondsToBeat(sec) {
    let s = this.segments[0];
    for (let i = this.segments.length - 1; i >= 0; i--) if (sec >= this.segments[i].time) { s = this.segments[i]; break; }
    return s.beat + (sec - s.time) * s.bpm / 60;
  }
  /** 해당 박 위치에서 1박의 길이(초) */
  secondsPerBeatAt(beat) { return 60 / this.segByBeat(beat).bpm; }
}

// ---------------------------------------------------------------------------
// 편집용 블럭
//   문장(line): { beat, end, text, isSub, words: [word], ruby: [reading], kor: [reading], rubyText }
//   하위 블럭(word): { beat, end, text }
//   읽기(reading): { at, base, text }  — 표시 텍스트의 at 번째 글자부터 base 위(히라가나) 또는 아래(한글)에 text
// ---------------------------------------------------------------------------

/** 화면/목록에 보여줄 문장: 하위 블럭이 있으면 그 텍스트를 이어붙인 것 */
export const displayText = line => line.words.length > 0 ? line.words.map(w => w.text).join('') : line.text;

export const isValidFor = (r, text) =>
  r.base.length > 0 && r.at >= 0 && r.at + r.base.length <= text.length && text.substr(r.at, r.base.length) === r.base;

export const sortLines = lines => lines.sort((a, b) => a.beat - b.beat);
export const sortWords = line => line.words.sort((a, b) => a.beat - b.beat);

export function newLine(beat, end) {
  return { beat, end, text: '', isSub: false, words: [], ruby: [], kor: [], rubyText: null };
}

/** lyrics.json 의 lyrics → 문장 블럭 목록 */
export function fromChart(chart) {
  const src = [...(chart.lyrics || [])].sort((a, b) => a.beat - b.beat);
  const lines = [];
  for (let i = 0; i < src.length; i++) {
    const l = src[i];
    const words = [...(l.words || [])].sort((a, b) => a.beat - b.beat);
    // 문장 끝: end → 마지막 조각의 끝 → 다음 문장 시작 → +4박
    let end = l.end;
    if (end == null && words.length > 0 && words[words.length - 1].end != null) end = words[words.length - 1].end;
    if (end == null) end = i + 1 < src.length ? src[i + 1].beat : l.beat + DEFAULT_LINE_BEATS;

    const line = newLine(l.beat, Math.max(end, l.beat + 0.25));
    line.isSub = l.sub === true;
    line.text = l.text ?? words.map(w => w.text).join('');
    for (let w = 0; w < words.length; w++) {
      const wEnd = words[w].end ?? (w + 1 < words.length ? words[w + 1].beat : line.end);
      line.words.push({ beat: words[w].beat, end: Math.max(wEnd, words[w].beat), text: words[w].text || '' });
    }
    // 저장된 읽기가 있으면 그대로 쓴다. 한쪽이라도 없으면 rubyText = null 이라 열 때 자동으로 채워진다
    const text = displayText(line);
    if (l.ruby) line.ruby = l.ruby.map(r => ({ at: r.at, base: r.base || '', text: r.kana || '' })).filter(r => isValidFor(r, text));
    if (l.kor) line.kor = l.kor.map(r => ({ at: r.at, base: r.base || '', text: r.kor || '' })).filter(r => isValidFor(r, text));
    else if (l.ruby) line.kor = l.ruby.filter(r => r.kor).map(r => ({ at: r.at, base: r.base, text: r.kor })).filter(r => isValidFor(r, text));
    if (l.ruby && l.kor) line.rubyText = text;
    lines.push(line);
  }
  return lines;
}

/** 저장용. 문장/하위 블럭 모두 끝 박을 명시해서 노래방이 길이를 그대로 쓰게 한다. */
export function toLyrics(lines, hasJapanese) {
  sortLines(lines);
  return lines.map(l => {
    sortWords(l);
    const text = displayText(l);
    const jp = hasJapanese(text);
    return {
      beat: l.beat,
      end: l.end,
      sub: l.isSub ? true : undefined,
      text: l.text,
      words: l.words.length === 0 ? undefined : l.words.map(w => ({ beat: w.beat, end: w.end, text: w.text })),
      // 일본어 문장은 읽기를 모두 지웠어도 빈 목록으로 저장해서, 다시 열 때 자동으로 채워지지 않게 한다
      ruby: !jp && l.ruby.length === 0 ? undefined
        : l.ruby.filter(r => isValidFor(r, text)).sort((a, b) => a.at - b.at).map(r => ({ at: r.at, base: r.base, kana: r.text })),
      kor: !jp && l.kor.length === 0 ? undefined
        : l.kor.filter(r => isValidFor(r, text)).sort((a, b) => a.at - b.at).map(r => ({ at: r.at, base: r.base, kor: r.text })),
    };
  });
}

/**
 * 문장을 하위 블럭으로 나누기 위한 조각 분리.
 * 한글/가나는 한 글자씩, 영어 단어는 통째로, 띄어쓰기·문장부호는 앞 조각에 붙인다.
 */
export function splitText(text) {
  const tokens = [];
  let prevLatin = false;
  const isPunct = ch => /[\p{P}\p{S}]/u.test(ch);
  for (const ch of text.trim()) {
    if (/\s/.test(ch)) {
      if (tokens.length > 0 && !tokens[tokens.length - 1].endsWith(' ')) tokens[tokens.length - 1] += ' ';
      prevLatin = false;
      continue;
    }
    const latin = /^[A-Za-z0-9]$/.test(ch) || ch === "'";
    const punct = isPunct(ch) && ch !== "'";
    const lastEndsWithSpace = tokens.length > 0 && tokens[tokens.length - 1].endsWith(' ');
    if (latin && prevLatin && !lastEndsWithSpace) tokens[tokens.length - 1] += ch;
    else if (punct && tokens.length > 0 && !lastEndsWithSpace) tokens[tokens.length - 1] += ch;
    else tokens.push(ch);
    prevLatin = latin;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// lyrics.json 읽기 / 쓰기
// ---------------------------------------------------------------------------

const CANON = ['title', 'artist', 'bpm', 'offset', 'bpmChanges', 'audio', 'video', 'videoOffset', 'beatsPerMeasure',
  'lyrics', 'beat', 'end', 'text', 'words', 'sub', 'ruby', 'kor', 'at', 'base', 'kana'];
const CANON_MAP = new Map(CANON.map(k => [k.toLowerCase(), k]));

/** 주석(// /* *\/)과 마지막 쉼표를 허용하고, 속성 이름의 대소문자를 구분하지 않는다 (노래방 프로그램과 같은 규칙). */
export function parseChart(jsonText) {
  let out = '', i = 0, inStr = false;
  const s = jsonText.replace(/^﻿/, '');
  while (i < s.length) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += s[i + 1] ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++; continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { i = s.indexOf('*/', i + 2); i = i < 0 ? s.length : i + 2; continue; }
    out += c; i++;
  }
  out = out.replace(/,(\s*[}\]])/g, '$1');
  const norm = v => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v)) o[CANON_MAP.get(k.toLowerCase()) ?? k] = norm(val);
      return o;
    }
    return v;
  };
  const chart = norm(JSON.parse(out)) || {};
  return {
    title: chart.title ?? null,
    artist: chart.artist ?? null,
    bpm: chart.bpm > 0 ? chart.bpm : 120,
    offset: chart.offset || 0,
    bpmChanges: (chart.bpmChanges || []).map(c => ({ beat: c.beat, bpm: c.bpm })),
    audio: chart.audio ?? null,
    video: chart.video ?? null,
    videoOffset: chart.videoOffset || 0,
    beatsPerMeasure: chart.beatsPerMeasure > 0 ? chart.beatsPerMeasure : null,
    lyrics: chart.lyrics || [],
  };
}

export function emptyChart() {
  return { title: null, artist: null, bpm: 120, offset: 0, bpmChanges: [], audio: null, video: null, videoOffset: 0, beatsPerMeasure: null, lyrics: [] };
}

const Str = s => JSON.stringify(s);
const Num = v => {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
};

/** 사람이 읽고 고치기 쉬운 모양으로 저장한다 (가사 조각은 한 줄에 하나씩). 데스크톱 편집기와 같은 형식. */
export function chartToJson(c) {
  let sb = '{\n';
  sb += `  "title": ${Str(c.title ?? '')},\n`;
  sb += `  "artist": ${Str(c.artist ?? '')},\n`;
  sb += `  "bpm": ${Num(c.bpm)},\n`;
  sb += `  "offset": ${Num(c.offset)},\n`;
  if (c.beatsPerMeasure != null) sb += `  "beatsPerMeasure": ${c.beatsPerMeasure},\n`;
  if (c.bpmChanges.length > 0) {
    sb += '  "bpmChanges": [\n';
    c.bpmChanges.forEach((b, i) => {
      sb += `    { "beat": ${Num(b.beat)}, "bpm": ${Num(b.bpm)} }`;
      sb += i + 1 < c.bpmChanges.length ? ',\n' : '\n';
    });
    sb += '  ],\n';
  }
  if (c.audio != null) sb += `  "audio": ${Str(c.audio)},\n`;
  if (c.video != null) sb += `  "video": ${Str(c.video)},\n`;
  if (c.videoOffset !== 0) sb += `  "videoOffset": ${Num(c.videoOffset)},\n`;

  const readings = (name, field, list) => {
    let s = `, "${name}": [`;
    list.forEach((r, i) => {
      s += i === 0 ? '\n' : ',\n';
      s += `      { "at": ${r.at}, "base": ${Str(r.base)}, "${field}": ${Str(r[field])} }`;
    });
    return s + (list.length > 0 ? '\n    ]' : ']');
  };

  sb += '  "lyrics": [\n';
  c.lyrics.forEach((line, li) => {
    sb += `    { "beat": ${Num(line.beat)}`;
    if (line.end != null) sb += `, "end": ${Num(line.end)}`;
    if (line.sub === true) sb += ', "sub": true';
    if (line.words && line.words.length > 0) {
      // 문장 원문도 함께 저장 (노래방은 words 가 있으면 text 를 무시하므로 영향 없음)
      if (line.text) sb += `, "text": ${Str(line.text)}`;
      sb += ', "words": [\n';
      line.words.forEach((w, wi) => {
        sb += `      { "beat": ${Num(w.beat)}`;
        if (w.end != null) sb += `, "end": ${Num(w.end)}`;
        sb += `, "text": ${Str(w.text)} }`;
        sb += wi + 1 < line.words.length ? ',\n' : '\n';
      });
      sb += '    ]';
    } else {
      sb += `, "text": ${Str(line.text ?? '')}`;
    }
    // 읽기: 위 줄(ruby: 한자 → 히라가나), 아래 줄(kor: 단어 → 한글). 한 줄에 하나씩
    if (line.ruby) sb += readings('ruby', 'kana', line.ruby);
    if (line.kor) sb += readings('kor', 'kor', line.kor);
    sb += ' }';
    sb += li + 1 < c.lyrics.length ? ',\n' : '\n';
  });
  sb += '  ]\n}\n';
  return sb;
}

export function formatTime(s) {
  if (!(s > 0)) s = 0;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(3).padStart(6, '0')}`;
}
