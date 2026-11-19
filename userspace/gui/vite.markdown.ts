import { createRequire } from 'node:module';

// The parser runs in both a document and a worker. The default HTML entity table works in both realms.
const entities = 'decode-named-character-reference';
export const markdownAliases = { [entities]: createRequire(import.meta.url).resolve(entities) };
