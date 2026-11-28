import React from 'react';

export const settingsColors={
  success:'var(--dsw-alias-state-success-primary, light-dark(#15803d, #4ade80))',
  error:'var(--dsw-alias-state-error-primary, light-dark(#b91c1c, #f87171))',
};

// Scoped to the plugin. Inherit the host's palette and color scheme in both themes.
const css=`
.ub-settings,.ub-knowledge{--ub-border:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 16%,transparent));--ub-muted:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 64%,transparent));--ub-surface:var(--dsw-alias-bg-layer-2,color-mix(in srgb,currentColor 3%,transparent));--ub-accent:var(--dsw-alias-brand-primary,light-dark(#2563eb,#78a9ff));font-size:14px;line-height:1.6;min-width:0;color:inherit}
.ub-settings{width:100%;max-width:860px}
.ub-settings *,.ub-knowledge *{box-sizing:border-box}
.ub-settings [hidden]{display:none!important}
.ub-settings h3,.ub-knowledge h3{font-size:15px;font-weight:650;margin:0;line-height:1.5}
.ub-settings h4,.ub-knowledge h4{font-size:13px;margin:0 0 8px;font-weight:600}
.ub-settings p,.ub-knowledge p{margin:0}
.ub-settings button,.ub-knowledge button{font:inherit;line-height:1.3;min-height:36px;padding:8px 13px;border:1px solid var(--ub-border);border-radius:8px;background:transparent;color:inherit;cursor:pointer;transition:background .15s,border-color .15s}
.ub-settings button:hover:not(:disabled),.ub-knowledge button:hover:not(:disabled){background:color-mix(in srgb,currentColor 7%,transparent)}
.ub-settings button:disabled,.ub-knowledge button:disabled{opacity:.42;cursor:not-allowed}
.ub-settings button:focus-visible,.ub-knowledge button:focus-visible,.ub-settings summary:focus-visible,.ub-knowledge summary:focus-visible{outline:2px solid var(--ub-accent);outline-offset:3px}
.ub-settings .ub-primary,.ub-knowledge .ub-primary{background:var(--ub-accent);border-color:var(--ub-accent);color:light-dark(#fff,#10203c);font-weight:600}
.ub-settings .ub-primary:hover:not(:disabled),.ub-knowledge .ub-primary:hover:not(:disabled){background:var(--ub-accent);filter:brightness(1.08)}
.ub-settings .ub-quiet,.ub-knowledge .ub-quiet{border-color:transparent;color:var(--ub-muted)}
.ub-tabs{display:flex;gap:20px;border-bottom:1px solid var(--ub-border);margin-bottom:18px;overflow-x:auto}
.ub-settings .ub-tab{position:relative;flex-shrink:0;border:0;border-radius:0;padding:10px 2px 13px;color:var(--ub-muted);font-weight:500}
.ub-settings .ub-tab[aria-selected=true]{color:var(--ub-accent);font-weight:650}
.ub-tab[aria-selected=true]:after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:var(--ub-accent);border-radius:2px}
.ub-tab-mark{margin-left:5px;color:var(--ub-accent)}
.ub-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 20px;padding:12px 14px;border:1px solid var(--ub-border);border-radius:10px;background:var(--ub-surface)}
.ub-toolbar-status{font-size:12px;color:var(--ub-muted);flex:1;min-width:130px}
.ub-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ub-stack{display:grid;gap:16px}
.ub-card{border:1px solid var(--ub-border);border-radius:12px;padding:20px;min-width:0;margin:0}
.ub-card-header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:18px}
.ub-subtitle{font-size:12px;color:var(--ub-muted);margin-top:4px!important}
.ub-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:18px 20px}
.ub-field{min-width:0}
.ub-field-wide{grid-column:1/-1}
.ub-field label{display:block;font-size:13px;font-weight:550;margin-bottom:7px}
.ub-settings input:not([type=checkbox]),.ub-settings select,.ub-knowledge input{display:block;width:100%;min-width:0;height:38px;padding:8px 10px;border:1px solid var(--ub-border);border-radius:7px;color:inherit;background:var(--ub-surface);font:inherit;font-size:13px;outline:none}
.ub-settings input:focus,.ub-settings select:focus,.ub-knowledge input:focus{border-color:var(--ub-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--ub-accent) 15%,transparent)}
.ub-settings input:disabled,.ub-settings select:disabled,.ub-knowledge input:disabled{opacity:.5}
.ub-settings input[aria-invalid=true]{border-color:${settingsColors.error}}
.ub-field-hint{font-size:12px;color:var(--ub-muted);margin-top:6px!important;line-height:1.55}
.ub-input-unit{display:flex;align-items:center;gap:8px}
.ub-input-unit span{font-size:12px;color:var(--ub-muted);white-space:nowrap}
.ub-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:14px 16px;background:var(--ub-surface);border-radius:9px;margin-bottom:18px}
.ub-toggle-row label{font-size:13px;font-weight:600;cursor:pointer}
.ub-toggle-row input[type=checkbox]{appearance:none;flex-shrink:0;width:36px;height:21px;border:1px solid var(--ub-border);border-radius:12px;background:color-mix(in srgb,currentColor 14%,transparent);position:relative;cursor:pointer;transition:background .15s;margin:0}
.ub-toggle-row input[type=checkbox]:before{content:'';position:absolute;width:15px;height:15px;top:2px;left:2px;background:light-dark(#fff,#ddd);border-radius:50%;box-shadow:0 1px 3px #0003;transition:transform .15s}
.ub-toggle-row input:checked{background:color-mix(in srgb,${settingsColors.success} 16%,transparent);border-color:color-mix(in srgb,${settingsColors.success} 45%,transparent)}
.ub-toggle-row input:checked:before{transform:translateX(15px);background:${settingsColors.success}}
.ub-toggle-row input:focus-visible{outline:2px solid var(--ub-accent);outline-offset:3px}
.ub-advanced{border-top:1px solid var(--ub-border);margin-top:18px;padding-top:13px}
.ub-advanced summary{cursor:pointer;font-size:12px;font-weight:550;color:var(--ub-muted);list-style-position:inside}
.ub-advanced[open] summary{margin-bottom:18px}
.ub-badge{display:inline-flex;align-items:center;gap:6px;flex-shrink:0;border:1px solid var(--ub-border);border-radius:20px;padding:2px 9px;font-size:11px;color:var(--ub-muted);white-space:nowrap}
.ub-feedback{padding:10px 12px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 25%,transparent);background:color-mix(in srgb,currentColor 5%,transparent);font-size:13px;overflow-wrap:anywhere}
.ub-feedback strong{font-weight:650}
.ub-credential-row{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}
.ub-credential-field{flex:1;min-width:min(100%,220px)}
.ub-credential-field label{display:block;margin-bottom:6px;font-size:13px;font-weight:550}
.ub-test-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-top:16px;margin-top:16px;border-top:1px solid var(--ub-border)}
.ub-test-feedback{flex:1;min-width:min(100%,220px);font-size:13px;overflow-wrap:anywhere}
.ub-project-paths{display:grid;gap:12px;margin:16px 0}
.ub-project-paths dt{font-size:11px;color:var(--ub-muted);margin-bottom:3px}
.ub-project-paths dd{margin:0;font-size:12px;overflow-wrap:anywhere;font-family:ui-monospace,Consolas,monospace}
.ub-empty{border:1px dashed var(--ub-border);border-radius:9px;padding:16px;margin-bottom:16px;font-size:13px;color:var(--ub-muted)}
.ub-task{border-left:2px solid var(--ub-accent);padding:0 0 0 12px;margin-top:16px;font-size:12px}
@media(max-width:520px){.ub-card{padding:16px}.ub-tabs{gap:16px}.ub-toolbar{align-items:stretch}.ub-toolbar>.ub-actions{width:100%}.ub-credential-row>.ub-actions{width:100%}.ub-test-feedback{flex-basis:100%}}
@media(prefers-reduced-motion:reduce){.ub-settings *,.ub-knowledge *{transition:none!important}}
`;

export const SettingsStyles=()=>React.createElement('style',null,css);
