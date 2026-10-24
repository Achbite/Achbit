import type { EffectPreview } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';

export function ApprovalReviewReason({ review, language }: {
  review: NonNullable<EffectPreview['review']>;
  language: UiLanguage;
}) {
  return <div className="local-agent__approval-review-reason">
    <strong>{t(language, `agent.approval.reviewReason.${review.decision}`)}</strong>
    <p>{review.reason}</p>
  </div>;
}
