import type { InteractionProjection } from '@achbit/protocol';
import { MarkdownInline } from './BufferedMarkdown';

/** Both answer surfaces submit the stable option ID, never its display label. */
export function InteractionOptions({ options, disabled, onAnswer }: {
  options: InteractionProjection['options'];
  disabled: boolean;
  onAnswer(response: string): void;
}) {
  if (!options?.length) return null;
  return <div className="local-agent__question-options">
    {options.map((option, index) => <button className="local-agent__question-choice" key={option.id} type="button" disabled={disabled}
      title={option.description ? `${option.label}\n\n${option.description}` : option.label}
      onClick={() => onAnswer(option.id)}>
      <span className="local-agent__question-option-marker" aria-hidden="true">{index + 1}</span>
      <span className="local-agent__question-option-copy">
        <strong><MarkdownInline>{option.label}</MarkdownInline></strong>
        {option.description && <span className="local-agent__question-description"><MarkdownInline>{option.description}</MarkdownInline></span>}
      </span>
    </button>)}
  </div>;
}
