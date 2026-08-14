/**
 * 대피도 촬영 — 이 앱의 유일한 상시 화면.
 *
 * 신분증 촬영 UX 를 따랐다. 사각 틀을 두고, 폰이 똑바로 서면 테두리가
 * 초록으로 바뀌며 확인음이 난다. 다른 앱에서 이미 익힌 동작이라
 * 설명 없이도 무엇을 해야 할지 안다.
 *
 * ## 접근성
 *
 * 건축 담당자·보호자·일반 사용자가 주로 쓰지만, 시각장애인이 열 수도 있다.
 * 그래서 정렬 상태를 **말로도** 안내한다("오른쪽으로 살짝 기울었습니다").
 * 상태가 바뀌는 순간에만 말한다 — 계속 떠들면 아무도 안 듣는다.
 */

import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Animated, Pressable, StyleSheet, Text, View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Accelerometer } from 'expo-sensors';
import * as ImagePicker from 'expo-image-picker';

import { BearingSensor } from '../bearing';
import { guideRect, mapRectToPhoto } from '../crop';
import { evaluate, score, looksLikePlan } from '../alignment';
import { chimeLocked, chimeReject } from '../sound';
import { say } from '../announce';
import { cueLocked, cueReject } from '../haptics';
import { theme } from '../theme';

/** 정렬이 이만큼 유지돼야 "맞았다"로 본다 — 지나가다 스친 순간을 배제한다 */
const HOLD_MS = 350;

/**
 * 틀의 크기·비율. 화면에 그리는 값과 잘라내는 값이 **같은 상수**를 봐야 한다.
 * 한쪽만 바꾸면 보이는 틀과 저장되는 영역이 어긋나고, 사용자는 알아챌 수 없다.
 */
const FRAME_WIDTH_RATIO = 0.86;
const FRAME_ASPECT = 4 / 3;

export default function CaptureScreen({ onCaptured, onSimulateFire, shotCount = 0, serverOnline = false }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [aligned, setAligned] = useState(false);
  const [hint, setHint] = useState('도면을 틀 안에 맞춰주세요');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState({ width: 0, height: 0 });

  const cameraRef = useRef(null);
  // 피난안내도는 벽에 붙어 있고, 찍는 사람은 그 벽을 바라보고 서 있다.
  // 그러니 촬영 순간의 나침반은 **공짜로 얻는 기준점**이다 — UI 가 필요 없다.
  const bearing = useRef(new BearingSensor()).current;
  const glow = useRef(new Animated.Value(0)).current;
  const alignedSince = useRef(0);
  const lastHint = useRef('');
  const lastAligned = useRef(false);

  // ---------------------------------------------------- 자세 감지
  useEffect(() => {
    bearing.start(120);
    Accelerometer.setUpdateInterval(120);
    const sub = Accelerometer.addListener(g => {
      const res = evaluate(g);
      const s = score(g);
      Animated.timing(glow, {
        toValue: s, duration: 140, useNativeDriver: false,
      }).start();

      const now = Date.now();
      if (res.ok) {
        if (!alignedSince.current) alignedSince.current = now;
      } else {
        alignedSince.current = 0;
      }
      const held = alignedSince.current && now - alignedSince.current >= HOLD_MS;

      if (held !== lastAligned.current) {
        lastAligned.current = held;
        setAligned(held);
        if (held) {
          chimeLocked();
          cueLocked();
          say('틀에 맞았습니다. 촬영하세요.', { force: true });
        }
      }
      if (!held && res.hint !== lastHint.current) {
        lastHint.current = res.hint;
        setHint(res.hint);
        say(res.hint);
      }
    });
    return () => { sub.remove(); bearing.stop(); };
  }, []);

  // ---------------------------------------------------- 촬영·불러오기
  async function capture() {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.9 });
      const cropped = await cropToFrame(photo);
      onCaptured?.({
        ...cropped,
        source: 'camera',
        aligned: true,
        captureHeading: bearing.heading,   // 벽을 바라본 방향
      });
      // 확인 화면이 직접 안내하므로 여기서는 말하지 않는다 (두 목소리가 겹친다)
    } catch (e) {
      Alert.alert('촬영 실패', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * 화면의 틀 안만 잘라낸다.
   *
   * 실패하면 원본을 그대로 쓴다 — 자르기가 안 됐다고 애써 찍은 사진을 버릴 수는 없다.
   * 대신 판독 정확도가 떨어지므로, 되도록 성공해야 한다.
   */
  async function cropToFrame(photo) {
    try {
      const rect = mapRectToPhoto(
        preview, photo, guideRect(preview, FRAME_WIDTH_RATIO, FRAME_ASPECT),
      );
      if (!rect) return photo;

      const ctx = ImageManipulator.manipulate(photo.uri);
      ctx.crop(rect);
      const img = await ctx.renderAsync();
      const out = await img.saveAsync({ compress: 0.85, format: SaveFormat.JPEG });
      return { ...photo, uri: out.uri, width: out.width, height: out.height };
    } catch (_) {
      return photo;
    }
  }

  async function pickFromLibrary() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('권한 필요', '사진 접근을 허용해야 도면을 불러올 수 있습니다.');
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({ quality: 0.85 });
    if (res.canceled) return;
    const asset = res.assets[0];

    // 명백히 도면이 아닌 것만 걸러낸다. 애매하면 사용자에게 묻는다 —
    // 판별 AI 를 학습시키려고 사진을 모으는 중이라, 지금 엄격하면 데이터가 안 쌓인다.
    const { verdict, reason } = looksLikePlan(asset);
    if (verdict === 'reject') {
      chimeReject(); cueReject();
      Alert.alert('이 사진은 어려워 보입니다', reason);
      return;
    }
    Alert.alert(
      '이 사진이 대피도가 맞나요?',
      '맞으면 등록하고, 아니면 취소해주세요.',
      [
        { text: '취소', style: 'cancel' },
        {
          text: '대피도가 맞습니다',
          onPress: () => onCaptured?.({ ...asset, source: 'library', aligned: false }),
        },
      ],
    );
  }

  // ---------------------------------------------------- 권한
  if (!permission) {
    return <Center><ActivityIndicator color={theme.accent} /></Center>;
  }
  if (!permission.granted) {
    return (
      <Center>
        <Text style={styles.permTitle}>카메라 권한이 필요합니다</Text>
        <Text style={styles.permBody}>
          건물의 피난안내도를 찍어 대피 경로를 만듭니다.
        </Text>
        <Pressable style={styles.primaryBtn} onPress={requestPermission}
                   accessibilityRole="button" accessibilityLabel="카메라 권한 허용">
          <Text style={styles.primaryBtnText}>권한 허용</Text>
        </Pressable>
      </Center>
    );
  }

  const frame = guideRect(preview, FRAME_WIDTH_RATIO, FRAME_ASPECT);

  const borderColor = glow.interpolate({
    inputRange: [0, 0.6, 1],
    outputRange: [theme.border, theme.warn, theme.ok],
  });

  return (
    <View style={styles.root}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        onLayout={e => setPreview({
          width: e.nativeEvent.layout.width,
          height: e.nativeEvent.layout.height,
        })}
      />

      {/* 틀 바깥을 덮는다. "이 안만 저장된다"를 말로 설명하는 대신 보여준다 —
          예전에는 틀이 화면에만 있고 저장은 전체가 돼서, 사용자가 맞췄다고 믿는
          것과 실제로 남는 것이 달랐다. */}
      {frame.width > 0 && (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <View style={[styles.mask, { top: 0, left: 0, right: 0, height: frame.y }]} />
          <View style={[styles.mask, { top: frame.y + frame.height, left: 0, right: 0, bottom: 0 }]} />
          <View style={[styles.mask, { top: frame.y, left: 0, width: frame.x, height: frame.height }]} />
          <View style={[styles.mask, { top: frame.y, right: 0, width: frame.x, height: frame.height }]} />
        </View>
      )}

      <View style={styles.overlay} pointerEvents="none">
        <Animated.View style={[
          styles.frame,
          {
            width: frame.width || undefined,
            height: frame.height || undefined,
            borderColor,
            shadowColor: aligned ? theme.ok : 'transparent',
          },
        ]} />
      </View>

      <View style={styles.header} pointerEvents="none">
        <Text style={styles.title}>피난안내도 촬영</Text>
        <Text style={[styles.hint, aligned && styles.hintOk]}>
          {aligned ? '✓ 틀에 맞았습니다 — 촬영하세요' : hint}
        </Text>
      </View>

      <View style={styles.footer}>
        {/* 서버 상태를 조용히 보여준다. 끊겼다는 걸 화재 때 알면 늦다. */}
        <Text style={styles.conn} accessibilityLabel={serverOnline ? '서버 연결됨' : '서버 연결 끊김. 촬영은 가능하지만 대피 안내는 쓸 수 없습니다'}>
          {serverOnline ? '● 서버 연결됨' : '○ 서버 연결 안 됨 — 촬영만 가능'}
        </Text>

        {shotCount > 0 && (
          <Text style={styles.count} accessibilityLabel={`지금까지 ${shotCount}장 등록`}>
            {shotCount}장 등록됨
          </Text>
        )}

        <Pressable
          style={[styles.shutter, aligned ? styles.shutterOn : styles.shutterOff]}
          onPress={capture}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={aligned ? '촬영. 틀에 맞았습니다' : '촬영. 아직 틀에 맞지 않았습니다'}
          accessibilityHint="도면 사진을 등록합니다"
        >
          {busy ? <ActivityIndicator color="#000" />
                : <View style={styles.shutterInner} />}
        </Pressable>

        <Pressable style={styles.linkBtn} onPress={pickFromLibrary}
                   accessibilityRole="button" accessibilityLabel="사진 앨범에서 도면 불러오기">
          <Text style={styles.linkText}>앨범에서 불러오기</Text>
        </Pressable>

        {/* 온도 센서가 아직 없으므로, 서버 신호를 흉내내 전체 흐름을 시험한다 */}
        <Pressable style={styles.devBtn} onPress={onSimulateFire}
                   accessibilityRole="button"
                   accessibilityLabel="개발용. 화재 신호 모의 발생">
          <Text style={styles.devText}>🔧 화재 신호 모의 발생 (개발용)</Text>
        </Pressable>
      </View>
    </View>
  );
}

const Center = ({ children }) => <View style={styles.center}>{children}</View>;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    padding: 32, backgroundColor: theme.bg, gap: 12,
  },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  mask: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.6)' },
  frame: {
    borderWidth: 4, borderRadius: 18,
    shadowOpacity: 0.9, shadowRadius: 22, shadowOffset: { width: 0, height: 0 },
  },
  header: { position: 'absolute', top: 68, left: 0, right: 0, alignItems: 'center', gap: 6 },
  title: { color: '#fff', fontSize: 20, fontWeight: '700' },
  hint: {
    color: '#e5e7eb', fontSize: 15, backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, overflow: 'hidden',
  },
  hintOk: { color: '#052e16', backgroundColor: theme.ok, fontWeight: '700' },
  footer: { position: 'absolute', bottom: 40, left: 0, right: 0, alignItems: 'center', gap: 14 },
  count: { color: '#d1d5db', fontSize: 13 },
  conn: { color: 'rgba(255,255,255,0.5)', fontSize: 12 },
  shutter: {
    width: 84, height: 84, borderRadius: 42, alignItems: 'center',
    justifyContent: 'center', borderWidth: 5,
  },
  shutterOn: { borderColor: theme.ok, backgroundColor: 'rgba(34,197,94,0.25)' },
  shutterOff: { borderColor: 'rgba(255,255,255,0.55)', backgroundColor: 'rgba(255,255,255,0.12)' },
  shutterInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: '#fff' },
  linkBtn: { paddingVertical: 10, paddingHorizontal: 18 },
  linkText: { color: '#fff', fontSize: 16, textDecorationLine: 'underline' },
  devBtn: { paddingVertical: 8, paddingHorizontal: 14, marginTop: 4 },
  devText: { color: 'rgba(255,255,255,0.45)', fontSize: 12 },
  permTitle: { color: theme.text, fontSize: 20, fontWeight: '700' },
  permBody: { color: theme.textDim, fontSize: 15, textAlign: 'center', lineHeight: 22 },
  primaryBtn: {
    marginTop: 10, backgroundColor: theme.accent, paddingVertical: 16,
    paddingHorizontal: 32, borderRadius: 14,
  },
  primaryBtnText: { color: '#fff', fontSize: 17, fontWeight: '700' },
});
