import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSlidesClient } from '../../clients.js';

export function register(server) {
    // --- Get speaker notes ---
    server.addTool({
        name: 'getSpeakerNotes',
        description: 'Get the speaker notes from a specific slide in a Google Slides presentation.',
        parameters: z.object({
            presentationId: z.string().describe('Presentation ID'),
            slideIndex: z.number().min(0).describe('Slide index (0-based)'),
        }),
        execute: async (args, { log }) => {
            const slidesApi = await getSlidesClient();

            try {
                const presentation = await slidesApi.presentations.get({ presentationId: args.presentationId });
                const allSlides = presentation.data.slides || [];

                if (args.slideIndex >= allSlides.length) {
                    throw new UserError(`Slide index ${args.slideIndex} out of range (presentation has ${allSlides.length} slides)`);
                }

                const slide = allSlides[args.slideIndex];
                const notesObjectId = slide.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;

                if (!notesObjectId) {
                    return JSON.stringify({ slideIndex: args.slideIndex, notes: '' });
                }

                const notesPage = slide.slideProperties?.notesPage;
                const notesElement = notesPage?.pageElements?.find((el) => el.objectId === notesObjectId);

                let notesText = '';
                if (notesElement?.shape?.text?.textElements) {
                    for (const te of notesElement.shape.text.textElements) {
                        if (te.textRun?.content) notesText += te.textRun.content;
                    }
                }

                return JSON.stringify({ slideIndex: args.slideIndex, notes: notesText.trim() });
            } catch (error) {
                if (error instanceof UserError) throw error;
                log.error(`Error getting speaker notes: ${error.message || error}`);
                throw new UserError(`Failed to get speaker notes: ${error.message || 'Unknown error'}`);
            }
        },
    });

    // --- Update speaker notes ---
    server.addTool({
        name: 'updateSpeakerNotes',
        description: 'Update the speaker notes for a specific slide in a Google Slides presentation.',
        parameters: z.object({
            presentationId: z.string().describe('Presentation ID'),
            slideIndex: z.number().min(0).describe('Slide index (0-based)'),
            notes: z.string().describe('Speaker notes content'),
        }),
        execute: async (args, { log }) => {
            const slidesApi = await getSlidesClient();

            try {
                const presentation = await slidesApi.presentations.get({ presentationId: args.presentationId });
                const allSlides = presentation.data.slides || [];

                if (args.slideIndex >= allSlides.length) {
                    throw new UserError(`Slide index ${args.slideIndex} out of range (presentation has ${allSlides.length} slides)`);
                }

                const slide = allSlides[args.slideIndex];
                const notesObjectId = slide.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;

                if (!notesObjectId) {
                    throw new UserError('This slide does not have a speaker notes object.');
                }

                // Check if there's existing text to delete first
                const notesPage = slide.slideProperties?.notesPage;
                const notesElement = notesPage?.pageElements?.find((el) => el.objectId === notesObjectId);
                const hasExistingText = notesElement?.shape?.text?.textElements?.some((el) => el.textRun?.content);

                const requests = [];
                if (hasExistingText) {
                    requests.push({ deleteText: { objectId: notesObjectId, textRange: { type: 'ALL' } } });
                }
                requests.push({ insertText: { objectId: notesObjectId, text: args.notes, insertionIndex: 0 } });

                await slidesApi.presentations.batchUpdate({
                    presentationId: args.presentationId,
                    requestBody: { requests },
                });

                return JSON.stringify({ success: true, message: `Updated speaker notes for slide ${args.slideIndex}` });
            } catch (error) {
                if (error instanceof UserError) throw error;
                log.error(`Error updating speaker notes: ${error.message || error}`);
                throw new UserError(`Failed to update speaker notes: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
