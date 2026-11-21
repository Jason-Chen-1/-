import {applyDesignEdit} from './design-schema.js';

export const DESIGNER_ID='june';
export const ROLE_CONFIG=Object.freeze({
 rick:Object.freeze({name:'TRUMP',label:'BOSS · SUPERVISOR',canEdit:false,color:'#f0be81'}),
 june:Object.freeze({name:'豆包',label:'DESIGNER · ONLY EDITOR',canEdit:true,color:'#b7c7a0'}),
 chad:Object.freeze({name:'CJ',label:'CLIENT · REVIEWER',canEdit:false,color:'#c7abd1'})
});
export const canEditDesign=who=>ROLE_CONFIG[who]?.canEdit===true;
export const isDesignAction=action=>['bigger','balance','minimal','chaos','budgetCut','lock'].includes(action);
export function applyAgentDesignEdit(current,edit,who){
 if(current.userDecision?.finalized||!canEditDesign(who))return {design:structuredClone(current),changed:false};
 return applyDesignEdit(current,edit);
}

export function finalizeByUser(current){
 const next=structuredClone(current);next.locked=true;next.userDecision={finalized:true,revision:next.revision};return next;
}

export function reopenByUser(current){
 const next=structuredClone(current);delete next.userDecision;next.locked=false;return next;
}

// Keep reviews across supervisor turns; only a designer revision invalidates them.
export function mergeAgentTurn(current,turn){
 if(current.userDecision?.finalized||!ROLE_CONFIG[turn.who])return structuredClone(current);
 const changed=canEditDesign(turn.who)&&turn.design&&turn.design.revision!==current.revision;
 const next=structuredClone(changed?turn.design:current);
 next.approvals=changed?{rick:false,june:false,chad:false}:{...current.approvals};
 next.approvals[turn.who]=turn.design?.approvals?.[turn.who]===true;
 next.clientReview=changed?{status:'pending',feedback:'豆包已更新设计，等待 CJ 重新验收。',revision:next.revision}:structuredClone(current.clientReview||{status:'pending',feedback:'等待 CJ 评估当前海报。',revision:next.revision});
 if(turn.who==='chad'){
  const status=['approved','changes_requested','pending'].includes(turn.reviewStatus)?turn.reviewStatus:next.approvals.chad?'approved':'changes_requested';
  next.clientReview={status,feedback:String(turn.decision||turn.cn||'').slice(0,500),revision:next.revision};
 }
 next.approvals.chad=next.clientReview.status==='approved';
 return next;
}
