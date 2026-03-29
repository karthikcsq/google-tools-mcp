import { register as applyParagraphStyle } from './applyParagraphStyle.js';
import { register as getFormatting } from './getFormatting.js';
export function registerFormattingTools(server) {
    applyParagraphStyle(server);
    getFormatting(server);
}
