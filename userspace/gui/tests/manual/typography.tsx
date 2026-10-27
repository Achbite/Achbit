// Isolated presentation fixture using real settings and typography components.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '@achbit/protocol';
import { useSettingsStore } from '../../src/state/settingsStore';
import GuiTypography from '../../src/theme/GuiTypography';
import GuiFontSettings from '../../src/components/settings-center/GuiFontSettings';
import { installPaletteDefaults } from '../../src/theme/palette';
import '../../src/achbit-gui/styles/achbitDesignTokens.css';
import '../../src/theme/paletteBase.css';
import '../../src/components/settings-center/settingsCenter.css';
import '../../src/components/settings-center/appearanceConfiguration.css';
import '../../src/components/local-agent/richContent.css';
import '../../src/components/shared/focus.css';

installPaletteDefaults();
const saved: UserSettings = {};
useSettingsStore.setState({ loading: false, effectiveSettings: { ...DEFAULT_USER_SETTINGS },
  patchUserSettingsBatch: async patches => {
    for (const [key, value] of Object.entries(patches)) {
      if (value === null) delete saved[key]; else saved[key] = value;
    }
    useSettingsStore.setState({ effectiveSettings: { ...DEFAULT_USER_SETTINGS, ...saved } });
    return 'immediate';
  },
});
function Preview() {
  return <><GuiTypography />
    <style>{`*{box-sizing:border-box}body{margin:0;background:var(--ac-background);color:var(--ac-foreground);font:var(--ac-font-body)/1.6 var(--ac-font-ui)}.font-review{max-width:780px;margin:48px auto;padding:0 28px}.font-review>h1{font-size:20px;font-weight:500;margin-bottom:24px}.font-review>.conversation-markdown{margin:32px 18px}.font-review .settings-card{border:0;background:none}.font-review .settings-card__title{background:none}button,select,input{font:inherit}.font-review code{font-family:var(--ac-font-code)}`}</style>
    <main className="font-review"><h1>外观 · 字体</h1><GuiFontSettings language="zh-CN" />
      <article className="conversation-markdown"><p>清楚地阅读，安静地思考。调整后的界面保持自然的中英文节奏，不用密集的色块打断阅读。</p>
        <p>Reading is a quiet conversation. Distinct letters, balanced spacing, and a comfortable rhythm.</p>
        <div className="conversation-code"><pre><code>{'const summary = "任务已完成";\nconst metrics = { cpu: 24, memory: 512 };\n// 中文注释与 English names'}</code></pre></div>
      </article>
    </main></>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
