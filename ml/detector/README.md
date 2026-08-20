# 도면 기호 탐지기

피난안내도 사진에서 **비상구·계단·엘리베이터·소화기·소화전·현 위치·문·실**을 찾는
YOLO 모델 세 벌과, 그걸 HTTP 로 내주는 작은 서비스.

백엔드(`backend/src/planReader.js`)가 도면 판독을 할 때 여기를 부른다.
**이 서비스가 꺼져 있어도 도면 등록은 계속 된다** — 판독이 언어모델 단독으로
내려가거나, 그마저 없으면 손으로 그리기로 넘어간다. 탐지기 하나 때문에
도면 등록 전체가 막히면, 사진을 찍으러 그 건물까지 걸어간 사람이 헛걸음한다.

## 왜 모델이 세 벌인가

한 벌로 여덟 종류를 다 학습시켰더니 일부 클래스가 서로를 잡아먹었다.
그래서 라운드를 나눠 학습시키고, **클래스마다 그 클래스를 가장 잘 잡는 모델 한 벌**을
골랐다. 배정은 `models/class_router.json` (라운드 6 학습에서 받아온 라우팅 표)에 있다.

| 클래스 | 담당 | 검증 재현율 |
|---|---|---|
| 0 exit · 1 stair · 2 elevator · 5 you_are_here · 7 room | `round2_best.pt` | 1.000 |
| 3 extinguisher · 4 hydrant | `stage_b_best.pt` | 0.991 |
| 6 door | `stage_a_best.pt` | 1.000 |

**배정은 코드에 없다.** `hybrid_detector.py` 는 표를 읽어 따르기만 한다 — 재학습할 때마다
담당이 바뀌는데 파이썬 상수를 같이 고치는 걸 잊으면, 서비스는 멀쩡히 뜨고 틀린 모델이
낸 결과가 그대로 편집기로 간다. 아무도 못 알아챈다.

가중치 파일별로 한 번씩만 돌리고(지금은 세 번), 결과를 합친 뒤 클래스별 NMS 로 중복을
정리한다. 표에 담당이 없는 클래스가 하나라도 있으면 뜨지 않는다 — 담당이 빈 기호는
"도면에 없는 것"과 구분되지 않기 때문이다.

**클래스 순서(0~7)는 모든 가중치가 같아야 한다.** 시작할 때 검사해서 어긋나면 뜨지 않는다 —
순서가 밀리면 "비상구"라고 찍은 것이 실제로는 "소화기"가 되고, 그 오류는
도면이 저장된 뒤에야 드러난다.

```
0 exit   1 stair   2 elevator   3 extinguisher
4 hydrant   5 you_are_here   6 door   7 room
```

## models/ 에 무엇이 있나

| 파일 | 내용 |
|---|---|
| `round2_best.pt` · `stage_a_best.pt` · `stage_b_best.pt` | 추론에 쓰는 가중치 (각 5.5MB) |
| `class_router.json` | 클래스별 담당 모델·검증 문턱·지표 |
| `model_hashes.json` | 학습 때 가중치의 SHA-256. 어긋나면 경고한다(막지는 않는다) |
| `allclass_selection_report.json` | 담당을 그렇게 고른 근거가 된 클래스별 지표 |

## 실행

```bash
cd ml/detector
python -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt

uvicorn app:app --host 127.0.0.1 --port 8001
```

저장소 루트에서 `npm run detector` 로도 뜬다(가상환경을 먼저 활성화해 둘 것).

확인:

```bash
curl http://127.0.0.1:8001/health
```

`{"ok": true, ...}` 가 나오면 백엔드가 자동으로 이 탐지기를 쓴다.
백엔드 쪽 주소를 바꾸려면 `backend/.env` 의 `DETECTOR_URL`.

## API

### `GET /health`

```json
{ "ok": true, "device": "cpu", "classes": ["exit", "stair", ...],
  "models": ["round2_best.pt", "stage_a_best.pt", "stage_b_best.pt"],
  "routes": [
    { "classId": 0, "className": "exit", "model": "round2",
      "weights": "round2_best.pt", "threshold": 0.75, "recall": 1.0 }
  ],
  "hashWarnings": [] }
```

`ok:false` 면 `reason` 에 이유가 담긴다. 백엔드는 이 문장을 그대로 편집기에 보여준다.
가중치를 갈아 끼운 뒤 담당이 제대로 바뀌었는지 확인할 곳은 `routes` 뿐이다.
`hashWarnings` 가 비어 있지 않으면 파일이 학습 때와 달라진 것이고, `routes` 의 지표는
더 이상 그 파일로 잰 값이 아니다.

### `POST /detect`

```json
{ "dataUri": "data:image/jpeg;base64,..." }
```

```json
{
  "detections": [
    { "classId": 0, "className": "exit", "confidence": 0.83,
      "box": [0.902, 0.451, 0.958, 0.549], "sourceModel": "round2",
      "routerThreshold": 0.75, "aboveThreshold": true }
  ],
  "counts": { "exit": 1, "stair": 2, ... },
  "imageSize": { "width": 1100, "height": 744 }
}
```

`box` 는 **0~1 로 정규화된** `[x1, y1, x2, y2]` 다. 픽셀을 그대로 주면
편집기가 이미지를 축소한 배율과 어긋났을 때 지점이 도면 밖에 찍히는데,
그 오류는 사람이 화면을 봐야만 알아챈다.

## 설정 (환경변수)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `DETECTOR_MODEL_DIR` | `models` | 가중치와 라우팅 표가 있는 폴더 |
| `DETECT_CONF` | `0.25` | 확신도 문턱 |
| `DETECT_IOU` | `0.50` | NMS IoU |
| `DETECT_IMGSZ` | `1280` | 추론 해상도 |
| `DETECT_ENFORCE_ROUTER_THRESHOLDS` | (꺼짐) | `1` 이면 라우팅 표의 클래스별 문턱(0.75)을 적용 |

라우팅 표의 문턱을 기본으로 적용하지 않는 이유: 그 0.75 는 **깨끗한 검증 도면**에서
정밀도 1.0 을 얻으려고 고른 값이다. 유리 반사와 기울기가 든 실제 사진은 확신도가
통째로 내려가서, 같은 문턱을 그대로 대면 실제 비상구가 잘려 나간다. 서비스는 0.25 로
많이 건지고, 각 탐지가 검증 문턱을 넘었는지는 `aboveThreshold` 로 함께 알려준다.
지표를 재현해 볼 때만 이 변수를 켠다.

해상도를 1280 으로 올린 이유: 피난안내도의 비상구 픽토그램은 **도면 전체 대비 아주 작다.**
853px 짜리 사진에서 픽토그램 하나가 12~26px 인데, 768 로 줄여 추론하면 10px 안팎이 되어
모델이 사실상 못 본다. 실측(`촬영도면/draft-1-1.jpg`)에서 768 → 1280 으로 올리자
도면 안 픽토그램의 확신도가 0.53 → 0.86 으로, 탐지 수가 10 → 25 개로 뛰었다.
대신 느려진다(CPU 로 사진 한 장에 0.4초 → 1.2초, 예열 전 첫 장은 5~10초).

1920 까지 올리면 탐지가 더 늘지만 `you_are_here` 오탐이 폭발한다(실제 1개 → 13개).
1280 이 지금 가중치에서의 균형점이다.

문턱을 낮게 잡은 이유: 사진이 흐리거나 기울어져 있으면 확신도가 통째로 내려간다.
높게 잡으면 그런 사진에서 비상구를 통째로 놓치는데, **놓친 출구는 사람이 알아채기
어렵다**(있는데 없다고 나온 것보다, 없는데 있다고 나온 쪽이 눈에 띈다).
낮게 잡아 많이 건지고, 걸러내는 일은 사람이 편집기에서 한다.
백엔드에서 한 번 더 거를 수 있다 — `backend/.env` 의 `DETECTOR_MIN_CONFIDENCE`.

## 성능

GPU 가 있으면 자동으로 쓴다(`torch.cuda.is_available()`).
예열이 끝나면 CPU 로 사진 한 장에 1~2초, 처음 한 장은 모델 적재까지 겹쳐 5~10초 걸린다
— 가중치 세 벌을 순서대로 돌리기 때문이다.
편집기는 "20초~1분"으로 안내한다.

한 클래스를 한 모델만 맡으므로 모델을 늘려도 결과가 겹치지는 않지만, 시간은 그만큼
늘어난다. 담당이 한 가중치로 몰리면 그 가중치만 돌아서 다시 빨라진다.

## 모델을 다시 학습시킬 때

가중치는 코랩에서 학습해 받아온 것이다. 새로 학습시켜 바꿔 넣을 때는

- `models/` 에 **가중치와 `class_router.json` 을 함께** 넣을 것. 담당 배정은 표만 보고
  정해지므로, 가중치만 바꾸면 새 모델이 예전 담당을 그대로 물려받는다
- 클래스 순서를 위 표대로 유지할 것 (`hybrid_detector.py` 의 `CLASS_NAMES`)
- 표의 `model_path` 는 학습 환경의 절대경로여도 된다 — 파일 이름만 떼어 `models/` 에서 찾는다
- `model_hashes.json` 도 같이 갱신할 것. 안 하면 뜰 때마다 "학습 때와 다른 파일" 경고가 남는다
- 바꾼 뒤 `GET /health` 의 `routes` 로 담당이 의도대로 바뀌었는지, 클래스 순서 검사가
  통과하는지 확인할 것
