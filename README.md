# 🧯 시각장애인 실내 대피 AI 내비게이션 (MVP)

> 재난 때 '가까운 출구'를 알려주는 것이 아니라, 시각장애인이 **현재 위치에서 연기·혼잡·장애물을 피해
> 실제로 이동할 수 있는 경로**를 음성·진동으로 안내한다.

4주 MVP 범위: **한 건물 한 층(병원 3층)의 모의대피 실험**.
"완전 자율 대피"가 아니라 **접근 가능한 동적 경로 + 안내 UX 검증**이 목표다.

---

## 아키텍처

```
┌──────────────────────────┐        ┌────────────────────────────┐       ┌───────────┐
│ frontend/ (PWA, 순수 JS) │  REST  │ backend/ (Node + Express)   │ Admin │ Firestore │
│  · 사용자 앱 (음성·진동) │ ─────▶ │  · 경로 계산 (권위)         │  SDK  │  hazards  │
│  · 관제 대시보드         │        │  · 위험 상태 검증·인증      │ ────▶ │  sos      │
│                          │ ◀───── │  · 화재수신기/BMS 웹훅      │       │  positions│
│  오프라인 폴백 계산      │  SSE   │  · SSE 브로드캐스트         │       │  metrics  │
└──────────────────────────┘        └────────────────────────────┘       └───────────┘
                    └──────── shared/ (지도 그래프 + Dijkstra) ────────┘
```

**프론트엔드는 Firestore에 직접 접근하지 않는다.** 모든 DB 접근은 백엔드가 서비스 계정으로 수행한다.
그래서 브라우저에 Firebase 자격증명이 노출되지 않고, 위험 상태(hazards) 쓰기를 관제 인증으로만
통제할 수 있다 — 잘못된 위험 정보 주입은 곧바로 오안내 → 인명위험이기 때문이다.

`shared/`는 지도 그래프와 경로탐색 알고리즘의 **단일 진실 소스**다. 백엔드가 권위 있는 계산을 하지만,
통신이 끊겼을 때 프론트가 캐시된 위험 상태로 직접 계산해 안내를 이어가야 하므로
(`npm run sync`가 `frontend/shared/`로 복사) 양쪽이 같은 코드를 쓴다.

## 개발 실행

```bash
npm install       # 루트 + backend 의존성 (npm workspaces)
npm run dev       # 프론트엔드 → http://localhost:5173
```

**백엔드는 VS Code에서 `F5`** (실행 구성: `백엔드 실행·디버그`, 포트 8080).
중단점을 찍고 경로 계산·위험 전파를 그대로 디버깅할 수 있다.

- **사용자 앱** → http://localhost:5173/index.html
- **관제 대시보드** → http://localhost:5173/admin.html
- **보호자 화면** → http://localhost:5173/guardian.html (사용자 앱에서 발급한 코드 입력)

프론트 개발 서버가 `/api/*`를 백엔드(:8080)로 프록시하므로 **같은 출처**가 되어
CORS 설정 없이 SSE까지 그대로 흐른다 (배포 구성과 동작이 동일하다).
`/shared/*`는 사본이 아니라 `shared/` 원본을 직접 읽으므로 지도·경로탐색을 고치면 새로고침만으로 반영된다.

백엔드를 아직 안 띄웠다면 프록시가 503을 돌려주고, 프론트는 **오프라인 폴백**으로 전환해
캐시된 지도로 안내를 계속한다 — 이 동작 자체를 확인하는 용도로도 쓸 수 있다.

| 실행 방식 | 명령 | 용도 |
|---|---|---|
| 프론트 | `npm run dev` | :5173, `/api`는 :8080으로 프록시 |
| 백엔드 | **VS Code F5** | :8080, 디버거 연결 |
| 백엔드 (터미널) | `npm run dev:backend` | 디버거 없이 자동 재시작 |
| 통합 1포트 | `npm start` | :8080 하나로 프론트까지 서빙 (시연·배포 확인용) |

포트가 이미 쓰이고 있어도 개발 서버는 죽지 않는다. **이전 실행이 남아 있으면** 그 사실을 알리고
기존 서버를 쓰라고 안내하며, **다른 프로그램이 점유했으면** 다음 포트로 옮겨 뜬다.
포트를 직접 비우려면 `npx kill-port 5173` (macOS/Linux는 `lsof -ti:5173 | xargs kill`),
다른 포트를 쓰려면 `FRONTEND_PORT=3000 npm run dev`.

Firebase 설정이 없으면 백엔드가 **인메모리 저장소**로 뜬다. 실시간 전파(SSE)·경로 재탐색·구조요청까지
전부 동작하므로 시연에는 충분하다. 여러 기기를 같은 Wi-Fi에서 붙이면 서로 실시간 연동된다.

시연 순서: 사용자 앱에서 **301호 진료실 앞** 선택 → **대피 시작** → 데모 패널의 **자동 이동** →
관제에서 통로 클릭으로 화재 발생 → 사용자 앱이 즉시 재탐색 안내.

## Firebase 연동

1. [Firebase 콘솔](https://console.firebase.google.com)에서 프로젝트 생성 후 **Firestore Database** 활성화
2. 프로젝트 설정 → 서비스 계정 → **새 비공개 키 생성** → `backend/serviceAccountKey.json`으로 저장
3. `backend/.env.example` → `backend/.env` 복사 후 값 입력

```bash
FIREBASE_PROJECT_ID=your-project-id
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json
ADMIN_TOKEN=아무_긴_문자열     # 설정하면 관제 API에 x-admin-token 헤더 필요
```

4. `npm run dev` → 로그에 `[repo] Firestore 연결됨` 확인
5. 보안 규칙 배포: `firebase deploy --only firestore:rules`
   (`firestore.rules`는 **클라이언트 직접 접근을 전부 차단**한다. Admin SDK는 규칙을 우회하므로 백엔드는 정상 동작)

배포는 프론트 → Firebase Hosting, 백엔드 → Cloud Run 조합을 가정했다 (`firebase.json`의 `/api/**` rewrite).

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/health` | 서버·저장소 모드 확인 |
| GET | `/api/map` | 현재 활성 도면 (노드·통로·축척) |
| POST | `/api/route` | `{from, kind}` → 접근가능 최단 출구 경로 + 계산시간 |
| GET | `/api/plans` | 등록된 도면 목록 |
| POST | `/api/plans` | **도면 주입** (검증 후 저장) 🔒 |
| PUT | `/api/plans/:id/activate` | 이 도면으로 안내 시작 🔒 |
| DELETE | `/api/plans/:id` | 도면 삭제 (사용 중이면 409) 🔒 |
| GET/PUT | `/api/plans/:id/image` | 도면 이미지 (data URI) |
| POST | `/api/sensors/temperature` | **온도 판독값 수집** → 임계 초과 시 자동 회피 |
| GET | `/api/sensors` | 판독값 목록 (임계 판정·노후 여부 포함) |
| DELETE | `/api/sensors/:id` · POST `/api/sensors/reset` | 판독값 삭제 |
| GET | `/api/hazards` | 현재 위험 상태 (관제 지정 + 센서 판정 통합) |
| GET | `/api/hazards/manual` | 관제가 직접 지정한 위험만 (감사용) |
| PUT | `/api/hazards/:edgeId` | `{type}` 위험 설정 🔒 |
| DELETE | `/api/hazards/:edgeId` | 위험 해제 🔒 |
| POST | `/api/hazards/reset` | 시나리오 초기화 🔒 |
| POST | `/api/sensors/fire-panel` | 화재수신기·BMS 웹훅 (건물 연동 자리) |
| GET/POST | `/api/sos` | 구조요청 조회·전송 (보호자 연락처 자동 첨부) |
| GET/PUT | `/api/positions[/:userId]` | 대피자 위치 (상태 전이 시 보호자 알림 생성) |
| GET/POST | `/api/metrics` | 재탐색 시간 KPI |
| POST | `/api/guardians` | 보호자 등록 → 공유 코드 발급 |
| GET | `/api/guardians/:userId` | 등록된 보호자 조회 |
| GET | `/api/guardian/:code` | 보호자 화면 진입 (대상자 현재 상태) |
| GET | `/api/alerts` | 보호자 알림 이력 |
| GET | `/api/stream` | **SSE** — 변경 실시간 push (`?code=`로 보호자 스코프) |

🔒 = `ADMIN_TOKEN` 설정 시 `x-admin-token` 헤더 필요

## 데모 시나리오 (발표용)

병원 3층, 301호 진료실 앞에서 화재경보. 초기 상태: **계단 A(동쪽)는 연기 감지, 엘리베이터는 화재 시 자동 제외**.

| 단계 | 조작 | 기대 동작 |
|---|---|---|
| 1 | 대피 시작 | 긴 진동 1회 + "대피 모드를 시작합니다" → 최단 접근가능 출구(남쪽 비상구)로 안내 |
| 2 | 관제에서 남쪽 램프(E11)에 화재 | 2초 이내 재탐색 → 계단 B(서쪽)로 우회, 회전 시 짧은 진동 |
| 3 | 계단 B 통로(E9)도 차단 | 남은 출구(계단 A)는 연기 → **접근 가능 경로 없음** → 안전상태 전환, 구조요청 자동 전송 |
| 4 | 데모 패널 "경로 이탈 재현" ×2 | 확신도 하락 → 기준(40%) 미달 시 임의 안내 중단 + 구조요청 |
| 5 | 백엔드 종료 후 걷기 | 배지가 "오프라인"으로 바뀌고 캐시된 지도·위험 상태로 안내 계속 |
| 6 | 사전에 보호자 등록 후 대피 시작 | 보호자 화면에 🚨 배너·브라우저 알림 + 위치·경로·현재 안내가 실시간 표시 |
| 7 | 관제에서 🌡️ 온도 도구로 통로에 71°C 주입 | 임계값(60°C) 초과 → 그 구간을 빼고 재탐색, 지도에 온도 배지 표시 |
| 8 | 교차점(원)에 82°C 주입 | 연결된 모든 통로 차단 → 갈 곳이 없으면 안전상태 + 구조요청 |
| 9 | 도면 편집기에서 다른 건물 도면 올리고 활성화 | 열려 있는 모든 화면이 새 도면으로 전환, 그 도면 기준으로 안내 |

검증 가설 매핑: ① 진동+음성 병행 이해율(6개 명령 규칙) ② 불확실성 감지(확신도·안전상태)
③ 재탐색 2초 이내(관제 KPI 패널에 ms 기록) ④ 관제·유지관리 가치(대시보드·센서 웹훅).

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

축척이 곧 "몇 걸음"이 되므로 2단계가 안내 정확도를 좌우한다.
저장 시 도면을 검증한다 — 출구가 없거나, 없는 지점을 잇는 통로가 있거나, id가 중복되면 **거부**한다.
출구까지 이어지지 않는 고립된 지점은 경고로 알려준다(편집 중일 수 있으므로 저장은 허용).

다른 도구에서 만든 도면은 **JSON 가져오기**로 넣을 수 있다(`POST /api/plans`와 같은 형식).
도면을 활성화하면 열려 있는 모든 사용자 앱·관제·보호자 화면이 SSE로 즉시 새 도면을 받는다.

```jsonc
{
  "id": "office-5f", "name": "사무동 5층",
  "metersPerUnit": 0.04,          // 도면 1px = 4cm
  "stepLength": 0.7,
  "image": { "width": 1400, "height": 900 },
  "nodes": [ { "id": "R1", "name": "501호 회의실 앞", "x": 300, "y": 700, "type": "room" } ],
  "edges": [ { "id": "C1", "a": "R1", "b": "H1", "wall": "right" } ]
}
```

노드 유형: `room` `junction` `exit` `elevator` `stair` — **`exit`가 대피 목표**가 되고,
`elevator: true` 통로는 화재 모드에서 자동 제외된다.

## 온도 센서 회피

온도 센서 판독값이 임계값을 넘으면 **그 구간을 자동으로 빼고** 경로를 다시 잡는다.

| 온도 | 판정 | 경로탐색 처리 |
|---|---|---|
| 60°C 이상 | 🚫 과열 — 통행 불가 | 그래프에서 제외 |
| 45°C 이상 | ⚠️ 온도 상승 | 통행은 가능하되 가중치 ×4로 강하게 회피 |
| 그 미만 | 정상 | 영향 없음 |
| 60초 이상 갱신 없음 | 판독 끊김 | **신뢰하지 않음** — 오래된 값으로 안내하지 않는다 |

센서는 **통로(edgeId)** 또는 **지점(nodeId)** 에 붙는다.
교차점이 뜨거우면 어느 방향으로도 지날 수 없으므로, 지점 센서가 과열되면
그 지점에 연결된 **모든 통로**를 막는다.

```bash
# 실제 센서 게이트웨이·BMS가 호출하는 것과 동일한 엔드포인트
curl -X POST http://localhost:5173/api/sensors/temperature \
  -H 'Content-Type: application/json' \
  -d '{"sensorId":"TMP-C4","edgeId":"C4","celsius":71}'
```

관제 대시보드의 **🌡️ 온도** 도구는 이 API를 그대로 호출한다 —
시뮬레이션과 실제 연동의 경로를 분리하지 않아야 실증에서 그대로 쓸 수 있기 때문이다.
지도에는 판독값이 배지로 표시되고, 판독이 끊긴 센서는 흐리게 `⚠` 표시된다.

관제가 지정한 위험과 센서 판정이 겹치면 **더 심각한 쪽**을 채택한다.
센서가 정상이라는 이유로 관제가 막아둔 통로를 열어주면 안 되기 때문이다.

## 보호자 위치 공유

사용자가 **대피 전에 미리** 보호자를 등록해 두면(이름·연락처), 6자리 공유 코드와 링크가 발급된다.
보호자가 그 링크를 열어두면 화재로 대피가 시작되는 순간부터 다음이 실시간으로 표시된다.

- 🚨 상태 배너 (대기 중 / 대피 중 / 구조 요청 / 대피 완료) + **브라우저 알림·진동**
- 지도 위 대상자 위치, 안내 중인 경로, 위험 통로
- **지금 대상자가 듣고 있는 음성 안내 그대로** ("정면으로 9걸음 이동하세요…")
- 위치 확신도, 목표 출구, 남은 걸음 수, 상황 기록

알림은 상태가 **바뀌는 순간에만** 울린다 — 걸음마다 울리면 보호자가 알림을 꺼버리기 때문이다.

구조요청이 발생하면 관제 대시보드의 SOS 카드에 **보호자 이름·연락처가 함께** 표시되어
구조대가 바로 연락할 수 있다.

### 개인정보 경계

보호자 스트림은 `?code=`로 **스코프가 제한**된다. 코드에 연결된 대상자의 위치·구조요청·알림만
내려가고, 다른 대피자의 위치와 운영 지표(metrics)는 전달되지 않는다.
MVP의 코드 기반 링크는 시연용이며, 실서비스에서는 보호자 본인확인·코드 만료·공유 철회가 필요하다.

## 음성·진동 6개 명령

| 명령 | 진동 | 음성 예시 |
|---|---|---|
| 직진 | 짧게 1회 | "정면으로 9걸음 이동하세요. 오른쪽 벽을 따라가세요." |
| 우회전 | 짧게 2회 | "오른쪽으로 도세요. 그다음 12걸음 직진입니다." |
| 좌회전 | 짧게 3회 | "왼쪽으로 도세요. …" |
| 멈춤 | 길게 1회 | "멈추세요. 왼쪽으로 30도 돌려 통로를 찾으세요." |
| 위험 | 길게 3회 | "위험. 전방 통로 상태가 변경되었습니다." |
| 구조요청 | 매우 길게 2회 | "제자리에서 구조요청을 전송합니다. 이동하지 말고 대기하세요." |

## 구조

```
shared/                     ← 백엔드·프론트 공용 (단일 진실 소스)
├── floor-plan.js           FloorPlan 모델 · 도면 검증 · 축척/방위/걸음 수 계산
├── default-plan.js         기본 시연 도면 (병원 3층)
├── hazard-rules.js         위험 등급 · 온도 임계값 · 센서→위험 변환 · 병합
└── pathfinding.js          Dijkstra — Anyplace 포팅 + 차단엣지/엘리베이터 제외

backend/
├── src/
│   ├── server.js           진입점
│   ├── app.js              Express 앱 (테스트용 분리)
│   ├── config.js           환경변수
│   ├── floor.js            활성 도면 + 통합 위험 상태 (관제 + 센서)
│   ├── events.js           내부 이벤트 허브 → SSE
│   ├── guardian-code.js    보호자 공유 코드 생성
│   ├── middleware/auth.js  관제 토큰 검증
│   ├── repositories/       FirestoreRepo | MemoryRepo (동일 인터페이스)
│   └── routes/             evacuation · hazards · sensors · plans · telemetry · guardians · stream
└── test/api.test.mjs       API 통합 테스트 56종

frontend/
├── index.html              사용자 앱 (큰 버튼, aria-live, 고대비) + 보호자 등록
├── admin.html              관제 대시보드 (화재·온도 시뮬레이션)
├── guardian.html           보호자 화면
├── architect.html          도면 편집기 (설계도 주입)
├── js/
│   ├── api.js              REST + SSE 클라이언트 · 도면 캐시 · 오프라인 폴백
│   ├── app.js              대피 상태머신 (안내→이탈감지→재탐색→안전상태)
│   ├── admin.js            화재·온도 시뮬레이션 · 센서/SOS/KPI 모니터
│   ├── architect.js        도면 이미지 업로드 · 지점/통로 편집 · JSON 입출력
│   ├── guardian.js         대상자 실시간 추적 · 상태 알림
│   ├── guidance.js         음성(TTS)·진동 6개 명령
│   ├── odometry.js         걸음감지·방위추적·확신도
│   └── minimap.js          SVG 층 지도 (도면 배경 · 온도 배지)
├── sw.js                   오프라인 캐시 (/api/* 는 캐시 금지)
└── manifest.json           PWA

scripts/
├── dev-server.mjs          프론트 개발 서버 (정적 서빙 + /api 프록시)
└── sync-shared.mjs         shared/ → frontend/shared/ 복사 (배포용)

.vscode/launch.json         F5 실행 구성 (백엔드 · 각 테스트)
test/route.test.mjs         경로탐색 시나리오 테스트 9종
vendor/                     참고한 오픈소스 원본 (MIT)
```

## 테스트

```bash
npm test    # 경로탐색·도면·온도 30종 + 백엔드 API 56종
```

## 오픈소스 출처 (MIT)

- **[Anyplace](https://github.com/dmsl/anyplace)** (Univ. of Cyprus DMSL) —
  POI/Connection 그래프 모델과 `server/app/utils/Dijkstra.scala` 경로탐색을 `shared/pathfinding.js`로 포팅.
- **[Visual_Slam](https://github.com/ravencore06/Visual_Slam)** (Prototype/Academic) —
  PWA 구조, devicemotion 걸음감지·방위추적(`odometry.js`), TTS·진동 접근성 모듈 참고.

오픈소스로 해결되지 않는 부분(공식 안전규칙, 위치 인프라, 당사자 실증, 책임·인증)은
MVP에서 **모의 데이터·시뮬레이션**으로 대체했다. 다만 두 가지는 실제 연동 경로를 열어 두었다:

- **도면** — `POST /api/plans`로 주입. BIM/CAD에서 내보낸 그래프를 같은 형식으로 넣으면 된다.
- **센서** — `POST /api/sensors/temperature`(온도), `POST /api/sensors/fire-panel`(화재수신기).
  관제 시뮬레이션도 같은 API를 쓰므로 실증에서 배선만 바꾸면 된다.

## ⚠️ 안전 고지

이 소프트웨어는 **모의대피 실험·UX 검증용 프로토타입**이며 재난안전 인증 제품이 아니다.
실제 화재 대응 용도로 사용해서는 안 된다.
