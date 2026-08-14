/**
 * 촬영 확인 — 찍은 도면을 보고 등록할지 다시 찍을지 고른다.
 *
 * 신분증 촬영 앱이 모두 이 단계를 두는 이유가 있다. 촬영은 성공했는데
 * 손가락이 걸렸거나 반사광이 들어간 경우가 흔하고, 그건 **찍은 뒤에만** 안다.
 * 확인 없이 바로 넘어가면 쓸 수 없는 사진이 쌓인다.
 *
 * 시각장애인은 사진을 볼 수 없으므로, 이 화면은 사실상 눈이 보이는 사용자
 * (건축 담당자·보호자)를 위한 것이다. 다만 시각장애인이 열었을 때도 막히지
 * 않도록 두 버튼을 크게 두고 음성으로 안내한다.
 */

import { useEffect } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { say } from '../announce';
import { chimeLocked } from '../sound';
import { cueLocked } from '../haptics';
import { theme } from '../theme';

export default function ReviewScreen({ photo, count, onConfirm, onRetake }) {
  useEffect(() => {
    chimeLocked();
    cueLocked();
    say('사진을 확인하세요. 이대로 쓰려면 이 사진 사용을, 다시 찍으려면 다시 찍기를 누르세요.',
        { force: true });
  }, []);

  return (
    <View style={styles.root}>
      <Text style={styles.title} accessibilityRole="header">이 사진으로 등록할까요?</Text>

      <View style={styles.preview}>
        <Image
          source={{ uri: photo?.uri }}
          style={styles.image}
          resizeMode="contain"
          accessible
          accessibilityLabel="방금 촬영한 피난안내도 사진"
        />
      </View>

      <Text style={styles.meta}>
        {photo?.width && photo?.height ? `${photo.width} × ${photo.height}` : ''}
        {count > 0 ? `   ·   지금까지 ${count}장 등록됨` : ''}
      </Text>

      <View style={styles.actions}>
        <Pressable
          style={[styles.btn, styles.retake]}
          onPress={onRetake}
          accessibilityRole="button"
          accessibilityLabel="다시 찍기"
          accessibilityHint="이 사진을 버리고 카메라로 돌아갑니다"
        >
          <Text style={styles.retakeText}>다시 찍기</Text>
        </Pressable>

        <Pressable
          style={[styles.btn, styles.confirm]}
          onPress={onConfirm}
          accessibilityRole="button"
          accessibilityLabel="이 사진 사용하기"
          accessibilityHint="다음 화면에서 현 위치와 출구를 표시합니다"
        >
          <Text style={styles.confirmText}>이 사진 사용</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, padding: 20, gap: 16 },
  title: {
    color: theme.text, fontSize: 24, fontWeight: '800',
    marginTop: 8, textAlign: 'center',
  },
  preview: {
    flex: 1, backgroundColor: '#000', borderRadius: theme.radius,
    overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  image: { width: '100%', height: '100%' },
  meta: { color: theme.textDim, fontSize: 13, textAlign: 'center' },
  actions: { flexDirection: 'row', gap: 12, paddingBottom: 8 },
  btn: {
    flex: 1, paddingVertical: 22, borderRadius: theme.radius, alignItems: 'center',
  },
  retake: { backgroundColor: theme.surface, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' },
  retakeText: { color: theme.text, fontSize: 19, fontWeight: '700' },
  confirm: { backgroundColor: theme.ok },
  confirmText: { color: '#052e16', fontSize: 19, fontWeight: '800' },
});
