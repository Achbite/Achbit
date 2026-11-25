import type { UsageTotals } from '@achbit/protocol';
import { formatUsageCost, useUsageCostDisplay } from '../../../ui-plugins/usageCost';
import { ModelSettingsHelp } from './ModelSettingsHelp';
import { useModelLanguage } from './modelServiceSettings';

export function useMoneyFormatter() {
  const display = useUsageCostDisplay();
  const { language } = useModelLanguage();
  return (value: number | null | undefined) => formatUsageCost(value, display, language);
}
export function UsageCost({ totals }: { totals?: UsageTotals }) {
  const { text } = useModelLanguage();
  const money = useMoneyFormatter();
  const partial = totals && totals.pricedCalls < totals.calls;
  return <span>{money(totals?.estimatedCost)}{partial && totals.estimatedCost !== null && <ModelSettingsHelp label="*">{text('仅汇总已取得用量和官方价格的部分，未计价项不记作零。', 'Only reported, priced usage is included. Unknown charges are not zero.')}</ModelSettingsHelp>}</span>;
}
