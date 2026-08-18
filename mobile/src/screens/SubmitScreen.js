/**
 * 도면 등록 — 찍은 피난안내도를 서버로 보낸다.
 *
 * 예전에는 사진이 폰에만 남아서, 같은 사진을 편집기에서 **또** 올려야 했다.
 * 여기서 보내면 서버가 AI 로 읽어 초안까지 만들고, 담당자는 확인만 하면 된다.
 *
 * ## 이름 하나만 받는다
 *
 * 원래는 가로 폭(축척)과 방위도 받았다. 둘 다 뺐다 — 대피로에 **비콘을 설치**하기로
 * 정해졌기 때문이다. 위치와 거리를 비콘이 알려주면 도면의 축척·방위는 필요 없다.
 *
 * 찍는 사람 입장에서는 **이름만 치고 누르면 끝**이라, 도면이 훨씬 잘 모인다.
 * 등록이 번거로우면 아무도 안 한다.
 *
 * ## 다만 지금은 거리가 추정값이다
 *
 * 비콘이 붙기 전까지 서버는 층 폭을 30m 로 가정한다. 그래서 "몇 걸음"이 어긋날 수
 * 있고, **앱이 그 사실을 안내 시작할 때 말한다**(`GuideScreen`). 추정값을 정확한
 * 값처럼 말하면 시각장애인이 그 걸음 수를 믿고 걷다가 모퉁이를 지나친다.
 *
 * 정확한 축척이 필요하면 편집기에서 가로 폭을 넣으면 되고, 그러면 표시가 벗겨진다.
 */

import { useEffect, useState } from 'react';
import {
  ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { File } from 'expo-file-system';

import { chimeGood, chimeReject } from '../sound';
import { cueLocked, cueReject } from '../haptics';
import { say, stopSpeaking } from '../announce';
import { theme } from '../theme';

/** 서버가 받는 이미지 상한과 같은 값 */
const MAX_BYTES = 900_000;

export default function SubmitScreen({ api, photo, onDone, onCancel }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    say('건물과 층 이름을 넣고 등록을 누르세요.', { force: true });
    return () => stopSpeaking();
  }, []);

  async function submit() {
    if (!name.trim()) { setError('건물·층 이름을 넣어주세요. 예: AI공학관 3층'); return; }
    if (!api?.configured) { setError('서버에 연결되어 있지 않습니다.'); return; }

    setBusy(true);
    setError('');
    say('도면을 보내는 중입니다. 잠시 기다려주세요.', { force: true });

    try {
      // expo-file-system 19 에서 readAsStringAsync 가 없어졌다. File.base64() 를 쓴다.
      const base64 = await new File(photo.uri).base64();
      const dataUri = `data:image/jpeg;base64,${base64}`;
      if (dataUri.length > MAX_BYTES) {
        throw new Error(`사진이 너무 큽니다 (${Math.round(dataUri.length / 1024)}KB). 조금 떨어져서 다시 찍어주세요.`);
      }

      const res = await api.submitDraft({
        name: name.trim(),
        dataUri,
        width: photo.width,
        height: photo.height,
      });
      if (!res?.planId) throw new Error(res?.error || '서버가 도면을 받지 못했습니다.');

      chimeGood();
      cueLocked();
      // 판독이 실패해도 사진은 저장됐다. 그 차이를 숨기지 않는다 —
      // "등록됐다"고만 하면 담당자가 확인할 게 남았다는 걸 모른다.
      say(res.read
        ? `등록했습니다. 출구 ${res.exits}곳, 방 ${res.rooms}곳을 읽었습니다. 담당자 확인 뒤 안내에 쓰입니다.`
        : '사진은 저장했습니다. 다만 지금은 도면을 읽지 못했으니 담당자가 나중에 처리합니다.',
        { force: true });
      onDone?.(res);
    } catch (e) {
      chimeReject(); cueReject();
      setError(String(e?.message || e));
      say('등록에 실패했습니다.', { force: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">
        <Text style={styles.title} accessibilityRole="header">도면 등록</Text>

        <Image source={{ uri: photo?.uri }} style={styles.thumb} resizeMode="contain"
               accessible accessibilityLabel="방금 찍은 피난안내도" />

        <Text style={styles.label}>건물 · 층</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="예: AI공학관 3층"
          placeholderTextColor="#6b7280"
          autoFocus
          returnKeyType="done"
          onSubmitEditing={submit}
          accessibilityLabel="건물과 층 이름"
        />
        <Text style={styles.help}>
          나머지는 서버가 사진에서 읽습니다 — 비상구·복도·방 이름.
          담당자가 확인한 뒤에 안내에 쓰입니다.
        </Text>

        {!!error && <Text style={styles.error}>{error}</Text>}

        <View style={styles.actions}>
          <Pressable style={[styles.btn, styles.ghost]} onPress={onCancel} disabled={busy}
                     accessibilityRole="button" accessibilityLabel="취소">
            <Text style={styles.ghostText}>취소</Text>
          </Pressable>
          <Pressable style={[styles.btn, busy ? styles.disabled : styles.primary]}
                     onPress={submit} disabled={busy}
                     accessibilityRole="button" accessibilityLabel="도면 서버로 보내기">
            {busy ? <ActivityIndicator color="#052e16" />
                  : <Text style={styles.primaryText}>등록하기</Text>}
          </Pressable>
        </View>
        {busy && <Text style={styles.help}>도면을 읽는 중입니다… 20초~1분 걸립니다.</Text>}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  inner: { padding: 20, gap: 10, paddingBottom: 40 },
  title: { color: theme.text, fontSize: 26, fontWeight: '800', marginBottom: 4 },
  thumb: {
    width: '100%', height: 220, backgroundColor: '#000',
    borderRadius: theme.radius, marginBottom: 6,
  },
  label: { color: theme.text, fontSize: 16, fontWeight: '700', marginTop: 8 },
  input: {
    backgroundColor: theme.surface, color: theme.text, fontSize: 20,
    paddingVertical: 16, paddingHorizontal: 16, borderRadius: 12,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
  },
  help: { color: theme.textDim, fontSize: 14, lineHeight: 20 },
  error: { color: theme.danger, fontSize: 15, lineHeight: 21, marginTop: 6 },
  actions: { flexDirection: 'row', gap: 12, marginTop: 20 },
  btn: { flex: 1, paddingVertical: 20, borderRadius: theme.radius, alignItems: 'center' },
  primary: { backgroundColor: theme.ok },
  primaryText: { color: '#052e16', fontSize: 19, fontWeight: '800' },
  ghost: {
    flex: 0.6, backgroundColor: theme.surface,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
  },
  ghostText: { color: theme.text, fontSize: 17, fontWeight: '700' },
  disabled: { backgroundColor: 'rgba(255,255,255,0.12)' },
});
