export interface ReadingPosition {
  createdAt: string;
  sequence: number;
  key: string;
  offset: number;
}

const positionKey = 'achbit:transcript-positions';
let positions: Map<string, ReadingPosition> | undefined;
function recentPositions() {
  if (!positions) {
    positions = new Map();
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(positionKey) ?? '[]');
      if (Array.isArray(saved)) for (const item of saved.slice(-16)) {
        if (!Array.isArray(item) || typeof item[0] !== 'string') continue;
        const value = item[1];
        if (value && typeof value.createdAt === 'string' && typeof value.key === 'string'
          && Number.isSafeInteger(value.sequence) && value.sequence > 0 && Number.isFinite(value.offset)) positions.set(item[0], value);
      }
    } catch { /* The view also works with window-local positions when storage is unavailable. */ }
  }
  return positions;
}

export function readPosition(sessionId: string, createdAt?: string) {
  const position = recentPositions().get(sessionId);
  return position?.createdAt === createdAt ? position : undefined;
}

export function writePosition(sessionId: string, position: ReadingPosition | null) {
  const saved = recentPositions();
  if (!position && !saved.has(sessionId)) return;
  saved.delete(sessionId);
  if (position) saved.set(sessionId, position);
  if (saved.size > 16) saved.delete(saved.keys().next().value!);
  try { localStorage.setItem(positionKey, JSON.stringify([...saved])); }
  catch { /* Retain the current window's navigation when disk storage is unavailable. */ }
}
