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

`figs/` 의 다섯 장은 손으로 그린 것이 아니라 데이터·가중치로 **다시 만든 것**이다.
숫자를 고치거나 그림을 새로 뽑아야 하면 아래를 다시 돌리면 된다.

| 그림 | 만든 방법 | 재료가 저장소에 |
| --- | --- | --- |
| `synthetic-samples.jpg`, `label-zoom.jpg` | `ml-colab.zip` 의 합성 도면과 YOLO 라벨을 겹쳐 그림 | 없음 |
| `detect-draft-*.jpg` | `ml/detector` 의 가중치로 `촬영도면/` 사진을 추론 (imgsz 1280, conf 0.25) | 가중치만 |
| `filtered-draft-*.jpg` | 위 결과에 `backend/src/planReader/graph.js` 의 걸름망(크기·범례)을 그대로 적용 | 가중치·규칙만 |

**`ml-colab.zip` 과 `촬영도면/` 은 `.gitignore` 에 있다** — 새로 클론한 사람은 그림을 다시
뽑을 수 없다. 두 폴더가 없어도 문서는 그대로 열리지만(그림이 `figs/` 에 이미 있으므로),
숫자를 고치려면 원본을 가진 사람이 돌려야 한다. `backend/data/plans.json` 에 박힌 사진
10장으로 대신할 수는 없다 — **다른 건물의 안내도라 문서의 그림과 이어지지 않는다.**

지표 표는 `ml/detector/models/allclass_selection_report.json`, 서비스에 붙은 가중치의
학습 설정은 **가중치 파일 안의 `train_args`** 에서 읽어 옮겼다. 다시 뽑으려면:

```bash
cd ml/detector && .venv/Scripts/python -c "import torch; print(torch.load('models/round2_best.pt', map_location='cpu', weights_only=False)['train_args'])"
```

학습 노트북과 합성 생성기는 `ml/` 에 있다 — 무엇이 어느 가중치를 냈는지는
[../ml/README.md](../ml/README.md) 에 정리해 두었다. 1부 설정(150에폭 · `imgsz=800` ·
`fliplr=0.0`)은 `ml/train_colab.ipynb` 과 정확히 일치하는 것을 확인했다.

라운드별 이어학습 설정은 `ml/training-records/*/args.yaml` 에서 그대로 옮겼다. 문서가
전에 "2부 · `lr0=0.002` · 60에폭"이라고 적어 둔 값은 **어느 노트북에도 어느 `args.yaml`에도
없었다** — 실제로는 2단계가 아니라 라운드 2·4·6에 걸친 다섯 번의 이어학습이었고, 지금은
그 실제 값으로 바뀌어 있다.

같은 확인 과정에서 나온 정정 하나 더: 실제 대피안내도는 **라운드 2~4의 학습에 들어갔지만**
(원본 13종을 촬영환경별로 208장으로 늘린 것, 사람이 검수한 라벨), **마지막 라운드 6의
학습·검증 500장은 전부 합성**이다. 그래서 재현율 1.000은 합성 검증셋 기준이지 실제
사진에서의 성능이 아니다. 문서의 도장·학습 절차 절·고지가 이 구분에 맞춰 고쳐져 있고,
근거는 [../ml/README.md](../ml/README.md) 의 "실제 사진은 어디까지 들어갔나"에 있다.

나머지 출처는 문서 맨 아래에 재현 가능 여부와 함께 적어 두었다.

`index.html` 은 그림을 `figs/` 에서 상대경로로 읽는 자족 문서다. 웹으로 공유한 사본은
같은 내용에 그림만 data URI 로 심어 한 파일로 만든 것이다.
