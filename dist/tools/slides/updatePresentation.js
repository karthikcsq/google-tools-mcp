import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSlidesClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'updatePresentation',
        description:
            'Replace all slides in an existing Google Slides presentation with new content. Deletes existing slides and creates new ones with the provided title/content pairs.',
        parameters: z.object({
            presentationId: z.string().describe('Presentation ID'),
            slides: z
                .array(
                    z.object({
                        title: z.string().describe('Slide title'),
                        content: z.string().describe('Slide body content'),
                    }),
                )
                .min(1)
                .describe('Array of slide objects to replace existing slides'),
        }),
        execute: async (args, { log }) => {
            const slidesApi = await getSlidesClient();
            log.info(`Updating presentation: ${args.presentationId}`);

            try {
                const currentPresentation = await slidesApi.presentations.get({
                    presentationId: args.presentationId,
                });

                if (!currentPresentation.data.slides) {
                    throw new UserError('No slides found in presentation');
                }

                // Delete all slides except the first, then clear and rewrite the first
                const slideIdsToDelete = currentPresentation.data.slides
                    .slice(1)
                    .map((s) => s.objectId)
                    .filter(Boolean);

                const requests = [];

                // Delete extra slides
                for (const id of slideIdsToDelete) {
                    requests.push({ deleteObject: { objectId: id } });
                }

                // Clear text from the first slide's text elements
                const firstSlide = currentPresentation.data.slides[0];
                if (firstSlide?.pageElements) {
                    for (const el of firstSlide.pageElements) {
                        if (el.objectId && el.shape?.text) {
                            requests.push({ deleteText: { objectId: el.objectId, textRange: { type: 'ALL' } } });
                        }
                    }
                }

                // Insert new content into first slide
                const firstContent = args.slides[0];
                if (firstSlide?.pageElements) {
                    let titleId, bodyId;
                    for (const el of firstSlide.pageElements) {
                        const pt = el.shape?.placeholder?.type;
                        if (pt === 'TITLE' || pt === 'CENTERED_TITLE') titleId = el.objectId;
                        else if (pt === 'BODY' || pt === 'SUBTITLE') bodyId = el.objectId;
                    }
                    if (titleId) requests.push({ insertText: { objectId: titleId, text: firstContent.title, insertionIndex: 0 } });
                    if (bodyId) requests.push({ insertText: { objectId: bodyId, text: firstContent.content, insertionIndex: 0 } });
                }

                // Create additional slides
                for (let i = 1; i < args.slides.length; i++) {
                    requests.push({
                        createSlide: {
                            objectId: `slide_${Date.now()}_${i}`,
                            slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' },
                        },
                    });
                }

                await slidesApi.presentations.batchUpdate({
                    presentationId: args.presentationId,
                    requestBody: { requests },
                });

                // Populate new slides (index 1+)
                if (args.slides.length > 1) {
                    const updated = await slidesApi.presentations.get({ presentationId: args.presentationId });
                    const contentRequests = [];
                    for (let i = 1; i < args.slides.length && updated.data.slides; i++) {
                        const slide = args.slides[i];
                        const pageSlide = updated.data.slides[i];
                        if (!pageSlide?.pageElements) continue;
                        for (const el of pageSlide.pageElements) {
                            if (!el.objectId) continue;
                            const pt = el.shape?.placeholder?.type;
                            if (pt === 'TITLE' || pt === 'CENTERED_TITLE') {
                                contentRequests.push({ insertText: { objectId: el.objectId, text: slide.title, insertionIndex: 0 } });
                            } else if (pt === 'BODY' || pt === 'SUBTITLE') {
                                contentRequests.push({ insertText: { objectId: el.objectId, text: slide.content, insertionIndex: 0 } });
                            }
                        }
                    }
                    if (contentRequests.length > 0) {
                        await slidesApi.presentations.batchUpdate({
                            presentationId: args.presentationId,
                            requestBody: { requests: contentRequests },
                        });
                    }
                }

                return JSON.stringify(
                    {
                        presentationId: args.presentationId,
                        slidesUpdated: args.slides.length,
                        link: `https://docs.google.com/presentation/d/${args.presentationId}`,
                    },
                    null,
                    2,
                );
            } catch (error) {
                if (error instanceof UserError) throw error;
                log.error(`Error updating presentation: ${error.message || error}`);
                throw new UserError(`Failed to update presentation: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
