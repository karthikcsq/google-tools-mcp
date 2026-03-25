import { register as applyTextStyle } from './applyTextStyle.js';
import { register as applyParagraphStyle } from './applyParagraphStyle.js';
export function registerFormattingTools(server) {
    applyTextStyle(server);
    applyParagraphStyle(server);
}
