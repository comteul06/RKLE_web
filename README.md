# Rhygay 가사 편집기 (웹판)

Rhygay Karaoke 용 `lyrics.json` 을 만드는 가사 편집기의 웹 버전입니다.
데스크톱 편집기(RhygayKaraokeLyricsEditor)의 기능을 모두 옮겼고, PC 와 휴대폰·태블릿(가로 화면)에서 같이 쓸 수 있습니다.
빌드 과정 없이 이 폴더의 파일을 그대로 GitHub Pages 에 올리면 됩니다.

## 기능

- 세로 타임라인: 마디/박/스냅 그리드, 파형, 문장 캡슐과 하위 블럭, 가사 텍스트, 흰 선(재생 위치)
- 문장·하위 블럭 만들기 / 길이 조절 / 이동 / 나누기 / 삭제, 균등 나누기, 하위 블럭에 채우기
- 기본 가사(파랑) / 서브 가사(노랑)
- 일본어 읽기 자동 생성: 한자 위 히라가나, 일본어 단어 아래 한글 독음 (직접 고치기 가능)
- 곡 정보: 제목, 아티스트, BPM, 마디당 박 수, 오프셋(현재 위치로), 음원, BGA, BGA 오프셋, BPM 변화
- 되돌리기 / 다시 실행, 저장(데스크톱 편집기와 같은 형식, 기존 파일은 `.bak` 으로 백업)

## 화면 조작

| 하는 일 | PC | 휴대폰 / 태블릿 |
|---|---|---|
| 타임라인 이동 | 오른쪽 스크롤바 끌기 · 홈 클릭 · ▲▼ (↑↓ 키도 가능) | 오른쪽 스크롤바 끌기 · 홈 탭 · ▲▼ (누르고 있으면 점점 빨라짐) |
| 확대 / 축소 | 툴바 − / ＋ | 툴바 − / ＋ |
| 새 문장 | 레인 빈 곳 클릭(4박) / 끌기 | 레인 빈 곳 탭 / 끌기 |
| 새 하위 블럭 | 캡슐 안 빈 곳 클릭 / 끌기 | 캡슐 안 빈 곳 탭 / 끌기 |
| 길이 / 이동 | 끝 끌기 / 테두리 끌기 | 끝 끌기 / 테두리 끌기 |
| 가사 입력 | 더블클릭 → 오른쪽 입력칸 | 더블탭 → 오른쪽 입력칸 |
| 나누기 | Ctrl+클릭 · [흰 선에서 나누기] | [흰 선에서 나누기] |
| 삭제 | 우클릭 · Delete · 삭제 버튼 | 삭제 버튼 |

마우스 휠이나 손가락으로 타임라인을 끌어도 화면은 움직이지 않습니다 (편집 조작과 헷갈리지 않도록 이동은 스크롤바로만).
PC 단축키: Space 재생 · ↑↓ 한 칸(Shift 한 마디) · PgUp/PgDn · Home/End · 1~8 스냅 · S 서브 가사 · Tab 다음 조각 · Enter 가사 입력 · Ctrl+S/O/Z/Y

## 곡 열기 / 저장 — 브라우저마다 다릅니다

| 브라우저 | 열기 | 저장 |
|---|---|---|
| PC Chrome · Edge | [📂 열기] → 곡 폴더 선택 (또는 폴더를 창에 끌어다 놓기) | 그 폴더의 `lyrics.json` 에 바로 저장 (기존 파일은 `lyrics.json.bak`) |
| 그 밖 (Firefox, Safari, 휴대폰 등) | [📂 열기] → 폴더 고르기 / 파일 고르기 (`lyrics.json` + 음원 여러 개 선택) | `lyrics.json` 이 **내려받기**로 저장됨 → 곡 폴더의 파일을 바꿔 넣기 |

- 음원은 mp3 / wav 를 씁니다 (flac 은 브라우저에 따라 열리지 않을 수 있습니다). 곡을 열 때 전체를 메모리로 디코딩해서, 위치를 옮겨도 소리와 흰 선이 정확히 맞습니다.
- 일본어 읽기 자동 생성은 처음 한 번 일본어 사전(kuromoji.js, 약 12MB)을 인터넷에서 내려받습니다. 그 뒤로는 브라우저 캐시를 씁니다.
- 같은 사이트에 올려 둔 곡은 주소로 바로 열 수 있습니다: `.../index.html?src=songs/곡폴더/` (그 폴더에 `lyrics.json` 과 `"audio"` 에 적힌 음원이 있어야 합니다. 이렇게 연 곡은 저장하면 내려받기가 됩니다).

## GitHub Pages 에 올리기

처음 한 번만 하면 되고, 그 뒤로는 파일을 고쳐서 올리면(push) 1~2분 뒤 사이트에 반영됩니다.

### 1. GitHub 저장소 만들기

1. <https://github.com> 에 로그인 → 오른쪽 위 **＋ → New repository**
2. Repository name: 예) `RKLE_web` · **Public** 선택 (무료 계정은 공개 저장소만 Pages 를 쓸 수 있습니다) → **Create repository**

### 2. 파일 올리기 — 둘 중 편한 방법

**(가) 웹에서 끌어다 놓기 (가장 쉬움)**

1. 새 저장소 화면의 **uploading an existing file** 링크를 누릅니다.
2. 이 폴더(`RKLE_web`) 안의 `index.html`, `README.md`, `.nojekyll`, `.gitignore` 파일과 `css`, `js` 폴더를 통째로 끌어다 놓습니다.
   (`_test` 폴더가 있으면 올리지 마세요. 시험용입니다)
3. 아래 **Commit changes** 를 누릅니다.

> `.nojekyll` 처럼 점으로 시작하는 파일이 탐색기에서 안 보이면 **보기 → 숨긴 항목**을 켜세요. 이 파일이 없어도 동작은 하지만, 있으면 GitHub 가 파일을 다른 방식으로 가공하지 않아 반영이 빠릅니다.

**(나) git 명령으로 올리기**

```bash
cd "C:/User Files/Programming/RKLE_web"
git init
git add .
git commit -m "웹 가사 편집기"
git branch -M main
git remote add origin https://github.com/<내아이디>/RKLE_web.git
git push -u origin main
```

### 3. Pages 켜기

1. 저장소 화면 위쪽 **Settings → (왼쪽 메뉴) Pages**
2. **Build and deployment → Source: Deploy from a branch**
3. **Branch: `main` / `/ (root)`** → **Save**
4. 1~2분 기다린 뒤 같은 화면 위쪽에 나오는 주소로 들어갑니다:
   `https://<내아이디>.github.io/RKLE_web/`

### 4. 고친 내용 반영하기

- 웹에서: 저장소에서 파일을 열고 연필(✏️) 버튼으로 고치거나, **Add file → Upload files** 로 덮어쓴 뒤 Commit
- git 으로: `git add . && git commit -m "수정" && git push`

반영이 안 보이면 1~2분 뒤 새로고침(PC: Ctrl+F5)하세요. **Actions** 탭에서 배포 진행 상황을 볼 수 있습니다.

### 휴대폰에서 앱처럼 쓰기

사이트 주소를 연 뒤 브라우저 메뉴의 **홈 화면에 추가**를 누르면 아이콘이 생깁니다. 가로로 돌려서 쓰세요 (세로 화면에서는 돌려 달라는 안내가 나옵니다).

## 파일 구성

| 파일 | 내용 |
|---|---|
| `index.html` · `css/style.css` | 화면 배치 (PC / 휴대폰 가로) |
| `js/main.js` | 상태, 패널, 되돌리기, 열기/저장, 키보드, 재생 위치 관리 |
| `js/timeline.js` | 세로 타임라인 그리기와 마우스·터치 편집 |
| `js/scrollbar.js` | 타임라인 전용 스크롤바 |
| `js/audio.js` | 재생(Web Audio)과 파형 |
| `js/reading.js` | 일본어 읽기 (히라가나 / 한글 독음) |
| `js/model.js` | lyrics.json 형식, 박↔초 변환, 저장 형식 |
