import { register as replaceDocumentWithMarkdown } from './replaceDocumentWithMarkdown.js';
import { register as appendMarkdownToGoogleDoc } from './appendMarkdownToGoogleDoc.js';
export function registerUtilsTools(server) {
    replaceDocumentWithMarkdown(server);
    appendMarkdownToGoogleDoc(server);
}
