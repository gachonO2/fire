import { createApp } from './app.js';
import { config } from './config.js';
import { getRepo } from './repositories/index.js';
import { startHeatSensors } from './heatSensors.js';

const repo = await getRepo(); // 저장소를 먼저 붙여 첫 요청 지연을 없앤다
const app = createApp();

app.listen(config.port, () => {
  console.log(`\n🧯 대피 안내 백엔드 실행 중`);
  console.log(`   API      http://localhost:${config.port}/api/health`);
  console.log(`   사용자 앱 http://localhost:${config.port}/index.html`);
  console.log(`   관제      http://localhost:${config.port}/admin.html`);
  console.log(`   저장소    ${repo.mode}\n`);
  // 열감지기는 서버가 사는 동안 산다. 진짜 감지기와 **같은 경로**로 보고하므로
  // (`repo.setSensorReading`), ESP32 를 붙이는 날 이 한 줄만 지우면 된다.
  startHeatSensors();
});
