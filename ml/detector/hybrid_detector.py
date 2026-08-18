
from pathlib import Path
from typing import List, Dict, Any, Union

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

ROUND2_CLASSES = {0, 2, 3, 4, 6, 7}
ROUND4_CLASSES = {1, 5}


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
    final = []

    for class_id in range(len(CLASS_NAMES)):
        items = [
            d for d in detections
            if d["class_id"] == class_id
        ]

        items.sort(
            key=lambda x: x["confidence"],
            reverse=True
        )

        keep = []

        for det in items:
            if all(
                iou_xyxy(
                    det["bbox_xyxy"],
                    kept["bbox_xyxy"]
                ) < iou_threshold
                for kept in keep
            ):
                keep.append(det)

        final.extend(keep)

    final.sort(
        key=lambda x: (
            x["class_id"],
            -x["confidence"]
        )
    )

    return final


class HybridEvacuationDetector:
    def __init__(
        self,
        round2_model: Union[str, Path],
        round4_model: Union[str, Path],
        imgsz: int = 768,
        conf_round2: float = 0.25,
        conf_round4: float = 0.25,
        iou: float = 0.5,
        device: str = "cpu",
    ):
        self.round2_model_path = Path(round2_model)
        self.round4_model_path = Path(round4_model)

        if not self.round2_model_path.exists():
            raise FileNotFoundError(
                f"Round2 model not found: {self.round2_model_path}"
            )

        if not self.round4_model_path.exists():
            raise FileNotFoundError(
                f"Round4 model not found: {self.round4_model_path}"
            )

        self.round2 = YOLO(str(self.round2_model_path))
        self.round4 = YOLO(str(self.round4_model_path))

        self.imgsz = imgsz
        self.conf_round2 = conf_round2
        self.conf_round4 = conf_round4
        self.iou = iou
        self.device = device

        self._validate_class_order()

    def _names_list(self, model):
        names = model.names

        if isinstance(names, dict):
            return [
                names[i]
                for i in range(len(names))
            ]

        return list(names)

    def _validate_class_order(self):
        r2_names = self._names_list(self.round2)
        r4_names = self._names_list(self.round4)

        if r2_names != CLASS_NAMES:
            raise RuntimeError(
                f"Round2 class order mismatch.\n"
                f"expected={CLASS_NAMES}\n"
                f"found={r2_names}"
            )

        if r4_names != CLASS_NAMES:
            raise RuntimeError(
                f"Round4 class order mismatch.\n"
                f"expected={CLASS_NAMES}\n"
                f"found={r4_names}"
            )

    def _convert_result(
        self,
        result,
        allowed_classes,
        source_model: str,
    ):
        detections = []

        if result.boxes is None or len(result.boxes) == 0:
            return detections

        xyxy = result.boxes.xyxy.detach().cpu().numpy()
        conf = result.boxes.conf.detach().cpu().numpy()
        cls = result.boxes.cls.detach().cpu().numpy().astype(int)

        for box, score, class_id in zip(
            xyxy,
            conf,
            cls,
        ):
            if class_id not in allowed_classes:
                continue

            detections.append({
                "class_id": int(class_id),
                "class_name": CLASS_NAMES[int(class_id)],
                "confidence": float(score),
                "bbox_xyxy": [
                    float(v)
                    for v in box.tolist()
                ],
                "source_model": source_model,
            })

        return detections

    def predict(self, image_path: Union[str, Path]):
        image_path = Path(image_path)

        r2 = self.round2.predict(
            source=str(image_path),
            imgsz=self.imgsz,
            conf=self.conf_round2,
            iou=self.iou,
            device=self.device,
            verbose=False,
        )[0]

        r4 = self.round4.predict(
            source=str(image_path),
            imgsz=self.imgsz,
            conf=self.conf_round4,
            iou=self.iou,
            device=self.device,
            verbose=False,
        )[0]

        detections = []

        detections += self._convert_result(
            r2,
            ROUND2_CLASSES,
            "round2"
        )

        detections += self._convert_result(
            r4,
            ROUND4_CLASSES,
            "round4"
        )

        return classwise_nms(
            detections,
            self.iou
        )

    def annotate(
        self,
        image_path: Union[str, Path],
        output_path: Union[str, Path],
    ):
        image_path = Path(image_path)
        output_path = Path(output_path)

        image = cv2.imread(str(image_path))

        if image is None:
            raise RuntimeError(
                f"Failed to read image: {image_path}"
            )

        detections = self.predict(image_path)

        for det in detections:
            x1, y1, x2, y2 = [
                int(v)
                for v in det["bbox_xyxy"]
            ]

            label = (
                f'{det["class_name"]} '
                f'{det["confidence"]:.2f}'
            )

            cv2.rectangle(
                image,
                (x1, y1),
                (x2, y2),
                (0, 255, 0),
                2,
            )

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

        output_path.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        if not cv2.imwrite(
            str(output_path),
            image
        ):
            raise RuntimeError(
                f"Failed to save annotated image: {output_path}"
            )

        return detections
