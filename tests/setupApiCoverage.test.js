import { describe, expect, it } from '@jest/globals';
import { REQUIRED_APIS } from '../dist/setup.js';

describe('guided setup API coverage', () => {
    it('enables every Google Workspace API needed by the default tool categories', () => {
        expect(REQUIRED_APIS).toEqual(expect.arrayContaining([
            'docs.googleapis.com',
            'sheets.googleapis.com',
            'drive.googleapis.com',
            'gmail.googleapis.com',
            'calendar-json.googleapis.com',
            'forms.googleapis.com',
            'slides.googleapis.com',
            'tasks.googleapis.com',
        ]));
    });
});
