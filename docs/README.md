# 발표자료

발표·공유용 정적 문서. 앱 코드와 섞이지 않게 여기에 따로 둔다.

```bash
npm run docs     # http://localhost:3030
```

백엔드·프론트가 떠 있지 않아도 열린다 — 발표 중에 앱을 재시작해도 문서는 안 끊긴다.
같은 망에 있는 팀원은 띄운 PC의 IP 로 접속하면 된다 (`http://192.168.x.x:3030`).

| 문서 | 주소 | 내용 |
| --- | --- | --- |
| [ai-training/](ai-training/) | `/ai-training/` | 피난안내도 기호 탐지 모델 — 학습 데이터·클래스별 지표·실측 탐지 결과 |

## ai-training/ 의 그림은 어디서 나왔나

`figs/` 의 다섯 장은 손으로 그린 것이 아니라 저장소의 데이터·가중치로 **다시 만든 것**이다.
숫자를 고치거나 그림을 새로 뽑아야 하면 아래를 다시 돌리면 된다.

| 그림 | 만든 방법 |
| --- | --- |
| `synthetic-samples.jpg`, `label-zoom.jpg` | `ml-colab.zip` 의 합성 도면과 YOLO 라벨을 겹쳐 그림 |
| `detect-draft-*.jpg` | `ml/detector` 의 가중치로 `촬영도면/` 사진을 추론 (imgsz 1280, conf 0.25) |
| `filtered-draft-*.jpg` | 위 결과에 `backend/src/planReader/graph.js` 의 걸름망(크기·범례)을 그대로 적용 |

지표 표는 `round6_models_for_vscode.zip / allclass_selection_report.json`,
학습 설정은 `ml/train_colab.ipynb` 에서 옮겨 적었다. 출처는 문서 맨 아래에도 적어 두었다.

`index.html` 은 그림을 `figs/` 에서 상대경로로 읽는 자족 문서다. 웹으로 공유한 사본은
같은 내용에 그림만 data URI 로 심어 한 파일로 만든 것이다.
