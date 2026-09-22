import './ui/styles.css';
import { echarts } from './ui/echarts.js';
import { bindLegacyEvents } from './adapters/browser/legacy-events';
import { bindPageEvents, init } from './ui/init.js';
import { initTasks } from './ui/tasks';

Object.assign(window, { echarts });
bindLegacyEvents();
bindPageEvents();
initTasks();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
