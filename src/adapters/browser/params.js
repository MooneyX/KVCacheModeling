import { readParams } from '../parameters.js';

export function getParams() {
  return readParams(id => document.getElementById(id));
}
