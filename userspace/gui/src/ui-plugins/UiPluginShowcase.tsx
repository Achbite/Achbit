import {useMemo,useState} from 'react';
import { uiPluginText } from '../pluginLocalization';
import {t,type UiLanguage} from '../i18n';
import {MarkdownContent} from '../components/local-agent/BufferedMarkdown';
import {DocumentPreview} from '../components/local-agent/DocumentPreview';
import {UiPluginSlotView,useDisplayTheme,useUiPlugins} from './UiPlugins';

export function UiPluginShowcase({language}:{language:UiLanguage}){
  const [slot,setSlot]=useState<'message.plain'|'message.markdown'|'document.html'>('message.markdown');
  const [editedText,setText]=useState<string|null>(null);
  const text=editedText ?? t(language,'plugins.preview.markdown');
  const theme=useDisplayTheme();const {entries}=useUiPlugins();
  const blob=useMemo(()=>new Blob([`<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui;padding:24px;line-height:1.6}h1{font-size:28px}</style><h1>${t(language,'plugins.preview.documentTitle')}</h1><p>${t(language,'plugins.preview.documentBody')}</p>`],{type:'text/html'}),[language]);
  return <section className="settings-group">
    <h3 className="settings-card__title">{language==='zh-CN'?'组件展示':'Component preview'}</h3>
    <label>{t(language,'plugins.preview.slot')} <select value={slot} onChange={(event)=>setSlot(event.target.value as typeof slot)}><option>message.plain</option><option>message.markdown</option><option>document.html</option></select></label>
    <p><small>{entries.filter((item)=>item.status==='active').map((item)=>uiPluginText(language, item.manifest, 'name')).join(', ')||t(language,'plugins.preview.builtin')}</small></p>
    {slot==='document.html'?<DocumentPreview blob={blob} format="html" filename="component.html" language={language}/>:<>
      <textarea className="settings-field__input" rows={5} aria-label={t(language,'plugins.preview.content')} value={text} onChange={(event)=>setText(event.target.value)}/>
      <div className="settings-card settings-card__body"><UiPluginSlotView slot={slot} input={{kind:'message',text,format:slot==='message.plain'?'plain':'markdown',locale:language,theme}}>{slot==='message.plain'?<p style={{whiteSpace:'pre-wrap'}}>{text}</p>:<MarkdownContent>{text}</MarkdownContent>}</UiPluginSlotView></div>
    </>}
  </section>;
}
