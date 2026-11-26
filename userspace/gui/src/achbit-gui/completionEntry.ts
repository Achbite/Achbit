import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { installPaletteDefaults } from '../theme/palette';
import { applyCompletionAppearance } from '../theme/completionAppearance';
import CompletionReminderCard, { readCompletionNotice } from './CompletionReminderCard';
import '../theme/builtinFonts.css';
import './styles/achbitDesignTokens.css';
import './styles/completionReminder.css';

const params = new URLSearchParams(location.search);
installPaletteDefaults();
applyCompletionAppearance(params.get('appearance'));
createRoot(document.getElementById('root')!).render(createElement(CompletionReminderCard, { notice: readCompletionNotice(params) }));
