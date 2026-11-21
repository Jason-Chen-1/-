import bundle from '../public/expertise.json' with { type: 'json' };
import {expertContext} from '../public/expertise.js';

export function getExpertContext(who, context) {
  return expertContext(bundle, who, context);
}
