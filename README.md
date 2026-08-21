# 🧯 SAFEXIT — 시각장애인 실내 대피 AI 내비게이션

> 재난 때 '가까운 출구'를 알려주는 것이 아니라, 시각장애인이 **현재 위치에서 연기·열·장애물을 피해
> 실제로 이동할 수 있는 경로**를 음성·진동으로 안내한다.

대상 건물은 **AI공학관**(지상 7층 + 옥탑). 6층 COCONE 구역이 실측·답사가 끝난 기준 층이고,
나머지 층은 도면을 올린 만큼만 켜진다.

목표는 "완전 자율 대피"가 아니라 **접근 가능한 동적 경로 + 안내 UX 검증**이다.

---

## 지금 어디까지 되는가

| | 상태 |
|---|---|
| 경로 계산 | 위험(화재·연기·열·혼잡)을 피해 접근 가능한 출구까지. 재탐색 2초 이내 |
| 벽 회피 | 도면에서 뽑은 벽을 격자로 깔고 그 위에서 길을 찾는다 (직선으로 벽을 뚫지 않는다) |
| 계단 하강 | 비상구는 도착이 아니라 반환점. 계단으로 1층까지, 밖으로 나가야 완료 |
| 실내 측위 | 비콘·기압(층)·지자기를 **판단 계층**이 하나로 합친다. 실제 BLE 스캔 지원 |
| 답사 | 폰이 한 번 걸으면 그 층의 비콘 지도·지자기 지문이 만들어진다 |
| 화재 감지 | 연기·열 감지기를 실제 설비 방식으로 (예비경보 → 축적 → 확정). 불은 번진다 |
| 관제 | 층 3D 스택, 층별 도면·벽·복도, 실시간 위치 추적, 비콘 레이어 |
| 보호자 | 공유 코드로 대상자 위치·경로·현재 안내를 실시간 확인 |
| 도면 등록 | 사진 한 장 → AI 판독 → 사람 확인 → 활성화 |
| 오프라인 | 통신이 끊겨도 캐시된 도면·위험 상태로 브라우저가 직접 계산해 안내를 잇는다 |

## 아키텍처

```
┌───────────────────────┐        ┌──────────────────────────┐       ┌───────────┐
│ frontend/ (PWA)       │  REST  │ backend/ (Node+Express)   │ Admin │ Firestore │
│  · 사용자 앱          │ ─────▶ │  · 경로 계산 (권위)       │  SDK  │  hazards  │
│  · 관제 대시보드      │        │  · 위험 검증·인증         │ ────▶ │  sos      │
│  · 보호자 화면        │ ◀───── │  · 감지기·수신기 웹훅     │       │  positions│
│  · 도면 편집기·답사   │  SSE   │  · SSE 브로드캐스트       │       │  metrics  │
└───────────────────────┘        └──────────────────────────┘       └───────────┘
        ▲                                    ▲
        │                                    │
┌───────┴───────────┐          └──── shared/ (도면·경로·측위·감지) ────┘
│ mobile/ (Expo)    │                        │
│  실제 BLE 스캔    │ ───────────────────────┘
│  답사·촬영·안내   │
└───────────────────┘
```

**프론트엔드는 Firestore에 직접 접근하지 않는다.** 모든 DB 접근은 백엔드가 서비스 계정으로 수행한다.
브라우저에 Firebase 자격증명이 노출되지 않고, 위험 상태 쓰기를 관제 인증으로만 통제할 수 있다 —
잘못된 위험 정보 주입은 곧바로 오안내 → 인명위험이기 때문이다.

`shared/`는 도면·경로탐색·측위·감지 로직의 **단일 진실 소스**다. 백엔드가 권위 있는 계산을 하지만,
통신이 끊겼을 때 프론트가 캐시된 위험 상태로 직접 계산해 안내를 이어가야 하므로
(`npm run sync`가 `frontend/shared/`로, `npm run sync:app`이 `mobile/src/`로 복사) 셋이 같은 코드를 쓴다.

## 개발 실행

```bash
npm install       # 루트 + backend 의존성 (npm workspaces)
npm run dev:all   # 백엔드(:8080) + 프론트(:5173) 동시에, 죽으면 자동 재시작
```

| 실행 방식 | 명령 | 용도 |
|---|---|---|
| **한 번에** | `npm run dev:all` | 둘 다 띄우고 계속 살려 둔다 (시연용) |
| 프론트만 | `npm run dev` | :5173, `/api`는 :8080으로 프록시 |
| 백엔드 | **VS Code F5** | :8080, 디버거 연결 |
| 백엔드 (터미널) | `npm run dev:backend` | 디버거 없이 자동 재시작 |
| 통합 1포트 | `npm start` | :8080 하나로 프론트까지 서빙 (배포 확인용) |
| 발표 문서 | `npm run docs` | :3030, `docs/` 정적 서빙 (앱과 따로 떠 있다) |
| 도면 탐지기 | `npm run detector` | :8001, 파이썬 YOLO 서버 (선택) |

- **🖥️ 통합 시연** → http://localhost:5173/demo.html ← **발표는 이 화면 하나면 됩니다**
- 사용자 앱 → http://localhost:5173/index.html
- 관제 대시보드 → http://localhost:5173/admin.html
- 보호자 화면 → http://localhost:5173/guardian.html (코드 입력)
- 도면 편집기 → http://localhost:5173/architect.html
- 걷기 답사 → http://localhost:5173/survey.html (폰으로 연다)

프론트 개발 서버가 `/api/*`를 백엔드로 프록시하므로 **같은 출처**가 되어 CORS 없이 SSE까지 흐른다.
`/shared/*`는 사본이 아니라 원본을 직접 읽으므로 지도·경로탐색을 고치면 새로고침만으로 반영된다.

백엔드를 아직 안 띄웠다면 프록시가 503을 돌려주고, 프론트는 **오프라인 폴백**으로 전환해
캐시된 도면으로 안내를 계속한다 — 이 동작 자체를 확인하는 용도로도 쓸 수 있다.

포트가 이미 쓰이고 있어도 개발 서버는 죽지 않는다. 이전 실행이 남아 있으면 그 사실을 알리고,
다른 프로그램이 점유했으면 다음 포트로 옮겨 뜬다. 직접 비우려면 `npx kill-port 5173`,
다른 포트를 쓰려면 `FRONTEND_PORT=3000 npm run dev`.

Firebase 설정이 없으면 백엔드가 **인메모리 저장소**로 뜬다. 실시간 전파(SSE)·재탐색·구조요청까지
전부 동작하므로 시연에는 충분하다. 등록한 도면만 `backend/data/plans.json`에 남는다 —
사람이 그 건물까지 가서 찍은 것이라 재시작으로 사라지면 안 되기 때문이다.

### 통합 시연 화면

사용자·관제·보호자 세 화면을 한 페이지에 나란히 띄운다. 보호자 코드는 **자동으로 연결**되므로
시연 중에 코드를 옮겨 적을 필요가 없다.

아래 **실시간 이벤트 로그**에 세 화면 사이에 오가는 신호가 그대로 찍힌다 —
화면만 봐서는 "관제 클릭 → 사용자 재탐색 → 보호자 알림"의 인과가 잘 안 보이기 때문이다.

```
14:32:07  🌡️ 온도 75°C @ 서쪽 복도 ↔ 남쪽 비상구 — 통행 불가
14:32:07  🔥 서쪽 복도 ↔ 남쪽 비상구 — 과열로 통행 불가
14:32:07  🧭 경로 재탐색 0.8ms
14:32:03  👨‍👩‍👧 보호자 알림: 대피를 시작했습니다.
14:32:03  🚶 사용자가 대피를 시작했습니다 — 601호 앞
```

패널 오른쪽 위 **⤢** 로 한 화면만 키울 수 있고, **↺ 시나리오 초기화**로 위험·판독값을 되돌린다.

## 실내 측위 — 신호 하나로는 안 된다

### 판단 계층 (`shared/fusion.js`, `tracking.js`)

비콘 하나로는 층을 모르고, 기압 하나로는 어느 방인지 모른다. 그래서 **세 앵커를 하나로 합친다.**

| 앵커 | 무엇을 아는가 | 파일 |
|---|---|---|
| 비콘 | 어느 지점 앞인가 | `beacon-anchor.js` · `positioning.js` |
| 기압 | 몇 층인가 (계단·엘리베이터 이동) | `altitude-anchor.js` · `altitude.js` |
| 지자기 | 어느 통로인가 (자기장 세기의 **순서**) | `magnetic-anchor.js` · `magnetic.js` |

판단 계층은 각 앵커의 확신도를 함께 받아 하나의 위치 추정으로 합치고, 신호가 끊긴 구간은
걸음·방위(`step-detect.js` · `north.js`)로 잇는다.

### 왜 RSSI 삼각측량이 아닌가

RSSI를 거리로 환산하면 실내 반사·인체 감쇠로 3~5m씩 틀린다. 하지만 **"어느 비콘이 제일 가까운가"**
라는 비교는 그 오차에 견딘다. 대피 안내에 필요한 해상도는 노드 단위("601호 앞")이고,
최근접 판정이 정확히 그 해상도다.

반드시 들어가는 처리 셋:

- **스무딩** — 원시 RSSI는 정지 상태에서도 ±10dBm 튄다. 3초 이동평균
- **히스테리시스** — 새 비콘이 5dB 이상 세게 2초 지속돼야 전환. 없으면 경계에서 경로가 깜빡인다
- **그래프 제약** — 엣지로 이어지지 않은 노드로의 순간이동은 무시 (다중경로 반사가 만든 허상)

배제한 대안: Wi-Fi RTT(iOS 0%, 유선 AP라 정전 시 사망), 삼각측량(3~10m 오차),
핑거프린팅(사전 측정 노동집약), UWB(앵커 고가·웹 API 없음).

### 실제 BLE 스캔

`frontend/js/ble-scan.js` + `shared/ble-decode.js`가 안드로이드 크롬에서 **진짜 전파를 받는다.**
맥 스캐너와 같은 규칙으로 광고를 이름으로 푼다.

> Web Bluetooth **Scanning** API는 안드로이드 크롬 `chrome://flags` 뒤에 있고, iOS Safari는
> Web Bluetooth 자체가 없다. 그래서 `mobile/`(Expo) 앱이 네이티브 스캔을 맡는다.

기기가 없으면 `beacon-sim.js`가 거리 기반 RSSI에 실측 수준 노이즈(±6dB)를 섞어 같은 형식으로
낸다. 측위 로직은 입력이 가짜인지 모른다 — 그래서 기기 없이 전체 파이프라인을 검증할 수 있다.

## 걷기 답사 — 폰이 자기 답사를 만든다

http://localhost:5173/survey.html 를 폰으로 열고 **한 번 걸으면** 그 층의 비콘 지도와
지자기 지문이 만들어진다. 비콘을 어디에 달았는지 사람이 타이핑할 필요가 없다.

```
POST /api/survey/walk/start   → 답사 시작
POST /api/survey/walk/sample  → 걸으며 신호·걸음·방위 적재
POST /api/survey/walk/finish  → 좌표로 다시 이어 비콘 지도 생성
```

`survey-remap.js`가 답사를 도면 좌표로 되잇고, `beacon-map.js`가 비콘 위치를 추정한다.
**답사한 폰이 안내받는 폰이어야 한다** — 그래서 모바일 앱 안에도 같은 기능이 들어 있다.

## 화재 감지 — 실제 설비가 하는 방식대로

`shared/detectors.js`

온도 숫자 하나로는 부족하다. 실제 건물 설비와 세 가지가 달랐다.

1. **연기감지기가 없었다.** 실제로 제일 많이 달리는 것이 연기감지기고, 불이 나면 **연기가 먼저 운다.**
   열만 있으면 "감지가 늦는 시스템"을 보여 주는 셈이다.
2. **한 번 넘으면 바로 화재였다.** 실제 수신기는 처음 넘으면 **예비경보**로 잡아 두고 일정 시간
   지속돼야 화재로 확정한다(축적 기능). 이게 없으면 담배 연기 한 번에 대피로가 끊긴다.
3. **간격이 실제 기준과 달랐다.** 한 층에 52대는 실제 건물이 아니다. 국내 기준 간격으로 배치한다.

불은 점이 아니라 **번진다** — `hazard-spread.js`가 시간에 따라 반경을 넓힌다.

### 온도 임계값

| 판정 | 기준 | 경로탐색 반영 |
|---|---|---|
| 정상 | < 45°C | 그대로 |
| 주의 | ≥ 45°C | 통행은 가능하되 가중치 4배 (강하게 회피) |
| 통행 불가 | ≥ 60°C | 그 통로를 아예 뺀다 |
| 판독 끊김 | 60초 무갱신 | 신뢰하지 않음 (관제 화면에 ⚠ 표시) |

지점(교차점) 센서가 과열되면 **연결된 모든 통로**를 막는다 — 교차점이 뜨거우면 어느 방향으로도
지나갈 수 없기 때문이다.

```bash
# 실제 센서 게이트웨이·BMS가 호출하는 것과 동일한 엔드포인트
curl -X POST localhost:8080/api/sensors/temperature \
  -H 'Content-Type: application/json' \
  -d '{"sensorId":"T-3F-01","edgeId":"E11","celsius":71}'
```

관제 화면의 🌡️ 온도 도구도 **같은 API**를 부른다. 시뮬레이션과 실제 연동의 경로를 나누지 않아야
실증에서 배선만 바꾸면 된다.

## 대피 경로

### 벽을 피해 간다

`wall-route.js` · `walk-grid.js` · `orthogonal.js`

도면에서 뽑은 벽(`scripts/extract-walls.py`)을 격자로 깔고 그 위에서 길을 찾는다.
두 지점을 직선으로 이으면 **시각장애인이 벽으로 걸어간다.** 통로는 실제 복도처럼
직각으로 꺾이는 선으로 그린다.

### 비상구는 도착이 아니다

`stair-descent.js`

층 비상구에 닿는 것으로 대피가 끝나지 않는다. **계단으로 1층까지 내려가 밖으로 나가야** 완료다.
경사지 건물이라 지상이 두 군데인 경우도 다룬다 — 위층에서 올라가면 옥상으로 보낸다.

### 화재 시 엘리베이터 제외

`pathfinding.js`가 화재 모드에서 엘리베이터 구간을 언제나 뺀다. 도면 검증(`findUnreachableNodes`)도
같은 기준으로 따진다 — 엘리베이터로만 닿는 방은 불이 나면 갈 곳이 없으므로 **고립으로 잡는다.**

## 건물 층 스택

`backend/src/building.js`

관제가 한 층만 보여 주면 보는 사람에게 이것은 "한 층짜리 시스템"이다. 실제 건물은 7층에 옥상까지
있고, 불은 한 층에서만 나지 않는다. 그리고 **대피는 층을 내려가는 일**이라 층이 안 보이면 대피가 안 보인다.

그렇다고 일곱 층을 다 그려 놓고 전부 "정상"이라 칠하면 안 된다. 도면을 안 올린 층은 아무것도
안 보고 있는 것인데 화면은 보고 있다고 말하게 된다. 그래서 셋으로 가른다.

| 상태 | 뜻 |
|---|---|
| 감시 중 | 도면 + 감지기. 화면이 그 층을 실제로 본다 |
| 도면만 | 도면은 있고 감지기가 없다. 경로는 그리되 감지는 못 한다 |
| 도면 없음 | 아무것도 없다. 회색으로 두고 그렇게 적는다 |

이 그림 자체가 "도면을 올리면 그 층이 켜진다"를 말해 준다.

## 도면 주입 — 건물 설계도로 대피 경로 만들기

지도는 코드에 하드코딩되어 있지 않다. **건물 도면을 넣으면 그 도면 기준으로 안내한다.**

도면 편집기 → http://localhost:5173/architect.html

| 단계 | 하는 일 |
|---|---|
| 1 | 도면 이미지(PNG/JPG) 업로드 — 브라우저에서 자동 축소·압축 (900KB 이하) |
| 2 | **이 층의 실제 가로 폭(m)** 입력 → 축척(`metersPerUnit`) 자동 계산 |
| 3 | 도면을 클릭해 지점(실·교차점·출구·엘리베이터) 찍기 |
| 4 | 두 지점을 이어 통로 만들기, 따라갈 벽(좌/우) 지정 |
| 5 | 저장 → **이 도면으로 안내 시작**(활성화) |

### 앱에서 찍으면 여기까지 자동으로 온다

`mobile/` 앱에서 피난안내도를 찍고 **가로 폭·방위**만 넣으면, 사진 저장 + AI 판독 + 초안 생성이
서버에서 한 번에 끝난다. 편집기에서는 **확인만** 하면 된다.

```
POST /api/plans/draft   { name, dataUri, width, height, widthM, northOffset? }
  → { planId, nodes, edges, exits, rooms, confidence, warnings, needsReview }
```

**관제 권한을 요구하지 않는다.** 도면을 모으는 건 누구나 하는 일이고, 여기서 막으면 데이터가 안 쌓인다.
대신 **초안은 안내에 쓰이지 않는다** — 활성화만 관제 권한이다.
"누구나 낼 수 있고, 확인은 담당자가 한다"가 안전 경계다.

초안은 편집기 목록에 **📱 앱에서 접수 · 확인 필요**로 뜨고, 그 상태로는 `activate`가 409로 거부된다.

방위(`northOffset`)는 **앱이 나침반으로 직접 잰다.** 도면이 어느 쪽을 향하는지는 그 앞에 서 있는
사람만 알 수 있어서, 사무실에서 편집기를 열면 이미 늦기 때문이다.

### AI 판독 (선택)

두 모델이 각자 잘하는 것만 한다.

| 엔진 | 하는 일 | 못 하는 일 |
|---|---|---|
| 기호 탐지기 (`ml/detector`, 직접 학습한 YOLO) | 비상구·계단·실·문이 **어디 있는지** 상자로 | 글자를 못 읽음, 통로 모름 |
| 언어모델 (Gemini · Claude) | 적힌 **이름**과 통로 **연결** | 좌표는 눈대중이라 약함 |

**좌표는 탐지기, 이름과 통로는 언어모델.** 한쪽만 있어도 돌아간다.

```bash
# backend/.env — 둘 중 하나만 있으면 된다 (Google 이 있으면 그쪽이 우선)
GOOGLE_API_KEY=...
ANTHROPIC_API_KEY=...
DETECTOR_URL=http://127.0.0.1:8001
```

**축척은 판독하지 않는다.** "1px이 몇 m인가"는 사진에 안 적혀 있다. 축척이 두 배 틀리면
"8미터 직진"이 16미터가 되고, 시각장애인은 그 걸음 수를 믿고 걷다가 모퉁이를 지나친다.
이 숫자 하나만은 사람이 직접 넣는다.

### 게이트웨이를 쓴다면 — 시야 점검이 먼저 돈다

라우터를 거치면 이미지 블록이 **조용히 버려질 수** 있다. 그러면 모델은 그림을 못 본 채로
그럴듯한 도면을 지어내고 신뢰도까지 `high`로 보고한다. 판독이 안 되는 것보다 **안 된 걸 모른 채
지어낸 경로를 저장하는 쪽이 훨씬 위험하다.**

판별법은 글자 인식이 아니라 **토큰 수 비교**다. 같은 질문을 그림을 붙여서 한 번, 안 붙이고 한 번
보내 `input_tokens`를 견준다. 그림이 전달됐다면 반드시 늘어난다. 늘지 않으면 판독을 **시작하지 않는다.**

## 보호자 위치 공유

사용자가 대피 전에 보호자를 등록하면 **6자리 공유 코드**가 나온다
(혼동하기 쉬운 0/O, 1/I/L을 뺀 문자 집합 — 전화로 불러줘야 할 수도 있어서).

보호자는 `guardian.html?code=XXXXXX`로 들어와 대상자의 위치·경로·현재 안내를 실시간으로 본다.
상태가 바뀌는 순간(대피 시작 / 구조 요청 / 대피 완료)에 배너가 바뀌고 브라우저 알림이 뜬다.

### 개인정보 경계

SSE 스트림이 `?code=`를 받으면 **보호자 스코프**로 동작한다. 그 코드에 연결된 대상자의
위치·구조요청·알림만 내려가고, 다른 대피자의 정보와 운영 지표(metrics)는 전달하지 않는다.
보호자는 자신이 돌보는 사람만 봐야 한다.

코드는 **이미 쓰이지 않은 것으로 발급한다** — 겹치면 남의 대피 상황이 보이기 때문이다.

## 음성·진동 6개 명령

명령을 6개로 제한한다. 재난 상황에서 외울 수 있는 수가 그 정도다.

| 명령 | 진동 | 예시 문구 |
|---|---|---|
| 직진 | 짧게 1회 | "정면으로 9걸음 이동하세요. 오른쪽 벽을 따라가세요." |
| 우회전 | 짧게 2회 | "오른쪽으로 도세요. 그다음 12걸음 직진입니다." |
| 좌회전 | 짧게 3회 | "왼쪽으로 도세요. …" |
| 멈춤 | 길게 1회 | "멈추세요. 왼쪽으로 30도 돌려 통로를 찾으세요." |
| 위험 | 길게 3회 | "위험. 전방 통로 상태가 변경되었습니다." |
| 구조요청 | 매우 길게 2회 | "제자리에서 구조요청을 전송합니다. 이동하지 말고 대기하세요." |

### 방향 확인 — 누르고 있는 동안만

`compass-guide.js` — 폰을 쥔 손을 좌우로 훑으면 **맞는 쪽에서 신호가 강해진다**(아이폰 '나의 찾기' 방식).
소리는 좌우 스테레오 + 빠르기, 진동은 빠르기로 표현한다.

계속 소리를 내면 화재경보·사람 목소리·지팡이 소리를 덮는다. **시각장애인에게 주변 소리는 시야에
해당하므로**, 그걸 덮는 안내는 도움이 아니라 위험이다. 그래서 누르고 있는 동안만 울린다.

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/health` | 서버·저장소 모드 확인 |
| GET | `/api/map` | 현재 활성 도면 (노드·통로·축척) |
| POST | `/api/route` | `{from, kind}` → 접근가능 최단 출구 경로 + 계산시간 |
| **도면** | | |
| GET | `/api/plans` | 등록된 도면 목록 |
| POST | `/api/plans` | 도면 주입 (검증 후 저장) 🔒 |
| POST | `/api/plans/draft` | **앱 촬영 접수** — 사진 저장 + AI 판독 + 초안 생성 |
| POST | `/api/plans/read` | 사진 → 그래프 초안 (저장 안 함) 🔒 |
| GET | `/api/plans/reader` | 판독 엔진 가용 상태 (탐지기·언어모델 각각) |
| PUT | `/api/plans/:planId/activate` | 이 도면으로 안내 시작 (초안이면 409) 🔒 |
| DELETE | `/api/plans/:planId` | 도면 삭제 (사용 중이면 409) 🔒 |
| GET/PUT | `/api/plans/:planId/image` | 도면 이미지 (data URI) |
| GET | `/api/plans/:planId/walls` · `/floor` | 추출한 벽 · 정리된 층 이미지 |
| PUT | `/api/plans/:planId/scale` · `/north` | 축척 · 방위 보정 🔒 |
| GET | `/api/building` | 층 스택 (층별 상태·도면 유무) |
| **위험·감지** | | |
| GET | `/api/hazards` | 현재 위험 (관제 지정 + 센서 판정 통합) |
| GET | `/api/hazards/manual` | 관제가 직접 지정한 것만 (감사용) |
| PUT/DELETE | `/api/hazards/:edgeId` | 위험 설정·해제 🔒 |
| POST | `/api/hazards/reset` | 시나리오 초기화 🔒 |
| POST | `/api/sensors/temperature` | **온도 판독값 수집** → 임계 초과 시 자동 회피 |
| GET | `/api/sensors` | 판독값 목록 (임계 판정·노후 여부 포함) |
| DELETE/POST | `/api/sensors/:sensorId` · `/api/sensors/reset` | 판독값 삭제 |
| POST | `/api/sensors/fire-panel` | 화재수신기·BMS 웹훅 (건물 연동 자리) |
| **측위·답사** | | |
| POST | `/api/observations` | 비콘 관측 보고 (실제 스캔·시뮬레이션 공통) |
| GET | `/api/beacon-fix` | 현재 판정 위치 |
| GET/PUT/DELETE | `/api/beacon-map[/mapping]` | 비콘 지도 조회·수정 |
| POST | `/api/survey/walk/start` · `/sample` · `/finish` | **걷기 답사** |
| GET/DELETE | `/api/survey/walk` | 답사 조회·삭제 |
| GET/POST/DELETE | `/api/magnetic[/visit]` | 지자기 지문 |
| **대피자·보호자** | | |
| GET/POST | `/api/sos` | 구조요청 (보호자 연락처 자동 첨부) |
| GET/PUT/DELETE | `/api/positions[/:userId]` | 대피자 위치 (상태 전이 시 보호자 알림) |
| GET/POST | `/api/metrics` | 재탐색 시간 KPI |
| POST | `/api/guardians` | 보호자 등록 → 공유 코드 발급 |
| GET | `/api/guardians/:userId` · `/api/guardian/:code` | 보호자 조회 · 보호자 화면 진입 |
| GET | `/api/alerts` | 보호자 알림 이력 |
| GET | `/api/stream` | **SSE** — 변경 실시간 push (`?code=`로 보호자 스코프) |

🔒 = `ADMIN_TOKEN` 설정 시 `x-admin-token` 헤더 필요

## Firebase 연동

1. [Firebase 콘솔](https://console.firebase.google.com)에서 프로젝트 생성 후 **Firestore Database** 활성화
2. 프로젝트 설정 → 서비스 계정 → **새 비공개 키 생성** → `backend/serviceAccountKey.json`
3. `backend/.env.example` → `backend/.env` 복사 후 값 입력

```bash
FIREBASE_PROJECT_ID=your-project-id
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json
ADMIN_TOKEN=아무_긴_문자열     # 설정하면 관제 API에 x-admin-token 헤더 필요
```

4. `npm run dev:all` → 로그에 `[repo] Firestore 연결됨` 확인
5. 보안 규칙 배포: `firebase deploy --only firestore:rules`
   (`firestore.rules`는 **클라이언트 직접 접근을 전부 차단**한다. Admin SDK는 규칙을 우회하므로 백엔드는 정상 동작)

배포는 프론트 → Firebase Hosting, 백엔드 → Cloud Run 조합을 가정했다 (`firebase.json`의 `/api/**` rewrite).

## 구조

```
shared/                     ← 백엔드·프론트·모바일 공용 (단일 진실 소스)
├── floor-plan.js           FloorPlan 모델 · 도면 검증 · 축척/방위/걸음 수 · 비콘 매핑
├── pathfinding.js          Dijkstra — Anyplace 포팅 + 차단엣지/엘리베이터 제외
├── hazard-rules.js         위험 등급 · 온도 임계값 · 센서→위험 변환 · 병합
├── hazard-spread.js        불은 점이 아니라 번진다 — 시간에 따른 반경
├── detectors.js            연기·열 감지기 (예비경보 → 축적 → 확정, 국내 기준 간격)
├── fusion.js               판단 계층 — 여러 신호를 하나의 위치 추정으로
├── tracking.js             추적 계층 — 판단 계층 + 세 앵커
├── positioning.js          비콘 측위 — 최근접 판정 · 스무딩 · 히스테리시스
├── beacon-anchor.js        비콘 판정 → 판단 계층
├── beacon-map.js           걸으면서 비콘 위치를 추정
├── beacon-sim.js           가상 비콘 — 거리 기반 RSSI + 노이즈 (기기 없이 검증)
├── ble-decode.js           BLE 광고 → 비콘 이름 (맥 스캐너와 같은 규칙)
├── altitude.js · altitude-anchor.js    기압 → 층 이동 판정
├── magnetic.js · magnetic-anchor.js    지자기 지문 — 세기의 순서로 통로 좁히기
├── step-detect.js          걸음 검출 — 흔든 것과 걸은 것을 가른다
├── north.js                북쪽 보정 — 도면 위쪽이 실제로 몇 도인가
├── walk-survey.js · survey-remap.js    한 번 걸어서 답사 만들기 · 좌표로 되잇기
├── walk-grid.js · wall-route.js        걸을 수 있는 칸 · 벽을 피해 가는 길
├── orthogonal.js           통로를 직각으로 꺾이는 직선으로
├── stair-descent.js        비상구는 도착이 아니라 반환점 — 1층까지
├── geofence.js             입구 판정 — 건물에 들어온 순간
├── photo-scenario.js       현장 사진 기반 단일 대피 시나리오 (세 화면 공유)
└── walk-sim.js             가상 보행자

backend/
├── src/
│   ├── server.js · app.js  진입점 · Express 앱 (테스트용 분리)
│   ├── config.js           환경변수
│   ├── floor.js            활성 도면 + 통합 위험 상태 (관제 + 센서)
│   ├── building.js         층 스택 — 감시 중 / 도면만 / 도면 없음
│   ├── heatSensors.js      감지기 배치 — 불이 났다고 사람이 정해 주지 않는다
│   ├── events.js           내부 이벤트 허브 → SSE
│   ├── guardian-code.js    보호자 공유 코드 생성
│   ├── planReader.js       도면 판독 — 탐지기와 언어모델을 합치는 이음매
│   │   └── planReader/     detector.js · graph.js · providers.js
│   ├── middleware/auth.js  관제 토큰 검증
│   ├── repositories/       FirestoreRepo | MemoryRepo (동일 인터페이스)
│   └── routes/
│       ├── async-router.js 비동기 핸들러 오류를 잡는 Router
│       └── evacuation · hazards · sensors · plans · telemetry · guardians · beacons · magnetic · stream
└── test/api.test.mjs       API 통합 테스트 65종

frontend/
├── demo.html               통합 시연 (세 화면 + 이벤트 로그) ← 발표용
├── index.html              사용자 앱 (큰 버튼, aria-live, 고대비) + 보호자 등록
├── admin.html              관제 대시보드 (층 스택 · 3D 모형 · 화재·온도 시뮬레이션)
├── guardian.html           보호자 화면
├── architect.html          도면 편집기
├── survey.html             걷기 답사 (폰으로 연다)
├── js/
│   ├── api.js              REST + SSE 클라이언트 · 도면 캐시 · 오프라인 폴백
│   ├── app.js              대피 상태머신 (안내→이탈감지→재탐색→안전상태)
│   ├── escape.js           화면에 넣는 값 이스케이프 (공용)
│   ├── beacon.js · ble-scan.js         주기 스캔 · 실제 BLE 수신
│   ├── beacon-layer.js     도면 위 비콘 표시 (없는 층에서는 아무것도 울리지 않는다)
│   ├── live-track.js       관제 지도 위 실시간 위치
│   ├── survey-walk.js      걷기 답사 화면
│   ├── admin.js            화재·온도 시뮬레이션 · 센서/SOS/KPI 모니터
│   ├── architect.js        도면 업로드 · 지점/통로 편집 · JSON 입출력
│   ├── demo.js             보호자 코드 자동 연결 · 크로스 화면 이벤트 로그
│   ├── guardian.js         대상자 실시간 추적 · 상태 알림
│   ├── guidance.js         음성(TTS)·진동 6개 명령
│   ├── compass-guide.js    방향 확인 — 누르고 있는 동안만
│   ├── odometry.js         걸음감지·방위추적·확신도
│   └── minimap.js          SVG 층 지도 (도면 배경 · 온도 배지)
├── sw.js                   오프라인 캐시 (/api/* 는 캐시 금지)
└── manifest.json           PWA

mobile/                     ← Expo 앱 (실제 BLE 스캔 · 답사 · 촬영 · 안내)
└── src/                    shared/ 와 같은 로직 + 네이티브 전용(ble.js · haptics · sound)

ml/detector/                ← 도면 기호 탐지 (파이썬 · 별도 프로세스)
├── app.py                  FastAPI — /health · /detect
├── hybrid_detector.py      클래스별 담당 모델 라우팅 + 클래스별 NMS
└── models/                 YOLO 가중치 + class_router.json (담당·문턱·지표)

scripts/
├── start-all.mjs           백엔드+프론트 동시 실행·자동 재시작 (npm run dev:all)
├── dev-server.mjs          프론트 개발 서버 (정적 서빙 + /api 프록시 + 라이브리로드)
├── docs-server.mjs         발표 문서 서버 (:3030)
├── sync-shared.mjs         shared/ → frontend/shared/
├── sync-app.mjs            shared/ → mobile/src/
├── extract-walls.py        도면 이미지 → 벽 선분
├── merge-walls.py          추출한 벽 + 생성한 방 합치기
├── make-floor-image.py     층 배경 이미지 생성
├── make-standard-floors.mjs 기준층 도면 생성
├── scan-beacons.py         맥에서 BLE 스캔 (기준 구현)
└── log-walk.py             답사 기록

test/                       21개 파일 — 경로·측위·감지·답사·접근성
docs/                       발표 문서 (npm run docs, :3030)
vendor/                     참고한 오픈소스 원본 (MIT)
```

## 테스트

```bash
npm test    # 484종 (shared 21개 파일 + 백엔드 API 65종)
```

무엇을 고정하고 있는가:

- **경로** — 위험 회피·우회·모든 출구 차단 시 null·엘리베이터 제외·재탐색 2초 이내
- **측위** — 깜빡임 억제·전환 순서·순간이동 억제·판단 계층 합성
- **감지** — 온도 임계·예비경보/축적·감지기 간격·불 번짐
- **답사** — 걷기 답사 → 좌표 되잇기 → 비콘 지도
- **접근성** — `a11y-contract.test.mjs`가 화면의 aria 규약을 검사한다
- **서버 생존** — 활성 도면 없이 삭제·끊긴 SSE·중복 코드에서 죽지 않는지

## 설계 원칙 — 없는 것을 있다고 말하지 않는다

이 저장소에서 반복해서 되돌아온 실패가 하나 있다. **화면이 모르는 것을 아는 척하는 것.**

- 도면이 없으면 시연용 "병원 3층"을 채웠다 → 앱이 있지도 않은 복도를 자신 있게 안내했다.
  이제 도면이 없으면 **없다고 말하고 안내하지 않는다.**
- 비콘이 없는 층에서 가상 비콘 62개가 파동을 냈다 → 화면은 예순두 대가 울고 있다고 말했다.
  이제 **등록된 비콘이 없으면 아무것도 울리지 않는다.**
- 도면 없는 층을 "정상"으로 칠했다 → 아무것도 안 보면서 보고 있다고 말했다.
  이제 **"도면 없음"으로 회색이다.**
- 게이트웨이가 그림을 버려도 모델이 그럴듯한 도면을 지어냈다 →
  이제 **시야 점검이 먼저 돌고, 못 보면 판독을 시작하지 않는다.**
- 서버가 오프라인이 아닌데 4xx를 오프라인으로 착각해 캐시 도면으로 안내했다 →
  이제 **서버가 거절한 것과 서버에 못 닿은 것을 구분한다.**

축척이 추정값이면 `scaleEstimated: true`로 표시하고, AI 초안은 사람이 확인해야 활성화된다.
**빠뜨린 것은 사람이 채우면 되지만, 잘못 만들어낸 것은 사람이 알아채기 어렵다.**

## 오픈소스 출처 (MIT)

- **[Anyplace](https://github.com/dmsl/anyplace)** (Univ. of Cyprus DMSL) —
  POI/Connection 그래프 모델과 `server/app/utils/Dijkstra.scala` 경로탐색을 `shared/pathfinding.js`로 포팅.
- **[Visual_Slam](https://github.com/ravencore06/Visual_Slam)** (Prototype/Academic) —
  PWA 구조, devicemotion 걸음감지·방위추적(`odometry.js`), TTS·진동 접근성 모듈 참고.

오픈소스로 해결되지 않는 부분(공식 안전규칙, 위치 인프라, 당사자 실증, 책임·인증)은
MVP에서 **모의 데이터·시뮬레이션**으로 대체했다. 다만 실제 연동 경로는 열어 두었다:

- **도면** — `POST /api/plans`로 주입. BIM/CAD에서 내보낸 그래프를 같은 형식으로 넣으면 된다.
- **센서** — `POST /api/sensors/temperature`(온도), `POST /api/sensors/fire-panel`(화재수신기).
  관제 시뮬레이션도 같은 API를 쓰므로 실증에서 배선만 바꾸면 된다.
- **비콘** — `POST /api/observations`. 시뮬레이션과 실제 스캔이 같은 형식이다.

## ⚠️ 안전 고지

이 소프트웨어는 **모의대피 실험·UX 검증용 프로토타입**이며 재난안전 인증 제품이 아니다.
실제 화재 대응 용도로 사용해서는 안 된다.
