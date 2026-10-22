// Rhygay 가사 편집기 (웹판). 데스크톱 편집기(WPF)의 MainWindow*.cs 를 옮긴 것.
//   타임라인 그리기/편집 → timeline.js     전용 스크롤바 → scrollbar.js
//   재생/파형 → audio.js                   일본어 읽기 → reading.js     데이터/저장 형식 → model.js

import {
  TempoMap, fromChart, toLyrics, chartToJson, parseChart, emptyChart, displayText, splitText,
  sortWords, formatTime,
} from './model.js';
import { AudioPlayer, WaveformData } from './audio.js';
import { Timeline } from './timeline.js';
import { VScroll } from './scrollbar.js';
import {
  initReading, isReadingReady, updateReading, regenerateReading, applyRubyEdit,
  formatRuby, parseRuby, formatKor, parseKor, hasJapanese,
} from './reading.js';

const $ = id => document.getElementById(id);
const SNAP_PRESETS = [1, 2, 3, 4, 6, 8, 12, 16];
const AUDIO_EXT = ['.flac', '.wav', '.mp3'];        // 노래방 프로그램과 같은 우선순위
const DEFAULT_PPS = 260;
const DIC_PATH = window.RKLE_DIC_PATH || 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 불가 (사생활 보호 모드 등) */ } },
};

// ===========================================================================
// 상태
// ===========================================================================

const S = {
  chart: emptyChart(),   // 곡 정보 (lyrics.json). 편집 중 lyrics 는 비워 두고, 가사의 원본은 lines
  lines: [],             // 문장 블럭 목록
  source: null,          // 연 곡 폴더: { name, files: Map(소문자 이름 → 항목), dir?: 폴더 핸들 }
  audioName: null,       // 지금 불러온 음원 파일 이름
  dirty: false,
  undo: [], redo: [],
  infoSnap: null,        // 곡 정보 입력칸 하나에서 입력을 시작하기 전 상태
  panelTarget: null, textUndoPushed: false,
  suppress: false,
};
const MAX_UNDO = 300;

const player = new AudioPlayer();
let scroll = null;   // 타임라인이 처음 크기를 잡을 때(생성자 안) 아직 없으므로 먼저 선언만
const timeline = new Timeline($('timeline'), {
  pushUndo, onEdited, onSelectionChanged: refreshLyricsPanel,
  seekTo, requestTextEdit, onResize: () => scroll && scroll.update(),
});
scroll = new VScroll($('vscroll'), {
  getTime: () => timeline.currentTime,
  getDuration: () => player.duration || 0,
  getVisible: () => timeline.visibleSeconds,
  scrollTo,
  // ▲▼: 0 = 스냅 한 칸, 1 = 한 마디, 2 = 네 마디 (오래 누르고 있을 때)
  stepBy: (dir, level = 0) => {
    let t = timeline.currentTime;
    for (let i = 0; i < (level === 2 ? 4 : 1); i++) t = timeline.stepTime(t, dir > 0, level > 0);
    seekTo(t);
  },
});

const status = msg => { $('statusText').textContent = msg; };
const loaded = () => S.source != null && player.loaded;

// ===========================================================================
// 재생 위치 — 흰 선(timeline.currentTime)이 정지 중 위치의 유일한 기준
// ===========================================================================

/** 현재 위치: 재생 중이면 재생기, 정지 중이면 흰 선 */
const currentPos = () => player.playing ? player.position : timeline.currentTime;

function frame() {
  if (!player.playing) return;
  timeline.currentTime = player.position;
  refreshView();
  requestAnimationFrame(frame);
}

/** 모든 위치 이동은 여기를 거친다 (스크롤바 / ▲▼ / 눈금자 / 목록 / 키보드) */
function seekTo(time) {
  if (!loaded()) return;
  time = Math.min(Math.max(time, 0), player.duration || Infinity);
  timeline.currentTime = time;                 // 정지 중이면 이것이 다음 재생 시작 위치
  if (player.playing) player.play(time);       // 재생 중이면 그 위치에서 이어서 재생
  refreshView();
}

// 재생 중 스크롤바 끌기: 소리는 조금씩만 다시 시작하고(끊김 방지), 손을 떼면 정확히 그 위치에서
let lastScrubPlay = 0;
function scrollTo(time, final) {
  if (!loaded()) return;
  if (!player.playing) { seekTo(time); return; }
  time = Math.min(Math.max(time, 0), player.duration);
  const now = performance.now();
  if (final || now - lastScrubPlay > 120) { lastScrubPlay = now; seekTo(time); }
  else { timeline.currentTime = time; refreshView(); }
}

function togglePlay() {
  if (!loaded()) return;
  if (player.playing) {
    // 일시정지: 멈추기 "전에" 위치를 읽고, 흰 선에 남겨 둔다
    const at = player.position;
    player.stop();
    timeline.currentTime = at;
  } else {
    // 다시 재생: 흰 선 위치에서. 곡 끝에 있으면 처음부터
    let from = timeline.currentTime;
    if (from >= player.duration - 0.05) from = 0;
    timeline.currentTime = from;
    player.play(from);
    requestAnimationFrame(frame);
  }
  refreshView();
}

player.onEnded = () => {
  timeline.currentTime = player.duration;
  refreshView();
};

function refreshView() {
  timeline.invalidate();
  scroll.update();
  $('timeText').textContent = `${formatTime(timeline.currentTime)} / ${formatTime(player.duration || 0)}`;
  $('playBtn').textContent = player.playing ? '❚❚' : '▶';
}

// ===========================================================================
// 그리드 / 스냅 / 확대
// ===========================================================================

function applyGrid() {
  const c = S.chart;
  timeline.tempo = new TempoMap(c.bpm, c.offset, c.bpmChanges);
  timeline.bpm = c.bpm;
  timeline.bpmChanges = c.bpmChanges;
  timeline.beatsPerMeasure = c.beatsPerMeasure > 0 ? c.beatsPerMeasure : 4;
  updateGridText();
  timeline.invalidate();
}

function updateGridText() {
  const c = S.chart;
  $('gridText').textContent = `BPM ${+c.bpm.toFixed(2)}${c.bpmChanges.length ? '~' : ''} · 오프셋 ${c.offset.toFixed(3)}s · 스냅 1/${timeline.snapDivision}`;
}

SNAP_PRESETS.forEach(d => $('snapSel').add(new Option(d === 1 ? '1/1 (박)' : `1/${d}`, d)));
function setSnapIndex(i) {
  $('snapSel').selectedIndex = i;
  timeline.snapDivision = SNAP_PRESETS[i];
  updateGridText();
  timeline.invalidate();
}
$('snapSel').addEventListener('change', () => setSnapIndex($('snapSel').selectedIndex));
setSnapIndex(3);

function setZoom(pps) {
  timeline.pps = Math.min(Math.max(pps, 30), 3000);
  $('zoomText').textContent = Math.round(timeline.pps / DEFAULT_PPS * 100) + '%';
  store.set('rkle.zoom', String(timeline.pps));
  refreshView();
}
$('zoomIn').addEventListener('click', () => setZoom(timeline.pps * 1.25));
$('zoomOut').addEventListener('click', () => setZoom(timeline.pps / 1.25));
setZoom(+store.get('rkle.zoom') || DEFAULT_PPS);

$('playBtn').addEventListener('click', togglePlay);

// ===========================================================================
// 가사 — 타임라인 알림 처리
// ===========================================================================

function pushUndo() {
  commitInfoEdit();
  pushUndoState(snapshot());
}

function onEdited() {
  updateReadings();
  markDirty();
  refreshLyricsPanel();
  timeline.invalidate();
}

/** 더블클릭 / Enter: 하위 블럭이 선택돼 있으면 조각 입력칸, 아니면 문장 입력칸으로 */
function requestTextEdit() {
  showTab('line');
  const el = timeline.selWord ? $('wordText') : timeline.selLine ? $('lineText') : null;
  if (el) { el.focus(); el.select(); }
}

// ===========================================================================
// 가사 — 오른쪽 패널 (선택한 문장 / 하위 블럭 / 문장 목록)
// ===========================================================================

function refreshLyricsPanel() {
  const line = timeline.selLine, word = timeline.selWord;
  const target = word || line;
  if (target !== S.panelTarget) { S.panelTarget = target; S.textUndoPushed = false; }

  S.suppress = true;
  const tempo = timeline.tempo;
  const T = beat => tempo ? formatTime(tempo.beatToSeconds(beat)) : '';
  const n = v => +v.toFixed(3);

  for (const id of ['lineText', 'subCheck', 'rubyText', 'korText', 'regenBtn', 'splitEvenBtn', 'fillWordsBtn', 'clearWordsBtn', 'deleteLineBtn'])
    $(id).disabled = !line;
  if (!line) {
    $('lineInfo').textContent = '문장 블럭을 선택하세요';
    $('lineText').value = '';
    $('subCheck').checked = false;
    $('rubyText').value = '';
    $('korText').value = '';
  } else {
    const idx = S.lines.indexOf(line);
    $('lineInfo').textContent = `L${idx + 1}  박 ${n(line.beat)}~${n(line.end)} (${n(line.end - line.beat)}박)  ${T(line.beat)}  · 하위 ${line.words.length}개`;
    if ($('lineText').value !== line.text && document.activeElement !== $('lineText')) $('lineText').value = line.text;
    $('subCheck').checked = line.isSub;
    showReading(line);
  }

  for (const id of ['wordText', 'prevWordBtn', 'nextWordBtn', 'splitWordBtn', 'deleteWordBtn']) $(id).disabled = !word;
  $('prevWordBtn').disabled = $('nextWordBtn').disabled = !loaded();
  if (!word) {
    $('wordInfo').textContent = line ? '캡슐 안 빈 곳을 탭하면 하위 블럭이 생깁니다' : '하위 블럭을 선택하세요';
    $('wordText').value = '';
  } else {
    const wi = line.words.indexOf(word);
    $('wordInfo').textContent = `#${wi + 1}/${line.words.length}  박 ${n(word.beat)}~${n(word.end)} (${n(word.end - word.beat)}박)  ${T(word.beat)}`;
    if ($('wordText').value !== word.text && document.activeElement !== $('wordText')) $('wordText').value = word.text;
  }
  S.suppress = false;

  refreshLineList();
  timeline.invalidate();
}

function beginTextEdit() {
  if (S.textUndoPushed) return;
  pushUndo();
  S.textUndoPushed = true;
}

$('lineText').addEventListener('input', () => {
  const line = timeline.selLine;
  if (S.suppress || !line || line.text === $('lineText').value) return;
  beginTextEdit();
  line.text = $('lineText').value;
  if (updateReading(line)) showReading(line);
  markDirty();
  refreshLineList();
  timeline.invalidate();
});

$('wordText').addEventListener('input', () => {
  const word = timeline.selWord;
  if (S.suppress || !word || word.text === $('wordText').value) return;
  beginTextEdit();
  word.text = $('wordText').value;
  if (timeline.selLine && updateReading(timeline.selLine)) showReading(timeline.selLine);
  markDirty();
  refreshLineList();
  timeline.invalidate();
});

// 기본 가사 ↔ 서브 가사 (체크박스 / S 키)
$('subCheck').addEventListener('change', () => setSub($('subCheck').checked));
function toggleSub() { if (timeline.selLine) setSub(!timeline.selLine.isSub); }
function setSub(sub) {
  const line = timeline.selLine;
  if (!line || line.isSub === sub) return;
  pushUndo();
  line.isSub = sub;
  onEdited();
  status(sub ? '서브 가사 (노란색)' : '기본 가사 (파란색)');
}

let lastListSel = null;
function refreshLineList() {
  const tempo = timeline.tempo;
  const list = $('lineList');
  const frag = document.createDocumentFragment();
  S.lines.forEach((l, i) => {
    const div = document.createElement('div');
    div.className = 'item' + (l.isSub ? ' sub' : '') + (l === timeline.selLine ? ' sel' : '');
    const text = displayText(l) || '(가사 없음)';
    div.innerHTML = `L${i + 1}${l.isSub ? ' [서브]' : ''}<span class="t"></span>`;
    div.querySelector('.t').textContent = tempo ? formatTime(tempo.beatToSeconds(l.beat)) : '';
    div.appendChild(document.createTextNode(text));
    div.addEventListener('click', () => selectAndShow(l, null));
    frag.appendChild(div);
  });
  list.replaceChildren(frag);
  $('lineCount').textContent = S.lines.length ? `(${S.lines.length})` : '';
  if (timeline.selLine !== lastListSel) {
    lastListSel = timeline.selLine;
    const sel = list.querySelector('.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
}

/** 선택하고 (정지 중이면) 흰 선을 그 블럭 시작으로 옮긴다 */
function selectAndShow(line, word) {
  timeline.selLine = line;
  timeline.selWord = word;
  const beat = word ? word.beat : line ? line.beat : null;
  if (beat != null && !player.playing && timeline.tempo) seekTo(timeline.tempo.beatToSeconds(beat));
  refreshLyricsPanel();
}

// ---------------------------------------------------------------- 일본어 읽기

/** 글자가 바뀐 문장의 읽기를 다시 만든다 (같은 글자의 기존 읽기는 유지). 문장을 고칠 때·열 때·저장할 때 부른다. */
function updateReadings() {
  let changed = false;
  for (const l of S.lines) changed = updateReading(l) || changed;
  if (changed && timeline.selLine) showReading(timeline.selLine);
  return changed;
}

/** 히라가나 칸 / 한글 칸에 선택한 문장의 읽기를 표기로 보여준다 (입력 중인 칸은 건드리지 않음) */
function showReading(line, ruby = true, kor = true) {
  const old = S.suppress;
  S.suppress = true;
  const text = displayText(line);
  const pending = !isReadingReady() && line.rubyText == null && hasJapanese(text);
  $('rubyText').placeholder = $('korText').placeholder = pending ? '일본어 사전을 불러오는 중…' : '';
  if (ruby && document.activeElement !== $('rubyText')) $('rubyText').value = formatRuby(text, line.ruby);
  if (kor && document.activeElement !== $('korText')) $('korText').value = formatKor(text, line.kor);
  S.suppress = old;
}

function checkReadingText(parsedText, line) {
  if (parsedText == null) { status('읽기 표기의 괄호가 맞지 않습니다'); return false; }
  if (parsedText !== displayText(line)) { status('읽기 칸에서는 가사 글자를 바꿀 수 없습니다 (괄호 안 읽기만 고치세요)'); return false; }
  return true;
}

// 히라가나 칸 직접 고치기: 星[ほし] / {終わり}[おわり]. 고친 한자가 든 단어의 한글 독음도 따라 바뀐다.
$('rubyText').addEventListener('input', () => {
  const line = timeline.selLine;
  if (S.suppress || !line) return;
  const p = parseRuby($('rubyText').value);
  if (!checkReadingText(p && p.text, line)) return;
  beginTextEdit();
  applyRubyEdit(line, p.ruby);
  showReading(line, false, true);
  status('');
  markDirty();
  timeline.invalidate();
});

// 한글 칸 직접 고치기: 星[호시]が[가]. ']' 다음부터 '[' 앞까지가 그 독음의 글자.
$('korText').addEventListener('input', () => {
  const line = timeline.selLine;
  if (S.suppress || !line) return;
  const p = parseKor($('korText').value);
  if (!checkReadingText(p && p.text, line)) return;
  beginTextEdit();
  line.kor = p.kor;
  line.rubyText = displayText(line);
  status('');
  markDirty();
  timeline.invalidate();
});
// 칸을 벗어나면 정리된 표기로 다시 보여준다
for (const id of ['rubyText', 'korText']) $(id).addEventListener('blur', () => timeline.selLine && showReading(timeline.selLine));

$('regenBtn').addEventListener('click', () => {
  const line = timeline.selLine;
  if (!line) return;
  if (!isReadingReady()) { status('일본어 사전을 아직 불러오는 중입니다'); return; }
  pushUndo();
  regenerateReading(line);
  showReading(line);
  markDirty();
  timeline.invalidate();
  status(line.kor.length === 0 ? '읽기를 붙일 일본어가 없습니다'
    : `히라가나 ${line.ruby.length}개 · 한글 독음 ${line.kor.length}개를 자동으로 다시 만들었습니다`);
});

// ---------------------------------------------------------------- 문장을 하위 블럭으로 나누기 / 채우기

/**
 * 문장 가사를 조각(한글 한 글자, 영어 한 단어)으로 나눠, 문장 길이에 고르게 하위 블럭을 만든다.
 * 스냅 칸이 충분하면 경계를 그리드에 맞추고, 모자라면 그냥 균등 분할한다. 기존 하위 블럭은 대체.
 */
$('splitEvenBtn').addEventListener('click', () => {
  const line = timeline.selLine;
  if (!line) return;
  const tokens = splitText(line.text);
  if (tokens.length === 0) { status('먼저 문장 가사를 입력하세요'); return; }
  const n = tokens.length, step = 1 / timeline.snapDivision, len = line.end - line.beat;
  const onGrid = len / n >= step - 1e-9;
  const edges = new Array(n + 1);
  edges[0] = line.beat; edges[n] = line.end;
  for (let i = 1; i < n; i++) {
    const raw = line.beat + len * i / n;
    let v = onGrid ? timeline.snap(raw) : raw;
    const minStep = onGrid ? step : len / n * 0.5;
    v = Math.max(v, edges[i - 1] + minStep);       // 앞 경계보다 뒤
    v = Math.min(v, line.end - minStep * (n - i));  // 뒤에 남은 조각 자리 확보
    edges[i] = v;
  }
  pushUndo();
  line.words = tokens.map((t, i) => ({ beat: edges[i], end: edges[i + 1], text: t }));
  timeline.selWord = line.words[0] || null;
  onEdited();
  status(`${n}개 하위 블럭으로 나눴습니다` + (onGrid ? '' : ' (스냅 칸이 모자라 그리드 없이 균등 분할)'));
});

/** 이미 찍어 둔 하위 블럭에 문장 가사를 한 조각씩 순서대로 넣는다. */
$('fillWordsBtn').addEventListener('click', () => {
  const line = timeline.selLine;
  if (!line) return;
  if (line.words.length === 0) { status('먼저 캡슐 안을 탭해 하위 블럭을 찍으세요'); return; }
  const tokens = splitText(line.text);
  if (tokens.length === 0) { status('먼저 문장 가사를 입력하세요'); return; }
  pushUndo();
  sortWords(line);
  const n = Math.min(tokens.length, line.words.length);
  for (let i = 0; i < n; i++) line.words[i].text = tokens[i];
  // 조각이 더 많으면 남은 조각은 마지막 블럭에 붙인다
  if (tokens.length > n) line.words[line.words.length - 1].text += tokens.slice(n).join('');
  onEdited();
  status(tokens.length === line.words.length ? `${n}개 하위 블럭을 채웠습니다`
    : tokens.length > line.words.length ? `블럭이 ${tokens.length - line.words.length}개 모자라 남은 글자를 마지막 블럭에 붙였습니다`
    : `조각이 모자라 ${line.words.length - n}개 블럭은 그대로 두었습니다`);
});

$('clearWordsBtn').addEventListener('click', () => {
  const line = timeline.selLine;
  if (!line || line.words.length === 0) return;
  pushUndo();
  line.words = [];
  timeline.selWord = null;
  onEdited();
});

// ---------------------------------------------------------------- 삭제 / 이동 / 나누기

$('deleteLineBtn').addEventListener('click', deleteLine);
$('deleteWordBtn').addEventListener('click', deleteWord);
$('prevWordBtn').addEventListener('click', () => selectWordRelative(-1, true));
$('nextWordBtn').addEventListener('click', () => selectWordRelative(+1, true));

/** Delete 키: 하위 블럭이 선택돼 있으면 그것만, 아니면 문장 전체 */
function deleteSelection() { if (timeline.selWord) deleteWord(); else deleteLine(); }

function deleteLine() {
  const line = timeline.selLine;
  if (!line) return;
  const idx = S.lines.indexOf(line);
  pushUndo();
  S.lines.splice(idx, 1);
  timeline.selLine = S.lines.length === 0 ? null : S.lines[Math.min(idx, S.lines.length - 1)];
  timeline.selWord = null;
  onEdited();
}

function deleteWord() {
  const line = timeline.selLine, word = timeline.selWord;
  if (!line || !word) return;
  const idx = line.words.indexOf(word);
  pushUndo();
  line.words.splice(idx, 1);
  timeline.selWord = line.words.length === 0 ? null : line.words[Math.min(idx, line.words.length - 1)];
  onEdited();
}

/** 선택한 하위 블럭을 흰 선 위치(스냅)에서 둘로 나눈다 — 터치에서 Ctrl+클릭 대신 */
$('splitWordBtn').addEventListener('click', () => {
  const line = timeline.selLine, word = timeline.selWord;
  if (!line || !word || !timeline.tempo) return;
  const at = timeline.snap(timeline.tempo.secondsToBeat(currentPos()));
  if (!timeline.splitWord(line, word, at)) status('흰 선을 나눌 하위 블럭 안(끝이 아닌 곳)에 두고 누르세요');
});

/**
 * 이전/다음 하위 블럭으로 (문장을 넘어서도 이어짐). 하위 블럭이 없는 문장은 문장 자체를 한 칸으로 친다.
 * 선택이 없으면 흰 선 근처부터.
 */
function selectWordRelative(delta, seek) {
  const items = [];
  for (const l of S.lines) {
    if (l.words.length === 0) items.push({ line: l, word: null, beat: l.beat });
    else for (const w of l.words) items.push({ line: l, word: w, beat: w.beat });
  }
  if (items.length === 0) return;
  const cur = items.findIndex(it => it.line === timeline.selLine && it.word === timeline.selWord);
  let next;
  if (cur >= 0) next = Math.min(Math.max(cur + delta, 0), items.length - 1);
  else if (timeline.selLine) next = items.findIndex(it => it.line === timeline.selLine);
  else {
    const beat = timeline.tempo ? timeline.tempo.secondsToBeat(currentPos()) : 0;
    next = items.findIndex(it => it.beat >= beat - 1e-6);
    if (next < 0) next = items.length - 1;
  }
  const { line, word } = items[next];
  if (seek) selectAndShow(line, word);
  else { timeline.selLine = line; timeline.selWord = word; refreshLyricsPanel(); }
}

// ===========================================================================
// 곡 정보 (제목 / 아티스트 / BPM / 마디당 박 / 오프셋 / 음원 / BGA / BGA 오프셋 / BPM 변화)
// ===========================================================================

const num = s => { const v = parseFloat(String(s).trim()); return Number.isFinite(v) && /^\s*[-+]?(\d+\.?\d*|\.\d+)\s*$/.test(s) ? v : null; };

function loadSongInfoFields() {
  const c = S.chart;
  S.suppress = true;
  $('titleBox').value = c.title ?? '';
  $('artistBox').value = c.artist ?? '';
  $('bpmBox').value = String(+c.bpm.toFixed(3));
  $('measureBox').value = String(c.beatsPerMeasure > 0 ? c.beatsPerMeasure : 4);
  $('offsetBox').value = c.offset.toFixed(3);
  $('videoOffsetBox').value = String(+c.videoOffset.toFixed(3));
  fillMediaSelects();
  S.suppress = false;
  refreshBpmChangeList();
}

/** 입력하는 즉시 반영. BPM / 오프셋 / 마디당 박은 타임라인 그리드에 바로 보인다. */
for (const el of document.querySelectorAll('.info-field')) {
  el.addEventListener('input', () => {
    if (S.suppress || !loaded()) return;
    S.infoSnap ??= snapshot();
    const c = S.chart;
    c.title = $('titleBox').value;
    c.artist = $('artistBox').value;
    let grid = false;
    const bpm = num($('bpmBox').value);
    if (bpm > 0 && bpm !== c.bpm) { c.bpm = bpm; grid = true; }
    const off = num($('offsetBox').value);
    if (off != null && off !== c.offset) { c.offset = off; grid = true; }
    const m = num($('measureBox').value);
    if (m != null && Number.isInteger(m) && m > 0 && m <= 32) {
      const v = m === 4 ? null : m;   // 4 는 기본값이라 저장하지 않음
      if (v !== c.beatsPerMeasure) { c.beatsPerMeasure = v; grid = true; }
    }
    const vo = num($('videoOffsetBox').value);
    if (vo != null) c.videoOffset = vo;
    markDirty();
    if (grid) { applyGrid(); refreshLyricsPanel(); }
  });
  el.addEventListener('change', commitInfoEdit);   // 입력칸을 벗어나면 되돌리기 한 단계로 확정
}

function commitInfoEdit() {
  if (S.infoSnap == null) return;
  const before = S.infoSnap;
  S.infoSnap = null;
  if (before !== snapshot()) pushUndoState(before);
}

/** 버튼으로 하는 곡 정보 변경: 되돌리기 지점 → 변경 → 갱신 */
function changeInfo(change) {
  commitInfoEdit();
  pushUndoState(snapshot());
  change(S.chart);
  loadSongInfoFields();
  applyGrid();
  refreshLyricsPanel();
}

$('offsetNowBtn').addEventListener('click', () => {
  if (!loaded()) return;
  const now = currentPos();
  changeInfo(c => { c.offset = Math.round(now * 1000) / 1000; });
  status(`오프셋 = ${S.chart.offset.toFixed(3)}초`);
});

// 음원 / BGA: 곡 폴더 안의 파일 중에서 고른다 (노래방은 lyrics.json 과 같은 폴더의 파일만 읽음)
function fillMediaSelects() {
  const files = S.source ? [...S.source.files.values()] : [];
  const a = $('audioSel'), v = $('videoSel');
  a.replaceChildren(); v.replaceChildren();
  const auto = findAudio(null);
  a.add(new Option(auto ? `(자동) ${auto.name}` : '(자동)', ''));
  for (const f of files.filter(f => isAudio(f.name)).sort((x, y) => x.name.localeCompare(y.name))) a.add(new Option(f.name, f.name));
  if (S.chart.audio && ![...a.options].some(o => o.value === S.chart.audio)) a.add(new Option(`${S.chart.audio} (없음)`, S.chart.audio));
  a.value = S.chart.audio ?? '';
  v.add(new Option('(없음)', ''));
  for (const f of files.filter(f => /\.mp4$/i.test(f.name)).sort((x, y) => x.name.localeCompare(y.name))) v.add(new Option(f.name, f.name));
  if (S.chart.video && ![...v.options].some(o => o.value === S.chart.video)) v.add(new Option(S.chart.video, S.chart.video));
  v.value = S.chart.video ?? '';
}

$('audioSel').addEventListener('change', async () => {
  if (S.suppress || !loaded()) return;
  const name = $('audioSel').value || null;
  const entry = name ? S.source.files.get(name.toLowerCase()) : findAudio(null);
  if (!entry) { fillMediaSelects(); return; }
  player.stop();
  if (!await loadAudio(entry)) { fillMediaSelects(); return; }
  changeInfo(c => { c.audio = name; });
  refreshView();
});

$('videoSel').addEventListener('change', () => {
  if (S.suppress || !loaded()) return;
  const name = $('videoSel').value || null;
  if (name !== S.chart.video) changeInfo(c => { c.video = name; });
});

// ---------------------------------------------------------------- BPM 변화

let selectedBpm = -1;
function refreshBpmChangeList() {
  const list = $('bpmList');
  list.replaceChildren();
  const sorted = [...S.chart.bpmChanges].sort((a, b) => a.beat - b.beat);
  for (const c of sorted) {
    const idx = S.chart.bpmChanges.indexOf(c);
    const div = document.createElement('div');
    div.className = 'item' + (idx === selectedBpm ? ' sel' : '');
    div.textContent = `박 ${+c.beat.toFixed(3)}  →  ♩${+c.bpm.toFixed(3)}`;
    div.addEventListener('click', () => {
      selectedBpm = idx;
      $('bpmChangeBeat').value = String(+c.beat.toFixed(3));
      $('bpmChangeValue').value = String(+c.bpm.toFixed(3));
      if (timeline.tempo) seekTo(timeline.tempo.beatToSeconds(c.beat));
      refreshBpmChangeList();
    });
    list.appendChild(div);
  }
}

$('addBpmBtn').addEventListener('click', () => {
  const tempo = timeline.tempo;
  if (!tempo || !loaded()) return;
  const beat = timeline.snap(tempo.secondsToBeat(timeline.currentTime));
  if (beat <= 0) { status('BPM 변화는 0박 이후에만 넣을 수 있습니다'); return; }
  if (S.chart.bpmChanges.some(c => Math.abs(c.beat - beat) < 1e-6)) { status('이미 그 박에 BPM 변화가 있습니다'); return; }
  const v = num($('bpmChangeValue').value);
  const bpm = v > 0 ? v : 60 / tempo.secondsPerBeatAt(beat);
  changeInfo(c => { c.bpmChanges.push({ beat, bpm }); selectedBpm = c.bpmChanges.length - 1; });
});

$('applyBpmBtn').addEventListener('click', () => {
  if (selectedBpm < 0 || selectedBpm >= S.chart.bpmChanges.length) return;
  const beat = num($('bpmChangeBeat').value), bpm = num($('bpmChangeValue').value);
  if (!(beat > 0) || !(bpm > 0)) { status('박과 BPM 은 0보다 큰 숫자여야 합니다'); return; }
  changeInfo(c => { c.bpmChanges[selectedBpm].beat = beat; c.bpmChanges[selectedBpm].bpm = bpm; });
});

$('deleteBpmBtn').addEventListener('click', () => {
  if (selectedBpm < 0 || selectedBpm >= S.chart.bpmChanges.length) return;
  const idx = selectedBpm;
  selectedBpm = -1;
  changeInfo(c => { c.bpmChanges.splice(idx, 1); });
});

// ===========================================================================
// 편집 기록 — 되돌리기 / 다시 실행 (곡 정보 + 가사 전체를 문자열로 저장)
// ===========================================================================

const snapshot = () => JSON.stringify({ meta: S.chart, lines: S.lines });

function restoreSnapshot(s) {
  // 선택은 같은 박의 문장/하위 블럭으로 이어간다
  const lineBeat = timeline.selLine ? timeline.selLine.beat : null;
  const wordBeat = timeline.selWord ? timeline.selWord.beat : null;
  const st = JSON.parse(s);
  S.chart = st.meta;
  S.lines = st.lines;
  timeline.lines = S.lines;
  timeline.selLine = lineBeat == null ? null : S.lines.find(l => Math.abs(l.beat - lineBeat) < 1e-6) || null;
  timeline.selWord = wordBeat == null || !timeline.selLine ? null : timeline.selLine.words.find(w => Math.abs(w.beat - wordBeat) < 1e-6) || null;
  loadSongInfoFields();
  applyGrid();
  refreshLyricsPanel();
  markDirty();
}

function resetHistory() {
  S.undo = []; S.redo = []; S.infoSnap = null; S.dirty = false;
  updateUndoButtons();
}

function pushUndoState(before) {
  S.undo.push(before);
  if (S.undo.length > MAX_UNDO) S.undo.shift();
  S.redo = [];
  markDirty();
  updateUndoButtons();
}

function undo() {
  commitInfoEdit();
  if (S.undo.length === 0) return;
  S.redo.push(snapshot());
  restoreSnapshot(S.undo.pop());
  S.textUndoPushed = false;
  status('되돌리기');
  updateUndoButtons();
}

function redo() {
  if (S.redo.length === 0) return;
  S.undo.push(snapshot());
  restoreSnapshot(S.redo.pop());
  S.textUndoPushed = false;
  status('다시 실행');
  updateUndoButtons();
}

function updateUndoButtons() {
  $('undoBtn').disabled = S.undo.length === 0;
  $('redoBtn').disabled = S.redo.length === 0;
}
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);

function markDirty() {
  updateUndoButtons();
  if (S.dirty) return;
  S.dirty = true;
  updateTitle();
}

function updateTitle() {
  const name = S.source ? S.source.name : '곡 없음';
  document.title = `${S.dirty ? '* ' : ''}${name} - Rhygay 가사 편집기`;
}

window.addEventListener('beforeunload', e => {
  commitInfoEdit();
  if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
});

/** 저장 안 된 변경이 있으면 물어본다. 계속 진행해도 되면 true. */
function confirmDiscard() {
  commitInfoEdit();
  return !S.dirty || confirm('저장하지 않은 변경사항이 있습니다.\n저장하지 않고 다른 곡을 열까요?');
}

// ===========================================================================
// 곡 열기 — 폴더 직접 열기(PC Chrome/Edge) / 폴더·파일 고르기 / 끌어다 놓기 / ?src= 주소
// ===========================================================================

const isAudio = name => AUDIO_EXT.some(e => name.toLowerCase().endsWith(e));

/** 폴더 안 음원 찾기: lyrics.json 의 "audio" → .flac → .wav → .mp3 */
function findAudio(jsonAudio, source = S.source) {
  if (!source) return null;
  if (jsonAudio) {
    const e = source.files.get(jsonAudio.toLowerCase());
    if (e) return e;
  }
  const files = [...source.files.values()];
  for (const ext of AUDIO_EXT) {
    const m = files.filter(f => f.name.toLowerCase().endsWith(ext)).sort((a, b) => a.name.localeCompare(b.name))[0];
    if (m) return m;
  }
  return null;
}

async function getFile(entry) {
  if (entry.file) return entry.file;
  if (entry.handle) return entry.handle.getFile();
  const r = await fetch(entry.url);
  if (!r.ok) throw new Error(`${entry.name}: ${r.status}`);
  return new File([await r.blob()], entry.name);
}

const makeSource = (name, list, dir = null) => {
  const files = new Map();
  for (const f of list) files.set(f.name.toLowerCase(), f);
  return { name, files, dir };
};

/** 음원만 (다시) 불러오고 파형을 만든다. 실패하면 false. */
async function loadAudio(entry) {
  status(`음원 여는 중… ${entry.name}`);
  try {
    const file = await getFile(entry);
    await player.load(await file.arrayBuffer());
  } catch (e) {
    alert(`음원을 열 수 없습니다.\n${entry.name}\n\n${e.message || e}`);
    status('');
    return false;
  }
  S.audioName = entry.name;
  timeline.duration = player.duration;
  timeline.wave = new WaveformData(player.buffer);
  status('');
  return true;
}

/** 곡 폴더(파일 목록)를 연다: lyrics.json 을 읽고, 음원을 찾아 디코딩한다. */
async function loadSource(source) {
  if (!confirmDiscard()) return;
  if (player.playing) togglePlay();

  let chart = emptyChart(), hadJson = false;
  const all = [...source.files.values()];
  const jsonEntry = source.files.get('lyrics.json') || all.find(f => /\.json$/i.test(f.name));
  if (jsonEntry) {
    try { chart = parseChart(await (await getFile(jsonEntry)).text()); hadJson = true; }
    catch (e) { alert(`${jsonEntry.name} 을 읽지 못했습니다.\n\n${e.message || e}`); return; }
  }
  const audio = findAudio(chart.audio, source);
  if (!audio) { alert(`음원(mp3 / wav)을 찾지 못했습니다.\n${source.name}`); return; }
  if (!source.name) source.name = chart.title || audio.name.replace(/\.[^.]+$/, '');

  const prev = S.source;
  S.source = source;   // findAudio(null) 이 새 폴더를 보도록
  if (!await loadAudio(audio)) { S.source = prev; return; }

  if (!chart.title) chart.title = source.name;
  S.chart = chart;
  S.lines = fromChart(chart);
  for (const l of S.lines) updateReading(l);   // 읽기가 없는 문장은 자동으로 채운다 (사전 준비 전이면 준비되면)
  S.chart.lyrics = [];                         // 가사의 원본은 이제 S.lines
  timeline.lines = S.lines;
  timeline.selLine = null;
  timeline.selWord = null;
  resetHistory();

  document.querySelectorAll('#panel input, #panel select, #panel textarea, #panel button:not(.tabs button)').forEach(el => { el.disabled = false; });
  $('emptyHint').style.display = 'none';
  loadSongInfoFields();
  applyGrid();
  refreshLyricsPanel();
  timeline.currentTime = 0;   // 새 곡은 처음에서 시작
  refreshView();
  updateTitle();
  status(hadJson ? `${jsonEntry.name} 을 불러왔습니다` : '새 가사 (저장하면 lyrics.json 이 만들어집니다)');
}

async function openDirectoryHandle(dir) {
  const list = [];
  for await (const [name, h] of dir.entries()) if (h.kind === 'file') list.push({ name, handle: h });
  await loadSource(makeSource(dir.name, list, dir));
}

async function openDialog() {
  if (window.showDirectoryPicker) {
    try { await openDirectoryHandle(await window.showDirectoryPicker({ id: 'rkle-song', mode: 'readwrite' })); }
    catch (e) { if (e.name !== 'AbortError') alert(`폴더를 열지 못했습니다.\n\n${e.message || e}`); }
    return;
  }
  $('openDialog').showModal();
}
$('openBtn').addEventListener('click', openDialog);
$('pickDirBtn').addEventListener('click', () => { $('openDialog').close(); $('dirInput').value = ''; $('dirInput').click(); });
$('pickFilesBtn').addEventListener('click', () => { $('openDialog').close(); $('filesInput').value = ''; $('filesInput').click(); });

// 폴더 고르기: 곡 폴더 바로 안의 파일만 쓴다
$('dirInput').addEventListener('change', () => {
  const files = [...$('dirInput').files];
  if (files.length === 0) return;
  const top = (files[0].webkitRelativePath || '').split('/')[0] || '';
  const direct = files.filter(f => (f.webkitRelativePath || f.name).split('/').length <= 2);
  loadSource(makeSource(top, direct.map(f => ({ name: f.name, file: f }))));
});
$('filesInput').addEventListener('change', () => {
  const files = [...$('filesInput').files];
  if (files.length) loadSource(makeSource('', files.map(f => ({ name: f.name, file: f }))));
});

// 끌어다 놓기: 폴더(가능하면 쓰기 권한까지) / 파일들
window.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('drop', async e => {
  e.preventDefault();
  const items = [...(e.dataTransfer.items || [])].filter(i => i.kind === 'file');
  if (items.length === 1 && items[0].getAsFileSystemHandle) {
    const h = await items[0].getAsFileSystemHandle();
    if (h && h.kind === 'directory') { await openDirectoryHandle(h); return; }
  }
  if (items.length === 1 && items[0].webkitGetAsEntry) {
    const entry = items[0].webkitGetAsEntry();
    if (entry && entry.isDirectory) {
      const list = await readEntries(entry);
      await loadSource(makeSource(entry.name, list));
      return;
    }
  }
  const files = [...e.dataTransfer.files];
  if (files.length) await loadSource(makeSource('', files.map(f => ({ name: f.name, file: f }))));
});

function readEntries(dirEntry) {
  return new Promise(resolve => {
    const reader = dirEntry.createReader(), out = [];
    const next = () => reader.readEntries(async entries => {
      if (entries.length === 0) { resolve(out); return; }
      for (const en of entries) if (en.isFile) out.push({ name: en.name, file: await new Promise(r => en.file(r)) });
      next();
    }, () => resolve(out));
    next();
  });
}

/** 주소로 열기 (?src=곡폴더주소/) — 같은 사이트에 올려 둔 곡을 바로 열 때 */
async function openFromUrl(base) {
  if (!base.endsWith('/')) base += '/';
  try {
    const r = await fetch(base + 'lyrics.json');
    if (!r.ok) throw new Error(`lyrics.json: ${r.status}`);
    const chart = parseChart(await r.text());
    const list = [{ name: 'lyrics.json', url: base + 'lyrics.json' }];
    if (chart.audio) list.push({ name: chart.audio, url: base + encodeURIComponent(chart.audio) });
    const name = decodeURIComponent(base.replace(/\/$/, '').split('/').pop() || '');
    await loadSource(makeSource(name, list));
  } catch (e) {
    alert(`주소에서 곡을 열지 못했습니다.\n${base}\n\n${e.message || e}`);
  }
}

// ===========================================================================
// 저장 — 폴더를 직접 열었으면 그 폴더의 lyrics.json (기존 파일은 .bak), 아니면 내려받기
// ===========================================================================

async function writeText(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
  return fh;
}

async function canWrite(dir) {
  if (!dir || !dir.queryPermission) return false;
  if (await dir.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
  return await dir.requestPermission({ mode: 'readwrite' }) === 'granted';
}

async function save() {
  if (!loaded()) return false;
  commitInfoEdit();
  updateReadings();   // 저장 전에 모든 문장의 일본어 읽기를 최신으로
  S.chart.lyrics = toLyrics(S.lines, hasJapanese);
  let text;
  try { text = chartToJson(S.chart); } finally { S.chart.lyrics = []; }

  const dir = S.source.dir;
  try {
    if (dir && await canWrite(dir)) {
      const old = S.source.files.get('lyrics.json');
      if (old && old.handle) await writeText(dir, 'lyrics.json.bak', await (await old.handle.getFile()).text());
      const fh = await writeText(dir, 'lyrics.json', text);
      S.source.files.set('lyrics.json', { name: 'lyrics.json', handle: fh });
      status(`저장됨 ${new Date().toLocaleTimeString()}`);
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = 'lyrics.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      status('lyrics.json 을 내려받았습니다 — 곡 폴더의 파일을 바꿔 넣으세요');
    }
  } catch (e) {
    alert(`저장하지 못했습니다.\n\n${e.message || e}`);
    return false;
  }
  S.dirty = false;
  updateTitle();
  return true;
}
$('saveBtn').addEventListener('click', save);

// ===========================================================================
// 탭 / 도움말
// ===========================================================================

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-body').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
}
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
// 버튼을 누른 뒤 포커스가 남아 있으면 Space 가 그 버튼을 또 누르므로 바로 놓아 준다
document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('button'); if (b && !b.closest('dialog')) b.blur(); });
$('helpBtn').addEventListener('click', () => $('helpDialog').showModal());
if (!window.showDirectoryPicker) $('saveNote').style.display = '';
else $('saveNote').style.display = 'none';

// ===========================================================================
// 키보드 (PC)
// ===========================================================================

window.addEventListener('keydown', e => {
  const ctrl = e.ctrlKey || e.metaKey, shift = e.shiftKey;
  const k = e.key;
  if (ctrl && (k === 's' || k === 'S')) { e.preventDefault(); save(); return; }
  if (ctrl && (k === 'o' || k === 'O')) { e.preventDefault(); openDialog(); return; }
  if (document.querySelector('dialog[open]')) return;

  // 입력칸에 포커스가 있으면 단축키 대신 글자 입력
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' && el.type === 'text' || el.tagName === 'TEXTAREA')) {
    if (e.isComposing) return;   // 한글/일본어 입력 중
    if (el === $('wordText') && (k === 'Enter' || k === 'Tab')) {
      e.preventDefault();
      selectWordRelative(shift ? -1 : +1, true);   // 하위 블럭 가사: Enter = 다음 조각
      $('wordText').focus();
      $('wordText').select();
    } else if (k === 'Enter' || k === 'Escape') {
      e.preventDefault();
      el.blur();   // 입력이 확정됨
    }
    return;
  }
  if (el && el.tagName === 'SELECT') return;

  if (ctrl && (k === 'z' || k === 'Z')) { e.preventDefault(); if (shift) redo(); else undo(); return; }
  if (ctrl && (k === 'y' || k === 'Y')) { e.preventDefault(); redo(); return; }
  if (ctrl || e.altKey) return;

  const t = timeline.currentTime;
  switch (k) {
    case ' ': togglePlay(); break;
    case 'Home': seekTo(0); break;
    case 'End': seekTo(player.duration); break;
    // 시간이 위로 흐르므로 ↑ = 앞으로 (Shift: 한 마디)
    case 'ArrowUp': seekTo(timeline.stepTime(t, true, shift)); break;
    case 'ArrowDown': seekTo(timeline.stepTime(t, false, shift)); break;
    case 'PageUp': seekTo(timeline.stepTime(t, true, true)); break;
    case 'PageDown': seekTo(timeline.stepTime(t, false, true)); break;
    case 'Delete': case 'Backspace': deleteSelection(); break;
    case 'Enter': requestTextEdit(); break;
    case 's': case 'S': toggleSub(); break;
    case 'Tab': selectWordRelative(shift ? -1 : +1, true); break;
    default:
      if (/^[1-8]$/.test(k)) { setSnapIndex(+k - 1); break; }
      return;
  }
  e.preventDefault();
});

// ===========================================================================
// 시작
// ===========================================================================

document.querySelectorAll('#panel input, #panel select, #panel textarea, #panel button:not(.tabs button)').forEach(el => { el.disabled = true; });
updateUndoButtons();
updateTitle();
refreshView();

// 일본어 사전 (처음 한 번 수 MB 를 내려받는다). 준비되면 읽기가 없는 문장을 채운다.
function startReading() {
  status('일본어 사전 불러오는 중…');
  initReading(DIC_PATH).then(() => {
    if (updateReadings()) { timeline.invalidate(); }
    if (timeline.selLine) showReading(timeline.selLine);
    status('일본어 사전 준비됨');
    setTimeout(() => { if ($('statusText').textContent === '일본어 사전 준비됨') status(''); }, 2500);
  }).catch(e => {
    console.error(e);
    status('일본어 사전을 불러오지 못했습니다 — 읽기 자동 생성은 쓸 수 없습니다');
  });
}
if (window.kuromoji) startReading();
else window.addEventListener('load', () => window.kuromoji ? startReading() : status('일본어 분석기를 불러오지 못했습니다 (인터넷 연결 확인)'));

// 개발자 도구에서 상태를 들여다볼 때 쓰는 손잡이
window.__rkle = { S, timeline, player, save, undo, redo };

const src = new URLSearchParams(location.search).get('src');
if (src) openFromUrl(src);
