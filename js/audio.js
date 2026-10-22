// 음원 재생기 (Web Audio). 곡을 열 때 전체를 메모리(AudioBuffer)로 디코딩해 두고 재생한다.
// 위치 이동은 시작 위치를 바꿔 새로 재생하는 것이라 mp3(VBR 포함)·wav 모두 정확하다.
//
// [재생 위치 관리] 원칙 (데스크톱 편집기와 같다)
//  - 재생기는 "정지 중의 위치"를 기억하지 않는다. 정지 중 위치의 기준은 화면의 흰 선(timeline.currentTime).
//  - 재생은 항상 play(from) 으로 시작 위치를 넘겨받는다.
//  - 재생 중일 때만 position 으로 "지금 스피커에서 들리는" 위치를 알려준다 (출력 지연 보정).

export class AudioPlayer {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.buffer = null;
    this.src = null;
    this.playing = false;
    this.startCtx = 0;       // 이번 재생을 시작한 AudioContext 시각
    this.startOffset = 0;    // 이번 재생을 시작한 곡 위치(초)
    this.duration = 0;
    this.volume = 0.8;
    this.onEnded = null;     // 곡 끝까지 재생되어 멈췄을 때
  }

  ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  /** 음원 파일(ArrayBuffer)을 통째로 디코딩한다 */
  async load(arrayBuffer) {
    this.stop();
    const ctx = this.ensureContext();
    this.buffer = await new Promise((resolve, reject) => {
      // 오래된 Safari 는 Promise 를 돌려주지 않아서 콜백도 같이 넘긴다
      const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
    this.duration = this.buffer.duration;
    this.startOffset = 0;
  }

  get loaded() { return this.buffer != null; }

  /** from(초) 위치부터 재생. 재생 중에 다시 부르면 그 위치로 옮겨서 이어서 재생한다. */
  play(from) {
    if (!this.buffer) return;
    this.stop();
    const ctx = this.ensureContext();
    if (ctx.state !== 'running') ctx.resume();   // 모바일: 사용자 조작 안에서 깨워야 소리가 난다

    from = Math.max(0, Math.min(from, Math.max(0, this.duration - 0.05)));
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    src.onended = () => {
      if (this.src !== src) return;   // stop() 이나 다른 위치로 옮겨서 끝난 것은 무시
      this.src = null;
      this.playing = false;
      this.startOffset = this.duration;
      this.onEnded && this.onEnded();
    };
    this.startCtx = ctx.currentTime;
    src.start(this.startCtx, from);
    this.src = src;
    this.startOffset = from;
    this.playing = true;
  }

  stop() {
    if (this.src) {
      const s = this.src;
      this.src = null;
      s.onended = null;
      try { s.stop(); } catch { /* 이미 멈춤 */ }
      s.disconnect();
    }
    this.playing = false;
  }

  /** 재생 중: 지금 스피커에서 들리는 곡 위치(초). 정지 중에는 의미 없는 값(마지막 시작 위치). */
  get position() {
    if (!this.playing || !this.ctx) return this.startOffset;
    const ctx = this.ctx;
    let heard = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
    if (ctx.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts.contextTime > 0 && ts.performanceTime > 0)
        heard = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    }
    const pos = this.startOffset + (heard - this.startCtx);
    return Math.max(this.startOffset, Math.min(this.duration, pos));
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.gain) this.gain.gain.value = this.volume;
  }
}

/** 파형 표시용 피크 데이터: 모노로 합친 뒤 2ms 마다 최소/최대 (가장 큰 피크 = 1) */
export class WaveformData {
  static BUCKETS_PER_SECOND = 500;

  constructor(buffer) {
    const sr = buffer.sampleRate, ch = buffer.numberOfChannels, len = buffer.length;
    const per = sr / WaveformData.BUCKETS_PER_SECOND;
    const n = Math.ceil(len / per);
    const min = new Float32Array(n), max = new Float32Array(n);
    const data = [];
    for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
    let peak = 0.0001;
    for (let b = 0; b < n; b++) {
      const i0 = Math.floor(b * per), i1 = Math.min(len, Math.floor((b + 1) * per));
      let mn = 0, mx = 0;
      for (let i = i0; i < i1; i++) {
        let s = 0;
        for (let c = 0; c < ch; c++) s += data[c][i];
        s /= ch;
        if (s < mn) mn = s;
        if (s > mx) mx = s;
      }
      min[b] = mn; max[b] = mx;
      if (-mn > peak) peak = -mn;
      if (mx > peak) peak = mx;
    }
    for (let b = 0; b < n; b++) { min[b] /= peak; max[b] /= peak; }
    this.min = min;
    this.max = max;
    this.duration = buffer.duration;
  }

  /** [t0, t1] 구간의 최대 진폭 (0..1) */
  amp(t0, t1) {
    const B = WaveformData.BUCKETS_PER_SECOND;
    let i0 = Math.floor(t0 * B), i1 = Math.floor(t1 * B);
    if (i1 < 0 || i0 >= this.min.length) return 0;
    i0 = Math.max(i0, 0);
    i1 = Math.min(Math.max(i1, i0), this.min.length - 1);
    let a = 0;
    for (let i = i0; i <= i1; i++) {
      if (-this.min[i] > a) a = -this.min[i];
      if (this.max[i] > a) a = this.max[i];
    }
    return a;
  }
}
