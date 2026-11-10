import { useContext, useRef, type ReactNode } from 'react';
import { useUiOwner } from '../../ui-ownership/useUiOwner';
import { ContentImageSave } from './ContentImageSave';
import { elementImage } from './contentImage';
import { RichContentScope } from './RichContentIdentity';

export function MathContent({ children }: { children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  const target = useContext(RichContentScope);
  const identity = useUiOwner('conversation.math', undefined, { ...target });
  return <div className="conversation-math">
    <ContentImageSave {...(target ? identity.action('save', 'click') : {})}
      createImage={() => elementImage(content.current, 'formula')} />
    <div ref={content} className="conversation-math__content">{children}</div>
  </div>;
}
