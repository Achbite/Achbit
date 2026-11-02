import { createContext } from 'react';

/** Presentation identity follows canonical rows/artifacts, never text or React mount IDs. */
export interface RichContentTarget {
  sessionId: string;
  rowKey?: string;
  contentKey: string;
  blockKey?: string;
  nodeOffset?: string;
  artifactId?: string;
  location?: 'inline' | 'reader';
}
export const RichContentScope = createContext<RichContentTarget | null>(null);
