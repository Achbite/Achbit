import type { ArtifactProjection, SessionProjection } from '@achbit/protocol';

interface Entry { parent: WeakRef<SessionProjection>; artifacts: ArtifactProjection[]; children: Set<string> }
type Observer = (sessionId: string | null) => void;

/** Derived output metadata belongs to the window that observed these parent and child Sessions. */
export class ChildDeliveryIndex {
  private entries = new Map<string, Entry>();
  private observers = new Set<Observer>();
  private observing = false;

  get connected() { return this.observing; }

  subscribe(observer: Observer) {
    this.observers.add(observer);
    return () => { this.observers.delete(observer); };
  }

  connection(ready: boolean) {
    this.observing = ready;
    this.entries.clear();
    for (const observer of this.observers) observer(null);
  }

  changed(id: string) {
    for (const [key, entry] of this.entries) {
      if (id === key || entry.children.has(id) || !entry.parent.deref()) this.entries.delete(key);
    }
    for (const observer of this.observers) observer(id);
  }

  get(parent: SessionProjection, members?: Set<string>) {
    const entry = this.entries.get(parent.sessionId);
    if (!this.observing || entry?.parent.deref() !== parent) return undefined;
    this.entries.delete(parent.sessionId);
    this.entries.set(parent.sessionId, entry);
    if (members) for (const child of entry.children) members.add(child);
    return entry.artifacts;
  }

  save(parent: SessionProjection, children: Set<string>, artifacts: ArtifactProjection[],
    changes: ReadonlySet<string | null>) {
    if (changes.has(null) || changes.has(parent.sessionId) || [...children].some(id => changes.has(id))) return;
    if (!this.observing || typeof WeakRef !== 'function'
      || (parent.run && parent.run.status !== 'completed') || parent.assistantDraft
      || parent.agentTasks?.some(task => task.status === 'running') || artifacts.length > 256 || children.size > 256) return;
    this.entries.delete(parent.sessionId);
    if (this.entries.size >= 6) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(parent.sessionId, { parent: new WeakRef(parent), children, artifacts });
  }
}
