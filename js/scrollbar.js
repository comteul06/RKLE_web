// 타임라인 전용 세로 스크롤바. 타임라인 탐색(흰 선 옮기기)은 이것으로만 한다.
//   - 위쪽 = 곡 끝, 아래쪽 = 곡 처음 (타임라인처럼 시간이 위로 흐른다)
//   - 손잡이 끌기 : 흰 선 이동      / 빈 홈 탭 : 그 위치로 바로 이동 (그대로 끌 수도 있음)
//   - ▲ / ▼     : 스냅 한 칸 앞/뒤 (누르고 있으면 반복, 오래 누를수록 한 마디 → 네 마디씩)
//   - 손잡이 길이 = 화면에 보이는 시간 / 곡 길이

export class VScroll {
  /**
   * @param host { getTime(), getDuration(), getVisible(), scrollTo(t, final), stepBy(dir) }
   */
  constructor(root, host) {
    this.host = host;
    this.track = root.querySelector('.vs-track');
    this.thumb = root.querySelector('.vs-thumb');
    this.up = root.querySelector('.vs-up');
    this.down = root.querySelector('.vs-down');
    this.drag = null;

    this.track.addEventListener('pointerdown', e => this.onDown(e));
    this.track.addEventListener('pointermove', e => this.onMove(e));
    this.track.addEventListener('pointerup', e => this.onUp(e));
    this.track.addEventListener('pointercancel', e => this.onUp(e));
    this.track.addEventListener('wheel', e => e.preventDefault(), { passive: false });

    this.repeat(this.up, +1);
    this.repeat(this.down, -1);
  }

  /** 버튼을 누르고 있으면 계속 이동하고, 오래 누를수록 빨라진다 (스냅 한 칸 → 1초 뒤 한 마디 → 2.5초 뒤 네 마디) */
  repeat(btn, dir) {
    let timer = null;
    const stop = () => { clearTimeout(timer); clearInterval(timer); timer = null; };
    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      this.host.stepBy(dir, 0);
      stop();
      const t0 = performance.now();
      timer = setTimeout(() => {
        timer = setInterval(() => {
          const held = performance.now() - t0;
          this.host.stepBy(dir, held > 2500 ? 2 : held > 1000 ? 1 : 0);
        }, 70);
      }, 380);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => btn.addEventListener(ev, stop));
    btn.addEventListener('contextmenu', e => e.preventDefault());
  }

  geometry() {
    const trackH = this.track.clientHeight;
    const dur = Math.max(this.host.getDuration(), 0.001);
    const frac = Math.min(1, this.host.getVisible() / (dur + this.host.getVisible()));
    const thumbH = Math.max(36, Math.round(trackH * frac));
    return { trackH, thumbH, room: Math.max(1, trackH - thumbH), dur };
  }

  update() {
    const { thumbH, room, dur } = this.geometry();
    const t = Math.min(Math.max(this.host.getTime(), 0), dur);
    const top = (1 - t / dur) * room;
    this.thumb.style.height = thumbH + 'px';
    this.thumb.style.transform = `translateY(${top}px)`;
  }

  timeAt(clientY, grabOffset) {
    const { thumbH, room, dur } = this.geometry();
    const r = this.track.getBoundingClientRect();
    const top = clientY - r.top - grabOffset;
    const f = Math.min(Math.max(top / room, 0), 1);
    return (1 - f) * dur;
  }

  onDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    const tr = this.thumb.getBoundingClientRect();
    let grab;
    if (e.clientY >= tr.top && e.clientY <= tr.bottom) grab = e.clientY - tr.top;   // 손잡이를 잡음
    else {
      grab = tr.height / 2;                                                           // 빈 홈: 손잡이 가운데를 그 자리로
      this.host.scrollTo(this.timeAt(e.clientY, grab), false);
    }
    this.drag = { grab, id: e.pointerId };
    this.thumb.classList.add('active');
    try { this.track.setPointerCapture(e.pointerId); } catch { /* 합성 이벤트 등 */ }
  }

  onMove(e) {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.host.scrollTo(this.timeAt(e.clientY, this.drag.grab), false);
  }

  onUp(e) {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.host.scrollTo(this.timeAt(e.clientY, this.drag.grab), true);
    this.drag = null;
    this.thumb.classList.remove('active');
    try { this.track.releasePointerCapture(e.pointerId); } catch { /* 이미 해제 */ }
  }
}
