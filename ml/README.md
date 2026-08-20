# 학습 기록

`ml/detector/` 의 가중치가 **어디서 왔는지**를 남긴 곳이다. 여기 있는 것으로 학습을
그대로 다시 돌릴 수는 없지만(데이터셋 원본은 저장소에 없다), 문서에 적힌 숫자가
어디서 나온 값인지는 전부 여기서 확인된다.

이걸 남기는 이유: 발표 문서가 "재현율 1.000"이라고 적어 두었는데, 그 숫자가 어떤
설정으로 어떤 분할에서 나온 것인지 확인할 방법이 없으면 **믿을 이유도 없다.**

## 무엇이 어디에

| 경로 | 내용 |
|---|---|
| `generate_dataset.py` | 합성 피난안내도 생성기. 도면을 그리면서 그 좌표를 그대로 라벨로 적는다 |
| `train_colab.ipynb` | 1부 사전학습 노트북 (합성 100장 · 150에폭 · imgsz 800) |
| `notebooks/` | 라운드별 학습 노트북 (출력은 지웠다 — 아래 참고) |
| `training-records/<라운드>_<단계>/` | 그 실행의 `args.yaml`(전체 설정)과 `results.csv`(에폭별 지표) |
| `training-records/data/` | 데이터셋 `*.yaml` 과 라운드 6 분할·균형 리포트 |

## 지금 서비스에 붙어 있는 가중치의 계보

`ml/detector/models/` 의 세 파일이 각각 어느 실행에서 나왔는지다. **가중치 안에 저장된
`train_args` 와 아래 `args.yaml` 이 전부 일치하는 것을 확인했다** (에폭·imgsz·batch·lr0·
patience·freeze·fliplr·mosaic·degrees·model·data 11개 항목).

| 가중치 | 낸 실행 | 노트북 | 에폭 |
|---|---|---|---|
| `round2_best.pt` | `training-records/round4_stage_b/` | `notebooks/05_round4_clean.ipynb` | 35 |
| `stage_a_best.pt` | `training-records/round6_stage_a/` | `notebooks/08_round6_allclass_recall.ipynb` | 18 |
| `stage_b_best.pt` | `training-records/round6_stage_b/` | `notebooks/08_round6_allclass_recall.ipynb` | 30 |

파일 이름과 실행 이름이 어긋나 보이는 것은 오타가 아니다 — `round2_best.pt` 는
**라운드 4의 stage_b** 산출물인데 이름만 앞 라운드 것을 물려받았다.

직접 대조하려면:

```bash
cd ml/detector
.venv/Scripts/python -c "import torch; a=torch.load('models/round2_best.pt', map_location='cpu', weights_only=False)['train_args']; print({k:a[k] for k in ['epochs','imgsz','lr0','fliplr','freeze']})"
cat ../training-records/round4_stage_b/args.yaml | grep -E '^(epochs|imgsz|lr0|fliplr|freeze):'
```

## 라운드 6 지표는 어떤 분할에서 나온 값인가

`training-records/data/round6_split_report.json` 에 있다. 이 500장이 어떤 성격인지는
아래 "실제 사진은 어디까지 들어갔나"에서 따로 다룬다.

| 분할 | 이미지 | 상자 |
|---|---:|---:|
| train | 350 | 9,995 |
| val | 75 | 2,166 |
| test | 75 | 2,161 |

`ml/detector/models/allclass_selection_report.json` 의 클래스별 TP+FN 이 이 표의 상자 수와
8클래스 × val·test 전부 맞는다(예: exit val 150개 = TP 150 + FN 0). 지표가 이 분할에서
나온 값이 맞다는 뜻이다.

**주의**: 발표 문서의 "합성 100장 · 라벨 3,142개"는 **1부** 데이터셋이다. 서비스에 붙은
가중치는 위 500장으로 학습됐다. 두 숫자를 섞어 읽으면 안 된다.

## 실제 사진은 어디까지 들어갔나

한마디로: **실제 대피안내도는 학습에 들어갔고, 마지막 라운드만 합성으로 되돌아갔다.**

| 라운드 | 데이터 | 낸 가중치 |
|---|---|---|
| 2 | 실제 대피안내도 + **사람이 검수한 라벨** | |
| 3 | 공개 라이선스 실제 도면 추가. `critical`=사람 검수, `auto`=자동 pseudo-label | |
| 4 | 라운드 2 사람검수 라벨 + 계단 보강용 합성 | `round2_best.pt` |
| 6 | **합성 500장** (전 클래스 균형 보정) | `stage_a_best.pt` · `stage_b_best.pt` |

실제 사진의 규모는 `01_finetune_e140.ipynb` 에 적혀 있다: **실제 원본 13종**을 촬영환경별로
변형해 208장으로 늘린 것이다. 원본이 13종뿐이라는 점이 지금 일반화의 한계다 — 학습에 없던
양식의 도면에서 비상구를 놓치는 이유가 여기 있다.

### 라운드 6 지표를 읽는 법

`training-records/data/round6_split_report.json` 의 500장은 **전부 합성**이다. 근거:

- 검증 75장 하나하나에 8클래스가 빠짐없이 들어 있다
- 문(`door`)과 실(`room`) 개수가 분할마다 정확히 같다 (3600=3600, 782=782, 779=779)
- 계단·승강기·현위치가 이미지당 정확히 1.00개

전부 생성기의 규칙이지 실제 도면에서 나올 분포가 아니다. 그래서 **재현율 1.000은 합성
검증셋 기준**이고, 실제 사진에서의 성능이 아니다. 발표 문서의 실측 절이 같은 사진으로
따로 잰 값을 싣고 있다.

라운드 3 `auto` 갈래는 노트북이 직접 "val/test도 자동 pseudo-label이므로 최종 P/R/mAP은
참고값"이라고 적어 두었다. 그 숫자를 사람 검수 정답 기준 성능으로 인용하면 안 된다.

### 다음 학습

`09_round7_realworld_builder.ipynb` 가 적어 둔 순서를 그대로 따르면 된다:

> 외부 원본은 아직 human-GT가 아니므로 바로 fine-tuning에 넣기보다는 ①라운드 6 예측 확인
> ②잘못된 박스만 수정하여 GT 확정 ③source 단위 분할 ④실제 원본 중심 fine-tuning 순서가 안전합니다

그때 `fliplr=0.0` 을 명시하는 것도 잊지 말 것(아래).

## 도면을 좌우로 뒤집는 증강 — 켜져 있다

1부 노트북에는 이렇게 적혀 있고, 이유도 맞다:

```python
fliplr=0.0,       # 도면을 좌우로 뒤집으면 글자가 거울상이 된다
flipud=0.0,
```

그런데 지금 가중치 세 벌은 모두 `fliplr` 이 켜져 있다. 어디서 깨졌는지도 남아 있다:

| 라운드 | `fliplr` | |
|---|---|---|
| 1부 · 라운드 3 | `0.0` 명시 | 원칙대로 |
| 라운드 4 | **파라미터를 안 적음** | Ultralytics 기본값 `0.5` 가 적용됨 |
| 라운드 6 | `.15` · `.10` 명시 | 0 으로 되돌리지 않음 |

**원칙을 뒤집은 게 아니라 라운드 4에서 한 줄을 빠뜨려 기본값이 되살아난 것이다.**
다음 학습 때 `fliplr=0.0` 을 명시적으로 넣어야 한다 — 기본값에 기대면 같은 일이 또 난다.

## 데이터셋을 다시 만들려면

```bash
python ml/generate_dataset.py --count 100 --size 800 --val 0.2 --test 0.1 --seed 20260814
```

시드가 고정이라 같은 100장이 다시 나온다. 발표 문서의 클래스 분포·라벨 수는 이 설정으로
만든 것에서 집계한 값이다.

## 노트북 출력을 지운 것에 대해

`notebooks/` 의 노트북은 **실행 출력을 지우고** 넣었다. 학습 로그가 통째로 박혀 있어
한 파일이 4.2MB였는데, 코드는 26KB다. 지표는 `training-records/*/results.csv` 에 같은 값이 더 다루기
쉬운 형태로 남아 있으므로 잃은 것이 없다.

`train_colab.ipynb`(1부)만 원본 그대로다 — 원래 27KB라 지울 이유가 없었다.

## 꾸러미에 있었지만 넣지 않은 것

`yolo_training_evidence.zip` 에는 있었으나 여기 없는 것들이다. 꾸러미는 `.gitignore` 에
있으니, 필요하면 거기서 꺼내면 된다.

| 뺀 것 | 이유 |
|---|---|
| `19_train_train50000_premium_e16_feather_asr_boost_v1_...ipynb` | **다른 프로젝트다.** 음성 인식(ASR) 학습 노트북이라 여기와 무관하다 |
| `generate_dataset.py` 의 이전 판 2개 | 복도 구조·용도 사전·대피 그래프가 없는 초기판. 문서가 설명하는 생성기는 지금 것 |
| 라운드 2·4a·5 의 `results.png` · `confusion_matrix.png` | 각 350KB. 그림은 **서비스에 붙은 가중치를 낸 실행 3개만** 남겼다 |
| `train_colab.ipynb` 의 중복본 | 코드가 거의 같은 판이 둘 있었다 |
