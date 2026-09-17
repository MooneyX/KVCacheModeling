import './ui/styles.css';
import { echarts } from './ui/echarts.js';
import { bindLegacyEvents } from './adapters/browser/legacy-events';
import { bindPageEvents, init } from './ui/init.js';

Object.assign(window, { echarts });
bindLegacyEvents();
bindPageEvents();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
