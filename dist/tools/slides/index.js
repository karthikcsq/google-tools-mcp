import { register as createPresentation } from './createPresentation.js';
import { register as updatePresentation } from './updatePresentation.js';
import { register as getPresentation } from './getPresentation.js';
import { register as formatText } from './formatText.js';
import { register as formatParagraph } from './formatParagraph.js';
import { register as styleShape } from './styleShape.js';
import { register as setBackground } from './setBackground.js';
import { register as createTextBox } from './createTextBox.js';
import { register as createShape } from './createShape.js';
import { register as speakerNotes } from './speakerNotes.js';
import { register as deleteSlide } from './deleteSlide.js';
import { register as duplicateSlide } from './duplicateSlide.js';
import { register as reorderSlides } from './reorderSlides.js';
import { register as replaceAllText } from './replaceAllText.js';
import { register as exportThumbnail } from './exportThumbnail.js';

export function registerSlidesTools(server) {
    createPresentation(server);
    updatePresentation(server);
    getPresentation(server);
    formatText(server);
    formatParagraph(server);
    styleShape(server);
    setBackground(server);
    createTextBox(server);
    createShape(server);
    speakerNotes(server);
    deleteSlide(server);
    duplicateSlide(server);
    reorderSlides(server);
    replaceAllText(server);
    exportThumbnail(server);
}
