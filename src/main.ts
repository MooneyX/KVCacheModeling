import './ui/styles.css';
import { echarts } from './ui/echarts.js';
import { bindLegacyEvents } from './adapters/browser/legacy-events';
import { bindPageEvents, init } from './ui/init.js';
import { initTasks } from './ui/tasks';
import { initReplay } from './ui/replay.js';

Object.assign(window, { echarts });
bindLegacyEvents();
bindPageEvents();
initTasks();
function initPage() {
  init();
  initReplay();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPage, { once: true });
else initPage();
