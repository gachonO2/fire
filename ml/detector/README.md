# 도면 기호 탐지기

피난안내도 사진에서 **비상구·계단·엘리베이터·소화기·소화전·현 위치·문·실**을 찾는
YOLO 모델 두 벌과, 그걸 HTTP 로 내주는 작은 서비스.

백엔드(`backend/src/planReader.js`)가 도면 판독을 할 때 여기를 부른다.
**이 서비스가 꺼져 있어도 도면 등록은 계속 된다** — 판독이 언어모델 단독으로
내려가거나, 그마저 없으면 손으로 그리기로 넘어간다. 탐지기 하나 때문에
도면 등록 전체가 막히면, 사진을 찍으러 그 건물까지 걸어간 사람이 헛걸음한다.

## 왜 모델이 두 벌인가

한 벌로 여덟 종류를 다 학습시켰더니 일부 클래스가 서로를 잡아먹었다.
그래서 라운드를 나눠 학습시키고, 각 라운드가 **자신 있는 클래스만** 맡는다.

| 모델 | 맡는 클래스 |
|---|---|
| `round2_best.pt` | 0 exit · 2 elevator · 3 extinguisher · 4 hydrant · 6 door · 7 room |
| `round4_guarded_best.pt` | 1 stair · 5 you_are_here |

두 결과를 합친 뒤 클래스별 NMS 로 중복을 정리한다(`hybrid_detector.py`).

**클래스 순서(0~7)는 두 모델이 같아야 한다.** 시작할 때 검사해서 어긋나면 뜨지 않는다 —
순서가 밀리면 "비상구"라고 찍은 것이 실제로는 "소화기"가 되고, 그 오류는
도면이 저장된 뒤에야 드러난다.

```
0 exit   1 stair   2 elevator   3 extinguisher
4 hydrant   5 you_are_here   6 door   7 room
```

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
  "models": { "round2": "...", "round4": "..." } }
```

`ok:false` 면 `reason` 에 이유가 담긴다. 백엔드는 이 문장을 그대로 편집기에 보여준다.

### `POST /detect`

```json
{ "dataUri": "data:image/jpeg;base64,..." }
```

```json
{
  "detections": [
    { "classId": 0, "className": "exit", "confidence": 0.83,
      "box": [0.902, 0.451, 0.958, 0.549], "sourceModel": "round2" }
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
| `ROUND2_MODEL` | `models/round2_best.pt` | 가중치 경로 |
| `ROUND4_MODEL` | `models/round4_guarded_best.pt` | 가중치 경로 |
| `DETECT_CONF` | `0.25` | 확신도 문턱 |
| `DETECT_IOU` | `0.50` | NMS IoU |
| `DETECT_IMGSZ` | `768` | 추론 해상도 |

문턱을 낮게 잡은 이유: 사진이 흐리거나 기울어져 있으면 확신도가 통째로 내려간다.
높게 잡으면 그런 사진에서 비상구를 통째로 놓치는데, **놓친 출구는 사람이 알아채기
어렵다**(있는데 없다고 나온 것보다, 없는데 있다고 나온 쪽이 눈에 띈다).
낮게 잡아 많이 건지고, 걸러내는 일은 사람이 편집기에서 한다.
백엔드에서 한 번 더 거를 수 있다 — `backend/.env` 의 `DETECTOR_MIN_CONFIDENCE`.

## 성능

GPU 가 있으면 자동으로 쓴다(`torch.cuda.is_available()`).
CPU 로는 사진 한 장에 5~15초쯤 걸린다 — 두 모델을 순서대로 돌리기 때문이다.
편집기는 "20초~1분"으로 안내한다.

## 모델을 다시 학습시킬 때

가중치는 코랩에서 학습해 받아온 것이다. 새로 학습시켜 바꿔 넣을 때는

- 클래스 순서를 위 표대로 유지할 것 (`hybrid_detector.py` 의 `CLASS_NAMES`)
- 라운드별로 맡는 클래스가 바뀌면 `ROUND2_CLASSES`·`ROUND4_CLASSES` 도 함께 고칠 것
- 바꾼 뒤 `GET /health` 로 클래스 순서 검사가 통과하는지 확인할 것
