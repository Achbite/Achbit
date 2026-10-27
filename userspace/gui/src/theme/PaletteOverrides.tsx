import { useSettingsStore } from '../state/settingsStore';
import { PALETTE_SETTING, paletteOverrideCss } from './palette';

export default function PaletteOverrides() {
  const encoded = String(useSettingsStore((state) => state.effectiveSettings[PALETTE_SETTING]) ?? '{}');
  const language = useSettingsStore((state) => state.effectiveSettings['workbench.language']);
  try {
    return <style data-achbit-palette="user">{paletteOverrideCss(encoded)}</style>;
  } catch (reason) {
    return <div className="ui-palette-error" role="alert">
      <span>{language === 'zh-CN' ? '配色配置无法应用：' : 'Unable to apply palette: '}{String(reason)}</span>
      <button type="button" onClick={() => void useSettingsStore.getState().resetUserSetting(PALETTE_SETTING)}>
        {language === 'zh-CN' ? '恢复默认配色' : 'Restore default colors'}
      </button>
    </div>;
  }
}
