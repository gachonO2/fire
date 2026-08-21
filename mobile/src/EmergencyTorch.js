/**
 * 화재 중 후면 플래시 점멸.
 *
 * 카메라 미리보기를 1px로 유지해야 iOS·Android 양쪽에서 torch를 제어할 수 있다.
 * 화면이 백그라운드로 가면 CameraView 자체를 내려 플래시가 켜진 채 남지 않고,
 * 앱으로 돌아오면 다시 점멸한다.
 */
import { useEffect, useState } from 'react';
import { AppState, StyleSheet } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useKeepAwake } from 'expo-keep-awake';

export default function EmergencyTorch({ intervalMs = 700 }) {
  // 자동 잠금으로 안내가 백그라운드에 내려가 플래시가 중간에 끊기지 않게 한다.
  useKeepAwake();
  const [permission, requestPermission] = useCameraPermissions();
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [torchOn, setTorchOn] = useState(false);

  // 처음 실행한 기기에서도 켜져야 한다. 거부되면 안내를 막거나 권한 창을
  // 반복하지 않고 플래시만 생략한다.
  useEffect(() => {
    if (!permission || permission.granted || !permission.canAskAgain) return;
    requestPermission().catch(() => {});
  }, [permission?.granted, permission?.canAskAgain, requestPermission]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      setForeground(state === 'active');
    });
    return () => sub.remove();
  }, []);

  const flashing = Boolean(foreground && permission?.granted);
  useEffect(() => {
    if (!flashing) {
      setTorchOn(false);
      return undefined;
    }

    setTorchOn(true); // 화면에 들어오자마자 첫 신호를 보낸다.
    const timer = setInterval(() => setTorchOn(value => !value), intervalMs);
    return () => {
      clearInterval(timer);
      setTorchOn(false);
    };
  }, [flashing, intervalMs]);

  if (!flashing) return null;
  return (
    <CameraView
      style={styles.hiddenCamera}
      facing="back"
      enableTorch={torchOn}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}

const styles = StyleSheet.create({
  hiddenCamera: {
    position: 'absolute', width: 1, height: 1, opacity: 0,
  },
});
