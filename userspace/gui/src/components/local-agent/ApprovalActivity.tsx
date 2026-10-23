import type { ActivityProjection } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import AchbitShellIcon from '../shared/AchbitShellIcon';
import { useConversationRowState } from './ConversationVirtualRow';
import { ApprovalReviewReason } from './ApprovalReviewReason';

/** A view of the recorded request/decision; it never issues an authorization. */
export function ApprovalActivity({ activity, pending, reviewing, language, onExpand }: {
  activity: ActivityProjection;
  pending: boolean;
  reviewing: boolean;
  language: UiLanguage;
  onExpand(): void;
}) {
  const [expanded, setExpanded] = useConversationRowState(`approval:${activity.activityId}:expanded`, false);
  const status = activity.status === 'completed' ? 'accepted'
    : activity.status === 'denied' ? 'denied'
      : pending ? (reviewing ? 'reviewing' : 'waiting') : 'unanswered';
  return <article className="local-agent__approval-record">
    <button type="button" className="local-agent__approval-record-heading" aria-expanded={expanded}
      onClick={() => { if (!expanded) onExpand(); setExpanded((value) => !value); }}>
      <AchbitShellIcon name="hand" />
      <span>{t(language, `agent.approval.record.${status}`)}</span>
      <AchbitShellIcon name="chevronDown" className="conversation-disclosure-chevron" />
    </button>
    {expanded && <div className="local-agent__approval-record-body">
      <p>{activity.label}</p>
      <span className="local-agent__approval-record-status">{t(language, `agent.approval.record.${status}`)}</span>
    </div>}
    {activity.approvalReview && (expanded || activity.approvalReview.decision !== 'allow')
      && <ApprovalReviewReason review={activity.approvalReview} language={language} />}
  </article>;
}
