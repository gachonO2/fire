"""
클래스별로 담당 모델을 골라 돌리는 탐지기.

## 왜 한 벌이 아닌가

여덟 종류를 한 벌에 다 학습시켰더니 일부 클래스가 서로를 잡아먹었다. 그래서
라운드를 나눠 학습시키고, **클래스마다 그 클래스를 가장 잘 잡는 모델 한 벌**을
골라 라우팅 표(`models/class_router.json`)로 굳혔다. 표는 학습 쪽(라운드 6)이
검증 지표를 보고 정한 것이라, 여기서는 표를 읽어 그대로 따르기만 한다.

담당 배정을 코드에 박아 두지 않는 이유: 재학습할 때마다 어느 라운드가 어느
클래스를 맡을지가 바뀌는데, 그때 파이썬 상수를 같이 고치는 걸 잊으면 표와 코드가
어긋난다. 어긋나도 서비스는 멀쩡히 뜨고, 틀린 담당 모델이 낸 결과가 그대로
편집기로 간다 — 아무도 못 알아챈다. 표 하나만 진실로 두면 그 어긋남 자체가 없다.

## 클래스 순서는 모든 모델이 같아야 한다

순서가 한 칸 밀리면 "비상구"라고 찍은 것이 실제로는 "소화기"가 되고, 그 오류는
도면이 저장된 뒤에야 드러난다. 그래서 적재할 때 모든 가중치의 순서를 검사하고,
어긋나면 아예 뜨지 않는다.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, Iterable, List, Union

import cv2
from ultralytics import YOLO

CLASS_NAMES = [
    "exit",
    "stair",
    "elevator",
    "extinguisher",
    "hydrant",
    "you_are_here",
    "door",
    "room",
]

ROUTER_FILENAME = "class_router.json"
HASHES_FILENAME = "model_hashes.json"


def iou_xyxy(a, b) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b

    x1 = max(ax1, bx1)
    y1 = max(ay1, by1)
    x2 = min(ax2, bx2)
    y2 = min(ay2, by2)

    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)

    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)

    union = area_a + area_b - inter

    return inter / union if union > 0 else 0.0


def classwise_nms(detections: List[Dict[str, Any]], iou_threshold: float = 0.5):
    """
    클래스별로만 중복을 정리한다.

    클래스를 섞어 한 번에 누르면 겹쳐 놓인 서로 다른 기호(문 위에 붙은 비상구
    픽토그램 같은 것) 중 하나가 사라진다. 지금은 클래스마다 담당 모델이 하나뿐이라
    모델 사이의 중복은 생기지 않지만, 한 모델이 같은 기호를 두 번 잡는 일은 여전히 있다.
    """
    final = []

    for class_id in range(len(CLASS_NAMES)):
        items = [d for d in detections if d["class_id"] == class_id]

        items.sort(key=lambda x: x["confidence"], reverse=True)

        keep: List[Dict[str, Any]] = []

        for det in items:
            if all(
                iou_xyxy(det["bbox_xyxy"], kept["bbox_xyxy"]) < iou_threshold
                for kept in keep
            ):
                keep.append(det)

        final.extend(keep)

    final.sort(key=lambda x: (x["class_id"], -x["confidence"]))

    return final


def resolve_weights(models_dir: Path, model_name: str, model_path: str) -> Path:
    """
    라우팅 표가 가리키는 가중치를 `models/` 안에서 찾는다.

    표의 `model_path` 는 학습 환경(코랩)의 절대경로다. 경로를 그대로 믿으면 어느
    기계에서도 뜨지 않으니 이름으로 찾는데, 학습 쪽 파일 이름이
    `runs/stage_a/weights/best.pt` 처럼 **라운드가 달라도 똑같은** 경우가 있다.
    그래서 `{model_name}_best.pt` 를 먼저 본다 — 꾸러미로 받을 때 이 이름으로
    풀리고, `model_hashes.json` 도 이 이름으로 적혀 있다.
    """
    candidates = [
        models_dir / f"{model_name}_best.pt",
        models_dir / Path(model_path).name,
    ]

    for candidate in candidates:
        if candidate.exists():
            return candidate

    raise FileNotFoundError(
        f"가중치를 찾지 못했습니다 (담당 모델 {model_name}).\n"
        f"찾아본 곳: {', '.join(str(c) for c in candidates)}\n"
        f"학습에서 받은 파일을 {models_dir} 에 두세요."
    )


def load_router(models_dir: Union[str, Path]) -> Dict[int, Dict[str, Any]]:
    """
    `class_router.json` 을 읽어 `{class_id: {model_name, weights, threshold, metrics}}` 로.
    """
    models_dir = Path(models_dir)
    router_path = models_dir / ROUTER_FILENAME

    if not router_path.exists():
        raise FileNotFoundError(
            f"라우팅 표가 없습니다: {router_path}\n"
            f"학습에서 받은 class_router.json 을 models/ 에 두세요."
        )

    raw = json.loads(router_path.read_text(encoding="utf-8"))

    routes: Dict[int, Dict[str, Any]] = {}

    for class_name, entry in raw.items():
        if class_name not in CLASS_NAMES:
            raise RuntimeError(
                f"라우팅 표에 모르는 클래스가 있습니다: {class_name}\n"
                f"아는 클래스={CLASS_NAMES}"
            )

        class_id = int(entry["class_id"])
        expected_id = CLASS_NAMES.index(class_name)

        # 표의 class_id 와 학습된 순서가 어긋나면 담당 배정이 통째로 밀린다
        if class_id != expected_id:
            raise RuntimeError(
                f"라우팅 표의 class_id 가 클래스 순서와 어긋납니다: "
                f"{class_name} 은 {expected_id} 여야 하는데 표에는 {class_id} 입니다."
            )

        model_name = str(entry.get("model_name") or Path(entry["model_path"]).stem)
        weights = resolve_weights(models_dir, model_name, entry["model_path"])

        routes[class_id] = {
            "class_name": class_name,
            "model_name": model_name,
            "weights": weights,
            "threshold": float(entry.get("threshold", 0.0)),
            "metrics": entry.get("val_metrics") or {},
        }

    missing = [name for idx, name in enumerate(CLASS_NAMES) if idx not in routes]

    if missing:
        raise RuntimeError(
            f"라우팅 표에 담당이 없는 클래스가 있습니다: {missing}\n"
            f"담당이 비면 그 기호는 영영 탐지되지 않는데, 없는 것과 구분되지 않습니다."
        )

    return routes


def verify_hashes(models_dir: Union[str, Path], weight_paths: Iterable[Path]) -> List[str]:
    """
    `model_hashes.json` 과 실제 파일을 대조해 어긋난 것들의 설명을 돌려준다.

    막지는 않는다 — 가중치를 새로 학습해 갈아 끼우는 것은 정상적인 일이다. 다만
    라우팅 표의 지표는 그 가중치로 잰 값이라, 파일이 바뀌었으면 지표도 더 이상
    이 파일 것이 아니다. 그 사실을 로그와 `/health` 로 알린다.
    """
    models_dir = Path(models_dir)
    hashes_path = models_dir / HASHES_FILENAME

    if not hashes_path.exists():
        return []

    recorded = json.loads(hashes_path.read_text(encoding="utf-8"))
    warnings: List[str] = []

    for path in weight_paths:
        expected = recorded.get(path.name)

        if not expected:
            continue

        actual = hashlib.sha256(path.read_bytes()).hexdigest()

        if actual != expected:
            warnings.append(
                f"{path.name} 이 학습 때와 다른 파일입니다 "
                f"(기록 {expected[:12]}…, 실제 {actual[:12]}…). "
                f"라우팅 표의 지표는 이 파일로 잰 값이 아닙니다."
            )

    return warnings


class RoutedEvacuationDetector:
    def __init__(
        self,
        models_dir: Union[str, Path],
        imgsz: int = 1280,
        conf: float = 0.25,
        iou: float = 0.5,
        device: str = "cpu",
        enforce_router_thresholds: bool = False,
    ):
        self.models_dir = Path(models_dir)
        self.routes = load_router(self.models_dir)

        self.imgsz = imgsz
        self.conf = conf
        self.iou = iou
        self.device = device
        self.enforce_router_thresholds = enforce_router_thresholds

        # 한 가중치를 여러 클래스가 맡는다. 파일별로 한 번만 적재하고 한 번만 돌린다 —
        # 클래스마다 돌리면 사진 한 장에 여덟 번 추론하게 되어 CPU 로는 못 쓴다.
        self._groups: Dict[Path, List[int]] = {}

        for class_id, route in sorted(self.routes.items()):
            self._groups.setdefault(route["weights"], []).append(class_id)

        self.hash_warnings = verify_hashes(self.models_dir, self._groups.keys())

        for warning in self.hash_warnings:
            print(f"[detector] 주의: {warning}")

        self._models: Dict[Path, YOLO] = {}

        for weights in self._groups:
            model = YOLO(str(weights))
            self._validate_class_order(model, weights)
            self._models[weights] = model

    def _names_list(self, model) -> List[str]:
        names = model.names

        if isinstance(names, dict):
            return [names[i] for i in range(len(names))]

        return list(names)

    def _validate_class_order(self, model, weights: Path):
        found = self._names_list(model)

        if found != CLASS_NAMES:
            raise RuntimeError(
                f"클래스 순서가 어긋납니다: {weights.name}\n"
                f"기대={CLASS_NAMES}\n"
                f"실제={found}"
            )

    def describe(self) -> Dict[str, Any]:
        """`/health` 가 보여줄 담당 표."""
        return {
            "models": sorted({w.name for w in self._groups}),
            "routes": [
                {
                    "classId": class_id,
                    "className": route["class_name"],
                    "model": route["model_name"],
                    "weights": route["weights"].name,
                    "threshold": route["threshold"],
                    "recall": route["metrics"].get("recall"),
                }
                for class_id, route in sorted(self.routes.items())
            ],
            "hashWarnings": self.hash_warnings,
        }

    def _convert_result(self, result, allowed_classes, weights: Path):
        detections = []

        if result.boxes is None or len(result.boxes) == 0:
            return detections

        xyxy = result.boxes.xyxy.detach().cpu().numpy()
        conf = result.boxes.conf.detach().cpu().numpy()
        cls = result.boxes.cls.detach().cpu().numpy().astype(int)

        allowed = set(allowed_classes)

        for box, score, class_id in zip(xyxy, conf, cls):
            class_id = int(class_id)

            # 이 모델이 맡지 않은 클래스는 버린다. 낼 수는 있지만, 그 클래스는
            # 다른 모델이 더 잘 잡는다고 라우팅 표가 정해 둔 것이다.
            if class_id not in allowed:
                continue

            route = self.routes[class_id]
            score = float(score)

            if self.enforce_router_thresholds and score < route["threshold"]:
                continue

            detections.append({
                "class_id": class_id,
                "class_name": CLASS_NAMES[class_id],
                "confidence": score,
                "bbox_xyxy": [float(v) for v in box.tolist()],
                "source_model": route["model_name"],
                # 이 확신도가 검증 문턱을 넘었는지. 넘지 못한 탐지도 그대로 올려
                # 보내되(놓친 출구는 사람이 알아채지 못한다), 표시는 다르게 할 수 있게 한다.
                "router_threshold": route["threshold"],
                "above_router_threshold": score >= route["threshold"],
            })

        return detections

    def predict(self, image_path: Union[str, Path]):
        image_path = Path(image_path)

        detections: List[Dict[str, Any]] = []

        for weights, class_ids in self._groups.items():
            result = self._models[weights].predict(
                source=str(image_path),
                imgsz=self.imgsz,
                conf=self.conf,
                iou=self.iou,
                device=self.device,
                verbose=False,
            )[0]

            detections += self._convert_result(result, class_ids, weights)

        return classwise_nms(detections, self.iou)

    def annotate(
        self,
        image_path: Union[str, Path],
        output_path: Union[str, Path],
    ):
        image_path = Path(image_path)
        output_path = Path(output_path)

        image = cv2.imread(str(image_path))

        if image is None:
            raise RuntimeError(f"Failed to read image: {image_path}")

        detections = self.predict(image_path)

        for det in detections:
            x1, y1, x2, y2 = [int(v) for v in det["bbox_xyxy"]]

            label = f'{det["class_name"]} {det["confidence"]:.2f}'

            cv2.rectangle(image, (x1, y1), (x2, y2), (0, 255, 0), 2)

            cv2.putText(
                image,
                label,
                (x1, max(20, y1 - 5)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                (0, 0, 0),
                2,
                cv2.LINE_AA,
            )

        output_path.parent.mkdir(parents=True, exist_ok=True)

        if not cv2.imwrite(str(output_path), image):
            raise RuntimeError(f"Failed to save annotated image: {output_path}")

        return detections
