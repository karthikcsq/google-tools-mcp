import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSlidesClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'getPresentation',
        description:
            'Get the content of a Google Slides presentation with element IDs for formatting. Optionally retrieve a single slide by index.',
        parameters: z.object({
            presentationId: z.string().describe('Presentation ID'),
            slideIndex: z.number().min(0).optional().describe('Specific slide index (0-based). Omit to get all slides.'),
        }),
        execute: async (args, { log }) => {
            const slidesApi = await getSlidesClient();
            log.info(`Reading presentation: ${args.presentationId}`);

            try {
                const presentation = await slidesApi.presentations.get({
                    presentationId: args.presentationId,
                });

                if (!presentation.data.slides) {
                    throw new UserError('No slides found in presentation');
                }

                const allSlides = presentation.data.slides;
                const slides =
                    args.slideIndex !== undefined ? [allSlides[args.slideIndex]] : allSlides;

                const result = {
                    title: presentation.data.title,
                    presentationId: args.presentationId,
                    totalSlides: allSlides.length,
                    slides: slides.map((slide, idx) => {
                        if (!slide?.objectId) return null;
                        const slideInfo = {
                            index: args.slideIndex ?? idx,
                            objectId: slide.objectId,
                            elements: [],
                        };

                        for (const el of slide.pageElements || []) {
                            if (!el.objectId) continue;
                            if (el.shape?.text) {
                                let text = '';
                                for (const te of el.shape.text.textElements || []) {
                                    if (te.textRun?.content) text += te.textRun.content;
                                }
                                slideInfo.elements.push({
                                    type: 'text',
                                    objectId: el.objectId,
                                    placeholderType: el.shape.placeholder?.type || null,
                                    text: text.trim(),
                                });
                            } else if (el.shape) {
                                slideInfo.elements.push({
                                    type: 'shape',
                                    objectId: el.objectId,
                                    shapeType: el.shape.shapeType || 'Unknown',
                                });
                            } else if (el.image) {
                                slideInfo.elements.push({ type: 'image', objectId: el.objectId });
                            } else if (el.video) {
                                slideInfo.elements.push({ type: 'video', objectId: el.objectId });
                            } else if (el.table) {
                                slideInfo.elements.push({
                                    type: 'table',
                                    objectId: el.objectId,
                                    rows: el.table.rows,
                                    columns: el.table.columns,
                                });
                            }
                        }
                        return slideInfo;
                    }).filter(Boolean),
                };

                return JSON.stringify(result, null, 2);
            } catch (error) {
                if (error instanceof UserError) throw error;
                log.error(`Error reading presentation: ${error.message || error}`);
                throw new UserError(`Failed to read presentation: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
