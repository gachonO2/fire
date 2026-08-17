"""
도면 기호 탐지 서비스 — 피난안내도 사진에서 비상구·계단·실·문을 찾아낸다.

## 왜 별도 서비스인가

가중치가 PyTorch/Ultralytics 형식이라 Node 안에서는 돌릴 수 없다. 그래서
파이썬 프로세스로 띄우고 백엔드가 HTTP 로 부른다. **이 서비스가 꺼져 있어도
도면 등록은 계속 된다** — 백엔드가 판독을 건너뛰고 손으로 그리기로 넘긴다.
탐지기 하나 때문에 도면 등록 전체가 막히면, 사진을 찍으러 그 건물까지 걸어간
사람이 헛걸음을 한다.

## 좌표를 0~1 로 돌려준다

호출하는 쪽(Node)은 편집기가 축소해 보낸 이미지의 픽셀 크기를 알고 있고,
그 크기로 되돌린다. 여기서 픽셀을 그대로 주면 축소 배율이 어긋났을 때
지점이 도면 밖에 찍히는데, 그 오류는 사람이 화면을 봐야만 알아챈다.

## 두 모델을 합치는 이유는 hybrid_detector.py 에 있다

round2 는 exit·elevator·소화기·소화전·door·room 을, round4 는 stair·you_are_here 를
맡는다. 클래스 순서(0~7)는 두 모델이 같아야 하며 시작할 때 검사한다 —
순서가 어긋나면 "비상구"라고 찍은 것이 실제로는 "소화기"가 된다.

실행:
    uvicorn app:app --host 127.0.0.1 --port 8001
"""

import base64
import binascii
import os
import re
import tempfile
from pathlib import Path

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from hybrid_detector import HybridEvacuationDetector, CLASS_NAMES

BASE_DIR = Path(__file__).resolve().parent
MODEL_DIR = BASE_DIR / "models"

ROUND2_MODEL = Path(os.getenv("ROUND2_MODEL", str(MODEL_DIR / "round2_best.pt")))
ROUND4_MODEL = Path(os.getenv("ROUND4_MODEL", str(MODEL_DIR / "round4_guarded_best.pt")))

# 사진이 흐리거나 기울어져 있으면 확신도가 통째로 내려간다. 문턱을 높게 잡으면
# 그런 사진에서 비상구를 통째로 놓치는데, 놓친 출구는 사람이 알아채기 어렵다.
# 낮게 잡아 많이 건지고, 걸러내는 일은 사람이 편집기에서 한다.
CONF = float(os.getenv("DETECT_CONF", "0.25"))
IOU = float(os.getenv("DETECT_IOU", "0.50"))
IMGSZ = int(os.getenv("DETECT_IMGSZ", "768"))

DEVICE = "0" if torch.cuda.is_available() else "cpu"

DATA_URI = re.compile(r"^data:image/(png|jpe?g|webp|bmp);base64,(.+)$", re.IGNORECASE)

app = FastAPI(title="도면 기호 탐지기", version="1.0.0")

detector = None
load_error = None


@app.on_event("startup")
def load_models():
    global detector, load_error
    try:
        detector = HybridEvacuationDetector(
            round2_model=ROUND2_MODEL,
            round4_model=ROUND4_MODEL,
            imgsz=IMGSZ,
            conf_round2=CONF,
            conf_round4=CONF,
            iou=IOU,
            device=DEVICE,
        )
        print(f"[detector] 준비됨 · device={DEVICE} · imgsz={IMGSZ} · conf={CONF}")
    except Exception as err:
        # 여기서 죽으면 /health 가 이유를 말하지 못한다. 백엔드는 "탐지기 없음"과
        # "탐지기가 이런 이유로 안 뜸"을 구분해서 사람에게 보여줘야 한다.
        load_error = str(err)
        print(f"[detector] 적재 실패: {err}")


@app.get("/health")
def health():
    return {
        "ok": detector is not None,
        "reason": load_error,
        "device": DEVICE,
        "classes": CLASS_NAMES,
        "models": {"round2": str(ROUND2_MODEL), "round4": str(ROUND4_MODEL)},
    }


class DetectRequest(BaseModel):
    dataUri: str


@app.post("/detect")
def detect(req: DetectRequest):
    if detector is None:
        raise HTTPException(503, load_error or "탐지기가 아직 준비되지 않았습니다.")

    m = DATA_URI.match(req.dataUri.strip())
    if not m:
        raise HTTPException(400, "data:image/...;base64,... 형식이 아닙니다.")

    suffix = "." + ("jpg" if m.group(1).lower() in ("jpeg", "jpg") else m.group(1).lower())
    try:
        blob = base64.b64decode(m.group(2), validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "base64 를 해독하지 못했습니다.")

    # 업로드본은 남기지 않는다. 도면 사진은 백엔드가 이미 보관하고 있고,
    # 여기에 사본이 쌓이면 지우는 사람이 없다.
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    try:
        tmp.write(blob)
        tmp.close()
        raw = detector.predict(tmp.name)
        width, height = _image_size(tmp.name)
    finally:
        Path(tmp.name).unlink(missing_ok=True)

    detections = [
        {
            "classId": d["class_id"],
            "className": d["class_name"],
            "confidence": round(float(d["confidence"]), 4),
            # 0~1 정규화 — 호출하는 쪽이 자기가 아는 픽셀 크기로 되돌린다
            "box": [
                _clamp01(d["bbox_xyxy"][0] / width),
                _clamp01(d["bbox_xyxy"][1] / height),
                _clamp01(d["bbox_xyxy"][2] / width),
                _clamp01(d["bbox_xyxy"][3] / height),
            ],
            "sourceModel": d["source_model"],
        }
        for d in raw
    ]

    counts = {name: 0 for name in CLASS_NAMES}
    for d in detections:
        counts[d["className"]] += 1

    return {
        "detections": detections,
        "counts": counts,
        "imageSize": {"width": width, "height": height},
        "classes": CLASS_NAMES,
    }


def _image_size(path: str):
    import cv2

    img = cv2.imread(path)
    if img is None:
        raise HTTPException(400, "이미지를 읽지 못했습니다.")
    h, w = img.shape[:2]
    return w, h


def _clamp01(v: float) -> float:
    return round(min(1.0, max(0.0, float(v))), 5)
