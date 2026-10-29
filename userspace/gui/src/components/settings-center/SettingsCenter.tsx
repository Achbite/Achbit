import { UiRegion } from '../../ui-plugins/UiRegion';
import { takeRestoredInterfaceView, useInterfaceReloadView, registerInterfaceReloadView } from '../../services/interfaceReload';
import { createPortal } from 'react-dom';
import { UI_ICON_ROLES } from '../../icons/registry';
import { SettingsSearchContext, SettingsSearchTargets, matchesSettingsQuery, type SettingsSearchEntry } from './settingsSearch';
import { settingsSearchDefinitions } from './sections/CategorizedSettingsSections';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeUiLanguage, t } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import {
  AgentSettingsSection,
  GuiSettingsSection,
} from './sections/CategorizedSettingsSections';
import LlmSection from './sections/LlmSection';
import PluginsSection from './sections/PluginsSection';
import AchbitShellIcon, { type AchbitShellIconName } from '../shared/AchbitShellIcon';
import './settingsCenter.css';
import { createInteractionFocus, InteractionFocusContext, useInteractionFocus } from '../shared/interactionFocus';

type SettingsKey = 'general' | 'about' | 'gui' | 'agent' | 'environment' | 'permissions' | 'llm' | 'plugins';

interface SettingsCenterProps {
  apiStatus: string;
  serverVersion?: string;
  navigationTarget?: HTMLElement | null;
}

const SettingsCenter: React.FC<SettingsCenterProps> = ({
  apiStatus,
  serverVersion,
  navigationTarget,
}) => {
  const inheritedInteraction = useInteractionFocus();
  const [localInteraction] = useState(createInteractionFocus);
  const interaction = inheritedInteraction ?? localInteraction;
  useEffect(() => () => interaction.clearReveal(), [interaction]);
  const [activeKey, setActiveKey] = useState<SettingsKey>(
    () => takeRestoredInterfaceView<SettingsKey>('settingsPage', 'general'),
  );
  const [searchEntries, setSearchEntries] = useState<Record<string, SettingsSearchEntry[]>>({});
  const register = useCallback((owner: string, entries: SettingsSearchEntry[]) => setSearchEntries((current) => ({ ...current, [owner]: entries })), []);
  const scrollRef = useRef<HTMLElement>(null);
  useEffect(() => registerInterfaceReloadView('settingsScroll', () => scrollRef.current?.scrollTop ?? 0), []);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = takeRestoredInterfaceView('settingsScroll', 0); }, []);
  const targets = useRef(new Map<string, HTMLElement>());
  const pendingTarget = useRef<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [visited, setVisited] = useState<SettingsKey[]>([activeKey]);
  useInterfaceReloadView('settingsPage', activeKey);
  const language = normalizeUiLanguage(
    useSettingsStore((state) => state.effectiveSettings['workbench.language']),
  );
  const statusText = (value: string) => ['connected', 'disconnected', 'checking'].includes(value)
    ? t(language, `achbitGui.status.${value}`) : value;
  const items: Array<{ key: SettingsKey; icon: AchbitShellIconName; label: string }> = [
    { key: 'general', icon: UI_ICON_ROLES.settings.general, label: language === 'zh-CN' ? '通用' : 'General' },
    { key: 'gui', icon: UI_ICON_ROLES.settings.appearance, label: t(language, 'settings.nav.gui') },
    { key: 'agent', icon: UI_ICON_ROLES.settings.agent, label: t(language, 'settings.nav.agent') },
    { key: 'environment', icon: UI_ICON_ROLES.settings.environment, label: t(language, 'settings.nav.environment') },
    { key: 'permissions', icon: UI_ICON_ROLES.settings.permissions, label: t(language, 'settings.nav.permissions') },
    { key: 'llm', icon: UI_ICON_ROLES.settings.models, label: t(language, 'settings.nav.llm') },
    { key: 'plugins', icon: UI_ICON_ROLES.settings.plugins, label: t(language, 'settings.nav.plugins') },
    { key: 'about', icon: UI_ICON_ROLES.settings.about, label: language === 'zh-CN' ? '关于' : 'About' },
  ];

  const searching = !!searchQuery.trim();
  const environment = useSettingsStore((state) => state.environment);
  const definitions = settingsSearchDefinitions(language, environment?.os);
  const entries = [
    ...items.map((item) => ({ id: `page-${item.key}`, title: item.label, category: item.key, keywords: t(language, `settings.search.terms.${item.key}`) })),
    ...definitions,
    ...Object.values(searchEntries).flat(),
  ];
  const matches = entries.filter((entry) => items.some((item) => item.key === entry.category) && matchesSettingsQuery(searchQuery, entry.title, entry.keywords ?? ''));
  const navigate = (key: SettingsKey, target?: string) => {
    interaction.clearReveal();
    pendingTarget.current = target ?? null;
    if (key !== activeKey && scrollRef.current) scrollRef.current.scrollTop = 0;
    setActiveKey(key); setSearchQuery('');
    setVisited((current) => current.includes(key) ? current : [...current, key]);
  };
  useEffect(() => {
    if (searching) setVisited((current) => [...new Set([...current, ...items.map((item) => item.key)])]);
  }, [searching]);
  useEffect(() => {
    if (searching || !pendingTarget.current) return;
    const element = targets.current.get(pendingTarget.current) ?? document.getElementById(`setting-${pendingTarget.current}`);
    if (element) { interaction.reveal(element); pendingTarget.current = null; }
  }, [searching, activeKey, visited]);

  const body = (key: SettingsKey) => {
    switch (key) {
      case 'general':
      case 'about':
      case 'gui':
        return (
          <GuiSettingsSection
            category={key === 'gui' ? 'appearance' : key}
            apiStatus={statusText(apiStatus)}
            serverVersion={serverVersion}
          />
        );
      case 'agent':
      case 'environment':
      case 'permissions':
        return <AgentSettingsSection category={key} />;
      case 'llm':
        return <LlmSection active={!searching && activeKey === 'llm'} />;
      case 'plugins':
        return <PluginsSection />;
    }
  };

  const navigation = (
    <UiRegion slot="settings.navigation" data={{ kind: 'settingsNavigation',
      pages: items.map(item => ({ id: item.key, label: item.label, icon: item.icon })),
      activePage: activeKey, searchQuery,
    }} actions={{ setSettingsSearch: setSearchQuery, selectSettingsPage: id => {
      const item = items.find(item => item.key === id);
      if (!item) throw new Error('settings_page_unavailable');
      navigate(item.key);
    } }}><nav className="settings-nav" aria-label={t(language, 'settings.title')}>
        <div className="settings-nav__title">{t(language, 'settings.title')}</div>
        <label className="settings-search" aria-label={t(language, 'settings.search.placeholder')}>
          <span>{t(language, 'settings.search.label')}</span>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t(language, 'settings.search.placeholder')}
          />
        </label>
        <div className="settings-nav-group">
          {items.map((item) => (
            <button
              key={item.key}
              className={`settings-nav-item ${
                activeKey === item.key ? 'settings-nav-item--active' : ''
              }`}
              onClick={() => navigate(item.key)}
              aria-current={!searching && activeKey === item.key ? 'page' : undefined}
              type="button"
            >
              <span className="settings-nav-item__icon"><AchbitShellIcon name={item.icon} /></span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </nav></UiRegion>
  );

  return (
    <InteractionFocusContext.Provider value={interaction}><SettingsSearchTargets.Provider value={targets.current}><SettingsSearchContext.Provider value={register}><div className="settings-center"
      onPointerDownCapture={inheritedInteraction ? undefined : event => interaction.pointerDown(event.target)}
      onKeyDownCapture={inheritedInteraction ? undefined : event => interaction.keyDown(event.key)}>
      {navigationTarget ? createPortal(navigation, navigationTarget) : navigation}

      <section className="settings-body" ref={scrollRef}>
        {searching && <div className="settings-search-results">
          <h2 className="settings-title">{t(language, 'settings.search.results')}</h2>
          <p role="status">{t(language, 'settings.search.count', { count: matches.length })}</p>
          {matches.map((entry) => <button key={entry.id} type="button" className="settings-search-result" onClick={() => navigate(entry.category as SettingsKey, entry.id)}>
            <strong>{entry.title}</strong><span>{items.find((item) => item.key === entry.category)?.label}</span>
          </button>)}
          {!matches.length && <p>{t(language, 'settings.noSearchMatch')}</p>}
        </div>}
        {visited.map((key) => <div className="settings-page" id={`setting-page-${key}`} tabIndex={-1} key={key} hidden={searching || key !== activeKey}>{body(key)}</div>)}
      </section>
    </div></SettingsSearchContext.Provider></SettingsSearchTargets.Provider></InteractionFocusContext.Provider>
  );
};

export default SettingsCenter;
