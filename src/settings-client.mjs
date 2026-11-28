import React, {useEffect, useId, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {FIELD_SPECS, SETTING_GROUPS, SETTINGS_NAMESPACE, SETTINGS_SLOT_KEY, fieldValueError, parseFieldInput} from './settings-spec.mjs';
import {SettingsStyles,settingsColors} from './settings-ui.mjs';

const h = React.createElement;
const color = {
  text:'var(--dsw-alias-label-primary, #17191d)', muted:'var(--dsw-alias-label-secondary, #62666d)',
  border:'var(--dsw-alias-border-l2, #d5d8dc)', surface:'var(--dsw-alias-bg-layer-2, #fff)',
  error:'var(--dsw-alias-state-error-primary, #b91c1c)', accent:'var(--dsw-alias-brand-primary, #175cd3)',
};
const buttonStyle = {padding:'7px 12px', border:`1px solid ${color.border}`, borderRadius:6, background:color.surface, color:color.text, cursor:'pointer'};
const valuesOf = value => Object.fromEntries(FIELD_SPECS.map(field => [field.key, value?.[field.key] ?? field.defaultValue]));
const same = (left, right) => FIELD_SPECS.every(field => Object.is(left?.[field.key], right?.[field.key]));
const initialDraft = state => ({values:valuesOf(state.value), baseline:valuesOf(state.value), revision:state.revision, reset:false});

export function SettingsPage({view='page', form, renderCache:Cache, renderKnowledge:Knowledge}) {
  const [tab,setTab]=useState('knowledge'),pageId=useId();
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const mounted = useRef(true);
  const state = form?.state;
  const ready = state?.status === 'ready' && state.value !== undefined;
  const dirty = !!draft && (draft.reset || !same(draft.values, draft.baseline));
  const conflict = !!draft && dirty && draft.revision !== state?.revision;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (ready && !saving && (!draft || !dirty)) setDraft(initialDraft(state));
  }, [ready, state?.revision, state?.value, saving]);

  if (view === 'summary') return h('span', null, '设置修复次数、执行预算、请求超时与缓存保留。');
  if (!form || state?.status === 'unavailable') return h('p', {role:'status'}, '设置暂不可用。请确认 DSH 已加载支持设置的插件版本。');
  if (!ready || !draft) return h('p', {role:'status'}, '正在读取插件设置…');
  const disabled = saving || !state.writable;
  const errors = Object.fromEntries(FIELD_SPECS.flatMap(field => {
    const message = fieldValueError(field, draft.values[field.key]);
    return message ? [[field.key, message]] : [];
  }));
  const change = (key, value) => {
    setDraft(previous => ({...previous, values:{...previous.values, [key]:value}}));
    setNotice(''); setFailure('');
  };
  const cancel = () => {setDraft(initialDraft(state)); setNotice('已恢复最新已保存设置。'); setFailure('');};
  const restore = () => {setDraft(previous => ({...previous, values:valuesOf(state.base), reset:true})); setNotice('默认值已放入草稿；点击保存后生效。'); setFailure('');};
  const save = async event => {
    event?.preventDefault();
    if (disabled || !dirty || conflict || Object.keys(errors).length) return;
    const base = valuesOf(state.base);
    const ops = FIELD_SPECS.flatMap(field => {
      const value = draft.values[field.key];
      if (draft.reset && Object.is(value, base[field.key])) return [{op:'unset', path:[field.key]}];
      if (draft.reset || !Object.is(value, draft.baseline[field.key])) return [{op:'set', path:[field.key], value}];
      return [];
    });
    setSaving(true); setFailure(''); setNotice('');
    try {
      const accepted = await form.mutate(ops, draft.revision);
      if (!mounted.current) return;
      if (accepted) {setDraft(null); setNotice('设置已保存。执行限制从下一轮任务生效，权限与超时从下一次请求生效，缓存参数从下一次清理生效。');}
      else setFailure('保存未被接受，草稿已保留。配置可能已在其他窗口更新；请取消草稿并读取最新设置后重试。');
    } catch (error) {
      if (mounted.current) setFailure(`保存失败，草稿已保留：${error.message ?? String(error)}`);
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  const fieldView=field=>{
    const id=`${pageId}-${field.key}`,hintId=`${id}-hint`,error=errors[field.key];
    const common={id,name:field.key,disabled,'aria-invalid':!!error,'aria-describedby':hintId};
    const hint=h('p',{id:hintId,className:'ub-field-hint',...(error?{style:{color:settingsColors.error}}:{})},error??field.hint);
    if(field.type==='boolean')return h('div',{key:field.key,className:'ub-toggle-row'},
      h('div',null,h('label',{htmlFor:id},field.label),hint),
      h('input',{...common,type:'checkbox',role:'switch',checked:draft.values[field.key],onChange:event=>change(field.key,event.target.checked)}));
    const input=field.type==='choice'
      ?h('select',{...common,value:draft.values[field.key],onChange:event=>change(field.key,event.target.value)},...field.options.map(option=>h('option',{key:option.value,value:option.value},option.label)))
      :field.type==='text'
      ?h('input',{...common,type:'text',value:draft.values[field.key],maxLength:field.maxLength,spellCheck:false,placeholder:field.key==='embeddingBaseUrl'?'https://…/compatible-mode/v1':field.key==='embeddingModel'?'例如 text-embedding-v4':undefined,onChange:event=>change(field.key,event.target.value)})
      :h('div',{className:'ub-input-unit'},h('input',{...common,type:'number',value:Number.isFinite(draft.values[field.key])?draft.values[field.key]/field.scale:'',min:field.min/field.scale,max:field.max/field.scale,step:field.scale===1?1:'any',onChange:event=>change(field.key,parseFieldInput(field,event.target.value))}),field.unit?h('span',null,field.unit):null);
    return h('div',{key:field.key,className:`ub-field${field.key==='embeddingBaseUrl'?' ub-field-wide':''}`},h('label',{htmlFor:id},field.label),input,hint);
  };
  const groupView=group=>h('section',{key:group.key,className:'ub-card','aria-label':group.label},
    h('div',{className:'ub-card-header'},h('div',null,h('h3',null,group.label),h('p',{className:'ub-subtitle'},group.hint))),
    ...FIELD_SPECS.filter(field=>field.group===group.key&&field.type==='boolean').map(fieldView),
    h('div',{className:'ub-grid'},...FIELD_SPECS.filter(field=>field.group===group.key&&field.type!=='boolean').map(fieldView)));
  const mainFields=['embeddingBaseUrl','embeddingModel','embeddingProvider'];
  const tabs=[{key:'knowledge',label:'知识库',groups:['embedding','retrieval']},{key:'execution',label:'执行与权限',groups:['permissions','repair','budget','timeouts']},{key:'cache',label:'缓存',groups:['cache']}];
  const tabKeyboard=event=>{
    const position=tabs.findIndex(item=>item.key===tab);
    const next=event.key==='ArrowRight'?(position+1)%tabs.length:event.key==='ArrowLeft'?(position+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:null;
    if(next===null)return;event.preventDefault();setTab(tabs[next].key);event.currentTarget.parentElement.querySelectorAll('[role=tab]')[next]?.focus();
  };
  const panel=(key,...children)=>h('div',{id:`${pageId}-panel-${key}`,role:'tabpanel','aria-labelledby':`${pageId}-tab-${key}`,hidden:tab!==key,className:'ub-stack'},...children);
  return h('section',{'aria-label':'DSH Unreal Bridge 设置',className:'ub-settings'},
    h(SettingsStyles),
    h('div',{role:'tablist','aria-label':'设置分类',className:'ub-tabs'},...tabs.map(item=>h('button',{key:item.key,id:`${pageId}-tab-${item.key}`,type:'button',role:'tab',className:'ub-tab','aria-selected':tab===item.key,'aria-controls':`${pageId}-panel-${item.key}`,tabIndex:tab===item.key?0:-1,onKeyDown:tabKeyboard,onClick:()=>setTab(item.key)},item.label,
      FIELD_SPECS.some(field=>item.groups.includes(field.group)&&(errors[field.key]||!Object.is(draft.values[field.key],draft.baseline[field.key])))?h('span',{className:'ub-tab-mark','aria-label':'有待保存或无效设置'},'•'):null))),
    h('form',{onSubmit:save,noValidate:true},
      h('div',{className:'ub-toolbar'},
        h('p',{role:'status',className:'ub-toolbar-status'},!state.writable?'当前配置不可写。':saving?'正在保存…':conflict?'配置已在其他窗口更新。当前草稿未覆盖，请取消草稿并读取最新设置。':dirty?'有未保存的设置。':'当前设置已同步。'),
        h('div',{className:'ub-actions'},
          h('button',{type:'button',disabled:saving||!dirty,onClick:cancel,className:'ub-quiet'},'取消草稿'),
          h('button',{type:'submit',disabled:disabled||!dirty||conflict||Object.keys(errors).length>0,className:'ub-primary'},saving?'正在保存…':'保存设置'))),
      failure?h('p',{role:'alert',className:'ub-feedback',style:{color:settingsColors.error,marginBottom:16}},failure):null,
      notice?h('p',{role:'status',className:'ub-feedback',style:{color:settingsColors.success,marginBottom:16}},notice):null,
      Object.keys(errors).length?h('p',{role:'alert',className:'ub-feedback',style:{color:settingsColors.error,marginBottom:16}},'请修正标记页签中的无效设置后保存。'):null,
      panel('knowledge',
        h('section',{className:'ub-card','aria-label':'向量服务'},
          h('div',{className:'ub-card-header'},h('div',null,h('h3',null,'向量服务'),h('p',{className:'ub-subtitle'},'填写服务配置并保存，再验证连接。保存设置不会生成向量。'))),
          fieldView(FIELD_SPECS.find(field=>field.key==='embeddingEnabled')),
          h('div',{className:'ub-grid'},...mainFields.map(key=>fieldView(FIELD_SPECS.find(field=>field.key===key)))),
          h('details',{className:'ub-advanced'},h('summary',null,'高级参数 · 维度、批次与请求限额'),h('div',{className:'ub-grid'},...FIELD_SPECS.filter(field=>field.group==='embedding'&&field.key!=='embeddingEnabled'&&!mainFields.includes(field.key)).map(fieldView))),
          h('details',{className:'ub-advanced'},h('summary',null,'检索上下文预算'),h('div',{className:'ub-grid'},...FIELD_SPECS.filter(field=>field.group==='retrieval').map(fieldView)))),
        Knowledge?h(Knowledge,{draftPending:dirty||saving||conflict,writable:state.writable,configRevision:state.revision}):null),
      panel('execution',...SETTING_GROUPS.filter(group=>tabs[1].groups.includes(group.key)).map(groupView)),
      panel('cache',...SETTING_GROUPS.filter(group=>group.key==='cache').map(groupView),Cache?h(Cache):null),
      h('div',{style:{marginTop:20,display:'flex',justifyContent:'flex-end'}},h('button',{type:'button',disabled,onClick:restore,className:'ub-quiet',title:'将所有页签的设置恢复为默认草稿，保存后生效'},'恢复默认'))),
  );
}

function useSnapshot(source) {
  const store = useMemo(() => ({
    subscribe:listener=>source.subscribe(listener),
    getSnapshot:()=>source.getSnapshot(),
  }), [source]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** Global Settings does not supply the plugin manager's owner `form` prop. */
export function SettingsSection({configForm, describe, renderCache, renderKnowledge}) {
  const state = useSnapshot(configForm);
  const mirror = useSnapshot(describe);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState('');
  const mounted = useRef(true);
  useEffect(() => {mounted.current=true; return () => {mounted.current=false;};}, []);
  const mutate = useMemo(() => (ops, revision) => configForm.mutate(ops, revision), [configForm]);
  const error = retryError || mirror.error;
  const retry = async() => {
    setRetrying(true); setRetryError('');
    try {await describe.load();}
    catch (failure) {if(mounted.current)setRetryError(failure.message ?? String(failure));}
    finally {if(mounted.current)setRetrying(false);}
  };
  return h('section', {'aria-label':'Unreal Bridge', style:{color:color.text, maxWidth:760}},
    h('h2', {style:{margin:'0 0 8px', fontSize:18}}, 'Unreal Bridge'),
    h('p', {style:{color:color.muted,margin:'0 0 20px',fontSize:13}}, '管理知识库、UE 执行权限与本地缓存。'),
    error ? h('div', null,
      h('p', {role:'alert', style:{color:color.error}}, `读取设置失败：${error}`),
      h('button', {type:'button', disabled:retrying, onClick:retry, style:buttonStyle}, retrying?'正在重试…':'重新读取'),
    ) : null,
    !error || state.status !== 'loading'
      ? h(SettingsPage, {form:{state,mutate}, renderCache,renderKnowledge})
      : null,
  );
}

/** Both entries use the same official form; editor RPC availability is unrelated. */
export function registerSettingsClient(ctx, options={}) {
  const row = ctx.slots.inject('plugins.row.config', () =>
    ctx.slots.register({
      name:'plugins.row.config', key:SETTINGS_SLOT_KEY,
      inject:()=>({renderCache:options.renderCache,...(options.renderKnowledge?{renderKnowledge:options.renderKnowledge}:{})}),
    }, SettingsPage));
  const section = ctx.inject(['configForms'], child => {
    const configForm = child.configForms.get(SETTINGS_NAMESPACE);
    const describe = child.configForms.describe();
    child.slots.inject('settings.section', () => child.slots.register({
      name:'settings.section', id:SETTINGS_NAMESPACE, order:60,
      label:()=>'Unreal Bridge',
      inject:()=>({configForm,describe,renderCache:options.renderCache,...(options.renderKnowledge?{renderKnowledge:options.renderKnowledge}:{})}),
    }, SettingsSection));
  });
  return async() => {row?.(); await section?.dispose();};
}
