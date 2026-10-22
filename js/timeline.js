// 세로 타임라인 (데스크톱 편집기 Controls/ChartView.cs 를 옮긴 것).
// 시간은 위쪽으로 흐르고, 흰 선(재생 위치)은 아래쪽에 고정된다.
//   y = playheadY - (t - currentTime) * pps
// 가로 배치: [눈금자(마디 번호)] [레인: 파형 + 문장 캡슐] [가사 텍스트]
//
// 탐색(흰 선 옮기기)은 오른쪽 스크롤바로만 한다. 이 캔버스에서 휠·손가락 끌기는 화면을 움직이지 않는다.
// 편집 조작 (마우스·터치 공통)
//   빈 레인 탭/드래그        : 새 문장 블럭 (탭만 하면 4박, 드래그하면 그 길이)
//   문장 끝(마름모) 드래그    : 문장 길이 조절      / 문장 테두리 드래그 : 문장 이동 (하위 블럭도 함께)
//   캡슐 안 빈 곳 탭/드래그   : 새 하위 블럭 (탭만 하면 다음 블럭/문장 끝까지 채움)
//   하위 블럭 끝 드래그       : 길이 조절            / 하위 블럭 드래그 : 이동 (문장 안에서)
//   Ctrl+하위 블럭 클릭       : 그 위치에서 둘로 나누기 (터치: 패널의 [흰 선에서 나누기])
//   더블클릭/더블탭 : 가사 입력  / 우클릭 : 삭제 (터치: 패널의 삭제 버튼)
//   눈금자 탭 : 그 위치로 흰 선 이동

import { displayText, isValidFor, sortLines, sortWords, newLine, formatTime, DEFAULT_LINE_BEATS } from './model.js';

const RULER_W = 46;
const MAIN = [0x3F, 0xA9, 0xFF];   // 기본 가사 = 파랑
const SUB = [0xFF, 0xD2, 0x3F];    // 서브 가사 = 노랑 (노래방 화면에서 칠해지는 색과 같다)
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const FONT = '"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR","Hiragino Sans","Noto Sans JP",sans-serif';
const MONO = 'Consolas,"SF Mono",Menlo,monospace';

export class Timeline {
  constructor(canvas, host) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.host = host;   // { pushUndo, onEdited, onSelectionChanged, seekTo, requestTextEdit }

    this.lines = [];
    this.selLine = null;
    this.selWord = null;
    this.wave = null;
    this.duration = 0;
    this.currentTime = 0;     // [재생 위치] 흰 선이 가리키는 시각(초)
    this.pps = 260;           // 1초당 픽셀 (확대/축소)
    this.tempo = null;
    this.bpm = 120;
    this.bpmChanges = [];
    this.beatsPerMeasure = 4;
    this.snapDivision = 4;

    this.drag = null;
    this.lastTap = { t: 0, x: 0, y: 0 };
    this.W = 0; this.H = 0;

    canvas.addEventListener('pointerdown', e => this.onDown(e));
    canvas.addEventListener('pointermove', e => this.onMove(e));
    canvas.addEventListener('pointerup', e => this.onUp(e));
    canvas.addEventListener('pointercancel', e => this.onUp(e));
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    // 휠/트랙패드로는 탐색하지 않는다 (스크롤바로만). 브라우저 확대도 막는다.
    canvas.addEventListener('wheel', e => e.preventDefault(), { passive: false });

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  // ------------------------------------------------------------------ 좌표

  get playheadY() { return this.H * 0.82; }
  get laneX0() { return RULER_W; }
  get laneW() { return Math.min(Math.max((this.W - RULER_W) * 0.55, 160), 420); }
  get laneCX() { return this.laneX0 + this.laneW / 2; }
  get capHalf() { return Math.min(Math.max(this.laneW * 0.05, 20), 40); }   // 문장 캡슐 반폭
  get innerHalf() { return this.capHalf - 7; }                               // 하위 블럭 반폭
  get textX() { return this.laneX0 + this.laneW + 14; }
  /** 화면에 보이는 시간 길이(초) */
  get visibleSeconds() { return this.H / this.pps; }

  timeToY(t) { return this.playheadY - (t - this.currentTime) * this.pps; }
  yToTime(y) { return this.currentTime + (this.playheadY - y) / this.pps; }
  beatToY(b) { return this.timeToY(this.tempo.beatToSeconds(b)); }
  yToBeat(y) { return this.tempo.secondsToBeat(this.yToTime(y)); }

  get step() { return 1 / this.snapDivision; }
  snap(beat) { return Math.round(beat * this.snapDivision) / this.snapDivision; }

  /** 시각을 가장 가까운 스냅 선으로 */
  snapTime(time) { return this.tempo ? Math.max(0, this.tempo.beatToSeconds(this.snap(this.tempo.secondsToBeat(time)))) : time; }

  /** 현재 시각에서 스냅 한 칸(또는 한 마디) 앞/뒤 시각 */
  stepTime(time, forward, measure) {
    if (!this.tempo) return time;
    const div = measure ? 1 / Math.max(1, this.beatsPerMeasure) : this.snapDivision;
    const cur = this.tempo.secondsToBeat(time) * div;
    let k = Math.round(cur);
    if (forward) k = k > cur + 1e-6 ? k : k + 1;
    else k = k < cur - 1e-6 ? k : k - 1;
    return Math.max(0, this.tempo.beatToSeconds(k / div));
  }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.W = Math.max(1, Math.floor(r.width));
    this.H = Math.max(1, Math.floor(r.height));
    this.canvas.style.width = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this.canvas.width = Math.round(this.W * dpr);
    this.canvas.height = Math.round(this.H * dpr);
    this.dpr = dpr;
    this.host.onResize && this.host.onResize();
    this.draw();
  }

  invalidate() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); });
  }

  // ------------------------------------------------------------------ 그리기

  draw() {
    const c = this.ctx, W = this.W, H = this.H;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = '#121218';
    c.fillRect(0, 0, W, H);
    if (W < 50 || H < 50) return;

    c.fillStyle = '#171720';
    c.fillRect(0, 0, RULER_W, H);
    c.fillStyle = '#15151D';
    c.fillRect(this.laneX0, 0, this.laneW, H);

    const tTop = this.yToTime(0), tBottom = this.yToTime(H);
    this.drawOutOfRange(tBottom, tTop);
    if (this.tempo) this.drawGrid(tBottom, tTop);
    if (this.wave) this.drawWaveform(tBottom, tTop);
    if (this.tempo) {
      this.drawBpmMarkers(tBottom, tTop);
      this.drawLines(tBottom, tTop);
    }
    this.drawPlayhead();
  }

  text(s, x, y, size, color, mono = false, bold = true) {
    const c = this.ctx;
    c.font = `${bold ? 'bold ' : ''}${size}px ${mono ? MONO : FONT}`;
    c.fillStyle = color;
    c.textBaseline = 'top';
    c.fillText(s, x, y);
  }
  measure(s, size, mono = false) {
    this.ctx.font = `bold ${size}px ${mono ? MONO : FONT}`;
    return this.ctx.measureText(s).width;
  }

  drawOutOfRange(tMin, tMax) {
    const c = this.ctx;
    c.fillStyle = 'rgba(0,0,0,0.44)';
    if (tMin < 0) c.fillRect(0, this.timeToY(0), this.W, this.timeToY(tMin) - this.timeToY(0));
    if (this.duration > 0 && tMax > this.duration) c.fillRect(0, this.timeToY(tMax), this.W, this.timeToY(this.duration) - this.timeToY(tMax));
  }

  /** 빨강 = 마디(번호), 초록 = 박, 회색 = 스냅 세분선. 너무 촘촘하면 생략. */
  drawGrid(tMin, tMax) {
    const c = this.ctx, tempo = this.tempo;
    const bpmM = Math.max(1, this.beatsPerMeasure);
    const b0 = tempo.secondsToBeat(Math.max(tMin, 0));
    const b1 = tempo.secondsToBeat(tMax);
    if (b1 < b0) return;
    const beatPx = this.pps * tempo.secondsPerBeatAt(b0);
    let d = this.snapDivision;
    if (beatPx / d < 6) d = 1;
    const drawBeats = beatPx >= 6;
    const kStart = Math.ceil(b0 * d - 1e-9), kEnd = Math.floor(b1 * d + 1e-9);
    if (kEnd - kStart > 20000) return;

    for (let k = kStart; k <= kEnd; k++) {
      const isBeat = k % d === 0;
      const beatIdx = isBeat ? k / d : 0;
      const isMeasure = isBeat && (((beatIdx % bpmM) + bpmM) % bpmM) === 0;
      if (!isBeat && !drawBeats) continue;
      if (isBeat && !isMeasure && !drawBeats) continue;
      const t = tempo.beatToSeconds(k / d);
      if (t < 0) continue;
      const y = Math.round(this.timeToY(t)) + 0.5;
      c.beginPath();
      if (isMeasure) {
        c.strokeStyle = '#D03A4C'; c.lineWidth = 1.6;
        c.moveTo(0, y); c.lineTo(this.W, y); c.stroke();
        const label = String(Math.floor(beatIdx / bpmM) + 1);
        this.text(label, RULER_W - this.measure(label, 14, true) - 6, y - 17, 14, '#E0E0E8', true);
      } else {
        c.strokeStyle = isBeat ? '#2E8A63' : '#383846'; c.lineWidth = 1;
        c.moveTo(this.laneX0, y); c.lineTo(this.W, y); c.stroke();
      }
    }
  }

  drawBpmMarkers(tMin, tMax) {
    const marks = [{ beat: 0, bpm: this.bpm }, ...this.bpmChanges];
    for (const m of marks) {
      const t = this.tempo.beatToSeconds(m.beat);
      if (t < tMin - 1 || t > tMax + 1) continue;
      this.text(`♩${+m.bpm.toFixed(2)}`, 3, this.timeToY(t) + 1, 10, '#FFA53C', true);
    }
  }

  /** 파형: 시간축에 고정된 구간(2ms × 2ⁿ)마다 최대 진폭을 가로 막대로. 재생 중에도 모양이 흔들리지 않는다. */
  drawWaveform(tMin, tMax) {
    const c = this.ctx;
    let bin = 1 / 500;
    while (bin * this.pps < 2) bin *= 2;
    const half = this.laneW / 2 - 6, cx = this.laneCX;
    const k0 = Math.floor(Math.max(tMin, 0) / bin), k1 = Math.ceil(tMax / bin);
    if (k1 - k0 > 20000) return;
    c.fillStyle = 'rgba(59,176,74,0.69)';
    c.beginPath();
    for (let k = k0; k <= k1; k++) {
      const t0 = k * bin, t1 = t0 + bin;
      const a = this.wave.amp(t0, t1);
      if (a < 0.004) continue;
      const yA = this.timeToY(t1), yB = this.timeToY(t0);
      c.rect(cx - a * half, yA, a * half * 2, yB - yA);
    }
    c.fill();
  }

  roundRect(x, y, w, h, r) {
    const c = this.ctx;
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  diamond(x, y, color) {
    const c = this.ctx;
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(x, y - 4); c.lineTo(x + 4, y); c.lineTo(x, y + 4); c.lineTo(x - 4, y);
    c.closePath(); c.fill();
  }

  /** 문장 캡슐 + 하위 블럭 + 가사 텍스트 */
  drawLines(tMin, tMax) {
    const c = this.ctx, tempo = this.tempo;
    const cx = this.laneCX, ch = this.capHalf, ih = this.innerHalf;

    this.lines.forEach((line, i) => {
      const t0 = tempo.beatToSeconds(line.beat), t1 = tempo.beatToSeconds(line.end);
      if (t1 < tMin - 0.5 || t0 > tMax + 0.5) return;

      const col = line.isSub ? SUB : MAIN;
      const solid = rgba(col, 1);
      const sel = line === this.selLine;
      const yStart = this.timeToY(t0), yEnd = this.timeToY(t1);   // yStart 이 아래 (시간이 위로 흐름)
      const hgt = Math.max(yStart - yEnd, 2);
      const radius = Math.min(ch, hgt / 2);

      // 1) 문장 캡슐 (속이 빈 외곽선)
      this.roundRect(cx - ch, yEnd, ch * 2, hgt, radius);
      c.fillStyle = rgba(col, 0.094); c.fill();
      c.strokeStyle = solid; c.lineWidth = 3.5; c.lineJoin = 'round'; c.stroke();
      if (sel) {
        this.roundRect(cx - ch - 4, yEnd - 4, ch * 2 + 8, hgt + 8, radius + 4);
        c.strokeStyle = '#fff'; c.lineWidth = 2; c.stroke();
      }
      if (hgt > 26) {
        this.diamond(cx, yStart - Math.min(10, radius), solid);
        this.diamond(cx, yEnd + Math.min(10, radius), solid);
      }

      // 2) 하위 블럭 (캡슐 가운데 빈 공간, 나눈 가사 길이만큼)
      for (const w of line.words) {
        const wy0 = this.beatToY(w.beat), wy1 = this.beatToY(w.end);
        let rx = cx - ih, ry = wy1 + 1, rw = ih * 2, rh = wy0 - 1 - ry;
        if (rh < 2) { ry = wy0 - 2; rh = 2; }
        this.roundRect(rx, ry, rw, rh, Math.min(5, rh / 2));
        c.fillStyle = rgba(col, 0.69); c.fill();
        if (w === this.selWord) { c.strokeStyle = '#fff'; c.lineWidth = 2; c.stroke(); }

        // 글자: 블럭 안에 들어가면 안쪽, 아니면 캡슐 오른쪽 옆에
        const label = w.text.length === 0 ? '?' : w.text.replace(/ /g, '·');
        const tw = this.measure(label, 13);
        if (17 <= rh + 2 && tw <= rw - 4)
          this.text(label, cx - tw / 2, ry + (rh - 17) / 2 + 1, 13, w.text.length === 0 ? '#808096' : '#14141C');
        else
          this.text(label, cx + ch + 6, wy0 - 16, 12, w.text.length === 0 ? '#808096' : solid);
      }

      // 3) 문장 텍스트 (오른쪽 열, 문장 시작 높이)
      const sentence = displayText(line);
      const color = sentence.length === 0 ? '#808096' : (sel ? '#fff' : solid);
      const textH = 21;
      const textTop = yStart - textH;
      const rubyH = line.ruby.length > 0 ? 13 : 0;
      this.text(`L${i + 1}`, this.textX, textTop - rubyH - 13, 11, '#808096', true, false);
      this.text(sentence.length === 0 ? '(가사 없음)' : sentence, this.textX, textTop, 16, color);

      // 4) 일본어 읽기: 한자 위에 히라가나, 일본어 단어 아래에 한글 독음
      if (sentence.length > 0 && (line.ruby.length > 0 || line.kor.length > 0)) {
        const xAt = k => k <= 0 ? 0 : this.measure(sentence.slice(0, k), 16);
        const put = (r, y, above) => {
          if (!r.text || !isValidFor(r, sentence)) return;
          const mid = this.textX + (xAt(r.at) + xAt(r.at + r.base.length)) / 2;
          const w = this.measure(r.text, 10);
          this.text(r.text, mid - w / 2, above ? y - 12 : y, 10, sel ? '#fff' : solid);
        };
        for (const r of line.ruby) put(r, textTop + 2, true);
        for (const k of line.kor) put(k, textTop + textH - 2, false);
      }
    });
  }

  drawPlayhead() {
    const c = this.ctx, y = this.playheadY;
    c.strokeStyle = '#fff'; c.lineWidth = 3;
    c.beginPath(); c.moveTo(0, y); c.lineTo(this.W, y); c.stroke();
    let info = formatTime(this.currentTime);
    if (this.tempo) info += `  ♩${this.tempo.secondsToBeat(this.currentTime).toFixed(2)}`;
    this.text(info, this.textX, y + 5, 12, '#fff', true);
  }

  // ------------------------------------------------------------------ 찾기

  hitTest(x, y, grab) {
    if (!this.tempo) return { part: 'none' };
    if (x < this.laneX0) return { part: 'ruler' };

    // 오른쪽 가사 텍스트 열: 그 높이의 문장 선택
    if (x >= this.laneX0 + this.laneW) {
      const near = this.lines.find(l => y <= this.beatToY(l.beat) + 4 && y >= this.beatToY(l.end) - 4);
      return { part: 'text', line: near };
    }

    const dx = Math.abs(x - this.laneCX);
    for (const line of this.lines) {
      const yS = this.beatToY(line.beat), yE = this.beatToY(line.end);
      if (dx > this.capHalf + grab || y > yS + grab || y < yE - grab) continue;
      if (Math.abs(y - yS) <= grab) return { part: 'lineStart', line };
      if (Math.abs(y - yE) <= grab) return { part: 'lineEnd', line };
      if (dx > this.innerHalf) return { part: 'lineBody', line };
      const wg = Math.max(4, grab - 2);
      for (const word of line.words) {
        const wS = this.beatToY(word.beat), wE = this.beatToY(word.end);
        if (y > wS + 3 || y < wE - 3) continue;
        if (Math.abs(y - wS) <= wg && wS - wE > wg * 2.5) return { part: 'wordStart', line, word };
        if (Math.abs(y - wE) <= wg && wS - wE > wg * 2.5) return { part: 'wordEnd', line, word };
        return { part: 'wordBody', line, word };
      }
      return { part: 'lineInterior', line };
    }
    return { part: 'empty' };
  }

  prevLine(l) { const i = this.lines.indexOf(l); return i > 0 ? this.lines[i - 1] : null; }
  nextLine(l) { const i = this.lines.indexOf(l); return i >= 0 && i + 1 < this.lines.length ? this.lines[i + 1] : null; }
  static prevWord(l, w) { const i = l.words.indexOf(w); return i > 0 ? l.words[i - 1] : null; }
  static nextWord(l, w) { const i = l.words.indexOf(w); return i >= 0 && i + 1 < l.words.length ? l.words[i + 1] : null; }

  // ------------------------------------------------------------------ 편집

  select(line, word) {
    this.selLine = line;
    this.selWord = word;
    this.host.onSelectionChanged();
    this.invalidate();
  }

  beginChange() {
    if (!this.drag || this.drag.undoPushed) return;
    this.host.pushUndo();
    this.drag.undoPushed = true;
  }

  point(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  onDown(e) {
    const { x, y } = this.point(e);
    const touch = e.pointerType !== 'mouse';
    const grab = touch ? 12 : 6;
    if (!this.tempo) return;
    e.preventDefault();
    document.activeElement && document.activeElement.blur && document.activeElement !== document.body && document.activeElement.blur();

    // 더블클릭 / 더블탭
    const now = performance.now();
    const dbl = now - this.lastTap.t < 380 && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < (touch ? 24 : 8);
    this.lastTap = dbl ? { t: 0, x: 0, y: 0 } : { t: now, x, y };

    const hit = this.hitTest(x, y, grab);
    const { part, line, word } = hit;

    // 우클릭: 삭제 (하위 블럭 → 그 블럭, 테두리 → 문장 전체)
    if (e.button === 2) {
      if (!line) return;
      this.host.pushUndo();
      if (word) { line.words.splice(line.words.indexOf(word), 1); this.select(line, null); }
      else if (part !== 'ruler' && part !== 'empty') { this.lines.splice(this.lines.indexOf(line), 1); this.select(null, null); }
      this.host.onEdited();
      return;
    }
    if (e.button !== 0) return;

    const downBeat = this.yToBeat(y);
    this.drag = { kind: null, line, word, downY: y, downBeat, moved: false, undoPushed: false, pointerId: e.pointerId };

    switch (part) {
      case 'ruler':
        this.host.seekTo(Math.max(0, this.yToTime(y)));
        this.drag = null;
        return;

      case 'text':
        if (line) this.select(line, null);
        if (line && dbl) this.host.requestTextEdit();
        this.drag = null;
        return;

      case 'empty': {
        // 새 문장: 스냅된 위치에서 시작, 다음 문장 시작을 넘지 않게
        const start = this.snap(downBeat);
        if (this.tempo.beatToSeconds(start) < 0) { this.drag = null; return; }
        // 캡슐 옆 빈 곳이라도 시간상 기존 문장 안이면 새로 만들지 않고 그 문장을 선택
        const containing = this.lines.find(l => start >= l.beat - 1e-9 && start < l.end - 1e-9);
        if (containing) { this.select(containing, null); this.drag = null; return; }
        const next = this.lines.find(l => l.beat > start - 1e-9);
        const limit = next ? next.beat : Infinity;
        if (limit - start < this.step - 1e-9) { this.drag = null; return; }
        this.beginChange();
        const nl = newLine(start, Math.min(start + this.step, limit));
        this.lines.push(nl);
        sortLines(this.lines);
        Object.assign(this.drag, { kind: 'createLine', line: nl });
        this.select(nl, null);
        this.host.onEdited();
        break;
      }

      case 'lineStart': case 'lineEnd': case 'lineBody':
        this.select(line, null);
        if (dbl) { this.host.requestTextEdit(); this.drag = null; return; }
        Object.assign(this.drag, {
          kind: part === 'lineStart' ? 'lineStart' : part === 'lineEnd' ? 'lineEnd' : 'moveLine',
          origBeat: line.beat, origEnd: line.end,
          origWords: line.words.map(w => ({ w, beat: w.beat, end: w.end })),
        });
        break;

      case 'lineInterior': {
        // 캡슐 안 빈 곳 → 새 하위 블럭
        const l = line;
        let start = Math.min(Math.max(this.snap(downBeat), l.beat), l.end - 1e-9);
        const nextW = l.words.find(w => w.beat > start - 1e-9);
        const prevW = [...l.words].reverse().find(w => w.end <= start + 1e-9);
        start = Math.max(start, prevW ? prevW.end : l.beat);
        const limit = nextW ? nextW.beat : l.end;
        if (limit - start < 1e-6) { this.select(l, null); this.drag = null; return; }
        this.beginChange();
        const nw = { beat: start, end: Math.min(start + this.step, limit), text: '' };
        l.words.push(nw);
        sortWords(l);
        Object.assign(this.drag, { kind: 'createWord', word: nw, origEnd: limit });   // 탭만 하면 여기까지 채운다
        this.select(l, nw);
        this.host.onEdited();
        break;
      }

      case 'wordBody': case 'wordStart': case 'wordEnd':
        this.select(line, word);
        if (dbl) { this.host.requestTextEdit(); this.drag = null; return; }
        if (part === 'wordBody' && (e.ctrlKey || e.metaKey)) {
          this.drag = null;
          this.splitWord(line, word, this.snap(downBeat));
          return;
        }
        Object.assign(this.drag, {
          kind: part === 'wordStart' ? 'wordStart' : part === 'wordEnd' ? 'wordEnd' : 'moveWord',
          origBeat: word.beat, origEnd: word.end,
        });
        break;

      default:
        this.drag = null;
        return;
    }
    if (this.drag && this.drag.kind) { try { this.canvas.setPointerCapture(e.pointerId); } catch { /* 합성 이벤트 등 */ } }
    else this.drag = null;
  }

  /** 하위 블럭을 at 박에서 둘로 나눈다 (글자는 앞쪽에 남고 뒤쪽은 빈 블럭). 나눴으면 true. */
  splitWord(l, w, at) {
    if (at <= w.beat + 1e-6 || at >= w.end - 1e-6) return false;
    this.host.pushUndo();
    const nw = { beat: at, end: w.end, text: '' };
    w.end = at;
    l.words.push(nw);
    sortWords(l);
    this.select(l, nw);
    this.host.onEdited();
    return true;
  }

  onMove(e) {
    const { x, y } = this.point(e);
    const d = this.drag;
    if (!d) {
      if (e.pointerType === 'mouse' && this.tempo) {
        const { part } = this.hitTest(x, y, 6);
        this.canvas.style.cursor =
          ['lineStart', 'lineEnd', 'wordStart', 'wordEnd'].includes(part) ? 'ns-resize'
          : ['lineBody', 'wordBody'].includes(part) ? 'pointer'
          : ['empty', 'lineInterior'].includes(part) ? 'crosshair'
          : part === 'ruler' ? 'pointer' : 'default';
      }
      return;
    }
    if (e.pointerId !== d.pointerId) return;
    if (!d.moved && Math.abs(y - d.downY) < (e.pointerType === 'mouse' ? 3 : 6)) return;
    d.moved = true;

    const mb = this.snap(this.yToBeat(y));
    const delta = this.snap(this.yToBeat(y) - d.downBeat);
    const l = d.line, step = this.step;
    let changed = false;
    const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

    switch (d.kind) {
      case 'createLine': case 'lineEnd': {
        const min = Math.max(l.beat + step, l.words.length ? Math.max(...l.words.map(w => w.end)) : 0);
        const nx = this.nextLine(l);
        const max = nx ? nx.beat : Infinity;
        const v = clamp(mb, min, Math.max(min, max));
        if (v !== l.end) { this.beginChange(); l.end = v; changed = true; }
        break;
      }
      case 'lineStart': {
        const pv = this.prevLine(l);
        const min = pv ? pv.end : -Infinity;
        const max = Math.min(l.end - step, l.words.length ? Math.min(...l.words.map(w => w.beat)) : Infinity);
        const v = clamp(mb, Math.min(min, max), max);
        if (this.tempo.beatToSeconds(v) < 0) break;
        if (v !== l.beat) { this.beginChange(); l.beat = v; changed = true; }
        break;
      }
      case 'moveLine': {
        // 이웃 문장과 겹치지 않는 범위에서 이동, 하위 블럭도 같이 이동
        const len = d.origEnd - d.origBeat;
        const pv = this.prevLine(l), nx = this.nextLine(l);
        const min = pv ? pv.end : -Infinity;
        const max = (nx ? nx.beat : Infinity) - len;
        if (max < min) break;
        const nb = clamp(d.origBeat + delta, min, max);
        if (this.tempo.beatToSeconds(nb) < 0) break;
        if (nb !== l.beat) {
          this.beginChange();
          const shift = nb - d.origBeat;
          l.beat = nb; l.end = nb + len;
          for (const o of d.origWords) { o.w.beat = o.beat + shift; o.w.end = o.end + shift; }
          changed = true;
        }
        break;
      }
      case 'createWord': case 'wordEnd': {
        const w = d.word;
        const nw = Timeline.nextWord(l, w);
        const max = d.kind === 'createWord' ? d.origEnd : (nw ? nw.beat : l.end);
        const v = clamp(mb, Math.min(w.beat + step, max), max);
        if (v !== w.end) { this.beginChange(); w.end = v; changed = true; }
        break;
      }
      case 'wordStart': {
        const w = d.word;
        const pw = Timeline.prevWord(l, w);
        const min = pw ? pw.end : l.beat;
        const v = clamp(mb, min, Math.max(min, w.end - step));
        if (v !== w.beat) { this.beginChange(); w.beat = v; changed = true; }
        break;
      }
      case 'moveWord': {
        const w = d.word;
        const len = d.origEnd - d.origBeat;
        const pw = Timeline.prevWord(l, w), nw = Timeline.nextWord(l, w);
        const min = pw ? pw.end : l.beat;
        const max = (nw ? nw.beat : l.end) - len;
        if (max < min) break;
        const nb = clamp(d.origBeat + delta, min, max);
        if (nb !== w.beat) { this.beginChange(); w.beat = nb; w.end = nb + len; changed = true; }
        break;
      }
    }
    if (changed) this.host.onEdited();
  }

  onUp(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    // 탭/클릭만 했을 때 기본 길이
    if (!d.moved) {
      if (d.kind === 'createLine') {
        const nx = this.nextLine(d.line);
        d.line.end = Math.min(d.line.beat + DEFAULT_LINE_BEATS, nx ? nx.beat : Infinity);
        this.host.onEdited();
      } else if (d.kind === 'createWord') {
        d.word.end = d.origEnd;   // 다음 하위 블럭 또는 문장 끝까지 채움
        this.host.onEdited();
      }
    }
    this.drag = null;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* 이미 해제 */ }
  }
}
