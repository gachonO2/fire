/**
 * 화재 경보 — 서버가 알리면 화면 전체를 덮는다.
 *
 * 사용자가 무엇을 하고 있든 가로챈다. 화재는 다른 모든 일보다 우선하고,
 * 시각장애인은 화면에 뜬 배너를 볼 수 없으므로 **소리·진동·음성이
 * 스스로 밀고 들어와야** 한다.
 *
 * ## 네 채널을 동시에 쓰는 이유
 *
 *   사이렌   자고 있어도 깬다
 *   진동     귀가 안 들리거나 시끄러워도 전달된다
 *   음성     무슨 일인지 알려준다 ("화재발생" 3회)
 *   라이트   눈이 보이는 주변 사람이 알아챈다 — 도움을 부르는 신호가 된다
 *
 * 마지막이 중요하다. 시각장애인 혼자 대피하는 것보다 옆 사람이 알아차리는
 * 편이 훨씬 안전하다. 손전등 점멸은 시각장애인 자신을 위한 게 아니라
 * **주변에 자기 위치를 알리는** 수단이다.
 */

import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Speech from 'expo-speech';

import { startSiren, stopSiren } from '../sound';
import { say, stopSpeaking } from '../announce';
import { alarmBurst } from '../haptics';
import EmergencyTorch from '../EmergencyTorch';

const ANNOUNCE_TIMES = 3;

export default function AlarmScreen({ event, onAcknowledge }) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    startSiren();
    alarmBurst(ANNOUNCE_TIMES);

    // "화재발생"을 3번. 한 번은 못 듣고 지나칠 수 있다.
    // 경보는 반복이 목적이므로 중복 억제를 끄고(force) 직접 읽는다.
    const speak = i => {
      if (i >= ANNOUNCE_TIMES) {
        say('안전한 곳으로 대피하세요. 화면 아무 곳이나 누르면 안내를 시작합니다.',
            { force: true });
        return;
      }
      Speech.speak('비상. 화재발생.', {
        language: 'ko-KR', rate: 1.0, pitch: 1.1,
        onDone: () => setTimeout(() => speak(i + 1), 260),
      });
    };
    speak(0);

    Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 420, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 420, useNativeDriver: true }),
    ])).start();

    return () => {
      stopSiren();
      stopSpeaking();
    };
  }, []);

  const bg = pulse.interpolate({
    inputRange: [0, 1], outputRange: ['#7f1d1d', '#ef4444'],
  });

  return (
    <Pressable
      style={styles.fill}
      onPress={onAcknowledge}
      accessibilityRole="button"
      accessibilityLabel="화재 발생. 대피 안내를 시작하려면 두 번 누르세요."
    >
    <Animated.View style={[styles.root, { backgroundColor: bg }]} pointerEvents="none">
      {/* 화면 밖으로 안 보이게 두되 손전등만 켠다 */}
      <EmergencyTorch intervalMs={480} />

      <View style={styles.body}>
        <Text style={styles.icon}>🔥</Text>
        <Text style={styles.title} accessibilityRole="header">화재 발생</Text>
        <Text style={styles.where}>{event?.location || '건물 내 화재 감지'}</Text>
        {event?.celsius != null && (
          <Text style={styles.temp}>{Math.round(event.celsius)}°C 감지</Text>
        )}
      </View>

      {/* 시각장애인은 버튼 위치를 찾을 수 없다. 화면 전체가 버튼이고,
          이 표시는 눈이 보이는 사람에게 어디를 눌러도 된다고 알리는 것이다. */}
      <View style={styles.cta}>
        <Text style={styles.ctaText}>화면을 눌러 대피 안내 시작</Text>
      </View>
    </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  root: { flex: 1, alignItems: 'center', justifyContent: 'space-between', paddingVertical: 90 },
  body: { alignItems: 'center', gap: 10, paddingHorizontal: 24 },
  icon: { fontSize: 96 },
  title: { color: '#fff', fontSize: 48, fontWeight: '900', letterSpacing: -1 },
  where: { color: '#fee2e2', fontSize: 20, textAlign: 'center' },
  temp: { color: '#fecaca', fontSize: 17, marginTop: 2 },
  cta: {
    backgroundColor: '#fff', paddingVertical: 26, paddingHorizontal: 40,
    borderRadius: 20, marginHorizontal: 24, minWidth: '80%', alignItems: 'center',
  },
  ctaText: { color: '#7f1d1d', fontSize: 24, fontWeight: '900' },
});
