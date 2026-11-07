import React,{useId,useState} from 'react';

const h=React.createElement;
const preferenceKey='dsh-unreal-bridge:dock-open';
const initialOpen=()=>{try{return globalThis.localStorage?.getItem(preferenceKey)==='true';}catch{return false;}};
const css=`
.dsh-ue-disclosure{box-sizing:border-box;width:calc(100% - 16px);max-width:712px;margin:0 auto 4px;color:var(--dsw-alias-label-primary,#17191d)}
.dsh-ue-disclosure__reveal{display:grid;grid-template-rows:0fr;opacity:0;transform:translateY(10px);visibility:hidden;pointer-events:none;transition:grid-template-rows 280ms cubic-bezier(.22,1,.36,1),transform 280ms cubic-bezier(.22,1,.36,1),opacity 200ms ease,visibility 0s linear 280ms}
.dsh-ue-disclosure[data-open="true"]>.dsh-ue-disclosure__reveal{grid-template-rows:1fr;opacity:1;transform:translateY(0);visibility:visible;pointer-events:auto;transition-delay:0s}
.dsh-ue-disclosure__clip{min-height:0;overflow:hidden}
.dsh-ue-disclosure__body{padding-bottom:6px}
.dsh-ue-disclosure__handle-row{display:flex;justify-content:center;align-items:center;height:28px}
.dsh-ue-disclosure__handle{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:7px;min-width:142px;height:24px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:999px;background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-secondary,#62666d);font-family:inherit;font-size:11px;line-height:1;cursor:pointer;user-select:none;transition:background-color 160ms ease,border-color 160ms ease,color 160ms ease,box-shadow 160ms ease}
.dsh-ue-disclosure__handle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));border-color:var(--dsw-alias-border-l3,rgba(128,128,128,.4));color:var(--dsw-alias-label-primary,#17191d)}
.dsh-ue-disclosure__handle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4b67df);outline-offset:3px}
.dsh-ue-disclosure__name{font-weight:600;color:var(--dsw-alias-label-primary,#17191d)}
.dsh-ue-disclosure__dot{width:5px;height:5px;flex:none;border-radius:50%;background:var(--dsh-ue-status-color,currentColor)}
.dsh-ue-disclosure__arrow{width:12px;height:12px;flex:none;transition:transform 280ms cubic-bezier(.22,1,.36,1)}
.dsh-ue-disclosure[data-open="true"] .dsh-ue-disclosure__arrow{transform:rotate(180deg)}
@media(prefers-reduced-motion:reduce){.dsh-ue-disclosure__reveal,.dsh-ue-disclosure__handle,.dsh-ue-disclosure__arrow{transition:none;transform:none}}
`;

/** Keep the live panel mounted while hiding its controls from focus and accessibility. */
export function DockDisclosure({children,status,statusColor}){
  const [open,setOpen]=useState(initialOpen);
  const panelId=useId();
  const toggle=()=>{
    const next=!open;
    setOpen(next);
    try{globalThis.localStorage?.setItem(preferenceKey,String(next));}catch{ /* View preference still works without storage. */ }
  };
  const action=open?'收起 Unreal Editor 信息':'展开 Unreal Editor 信息';
  return h('div',{className:'dsh-ue-disclosure','data-open':String(open)},
    h('style',null,css),
    h('div',{id:panelId,className:'dsh-ue-disclosure__reveal','aria-hidden':!open,inert:open?undefined:''},
      h('div',{className:'dsh-ue-disclosure__clip'},h('div',{className:'dsh-ue-disclosure__body'},children))),
    h('div',{className:'dsh-ue-disclosure__handle-row'},
      h('button',{type:'button',className:'dsh-ue-disclosure__handle','aria-label':action,'aria-expanded':open,'aria-controls':panelId,title:`${action} · ${status}`,onClick:toggle},
        h('span',{className:'dsh-ue-disclosure__name'},'Unreal'),
        h('span',{className:'dsh-ue-disclosure__dot','aria-hidden':true,style:{'--dsh-ue-status-color':statusColor}}),
        h('span',null,status),
        h('svg',{className:'dsh-ue-disclosure__arrow',viewBox:'0 0 20 20',fill:'none','aria-hidden':true},h('path',{d:'m5 12 5-5 5 5',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round'})))));
}
