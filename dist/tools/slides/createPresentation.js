import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSlidesClient, getDriveClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'createPresentation',
        description:
            'Create a new Google Slides presentation with initial slides. Each slide has a title and content body using the TITLE_AND_BODY layout.',
        parameters: z.object({
            name: z.string().describe('Presentation name'),
            slides: z
                .array(
                    z.object({
                        title: z.string().describe('Slide title'),
                        content: z.string().describe('Slide body content'),
                    }),
                )
                .min(1)
                .describe('Array of slide objects with title and content'),
            parentFolderId: z.string().optional().describe('Parent Drive folder ID (defaults to root)'),
        }),
        execute: async (args, { log }) => {
            const slides = await getSlidesClient();
            const drive = await getDriveClient();
            log.info(`Creating presentation: ${args.name}`);

            try {
                // Create the presentation
                const presentation = await slides.presentations.create({
                    requestBody: { title: args.name },
                });
                const presentationId = presentation.data.presentationId;

                // Move to folder if specified
                if (args.parentFolderId) {
                    await drive.files.update({
                        fileId: presentationId,
                        addParents: args.parentFolderId,
                        removeParents: 'root',
                        supportsAllDrives: true,
                    });
                }

                // Create each slide and populate content
                for (const slide of args.slides) {
                    const slideObjectId = `slide_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
                    await slides.presentations.batchUpdate({
                        presentationId,
                        requestBody: {
                            requests: [
                                {
                                    createSlide: {
                                        objectId: slideObjectId,
                                        slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' },
                                    },
                                },
                            ],
                        },
                    });

                    // Get the slide to find placeholder IDs
                    const slidePage = await slides.presentations.pages.get({
                        presentationId,
                        pageObjectId: slideObjectId,
                    });

                    let titleId = '';
                    let bodyId = '';
                    for (const el of slidePage.data.pageElements || []) {
                        if (el.shape?.placeholder?.type === 'TITLE') titleId = el.objectId;
                        else if (el.shape?.placeholder?.type === 'BODY') bodyId = el.objectId;
                    }

                    const insertRequests = [];
                    if (titleId) insertRequests.push({ insertText: { objectId: titleId, text: slide.title, insertionIndex: 0 } });
                    if (bodyId) insertRequests.push({ insertText: { objectId: bodyId, text: slide.content, insertionIndex: 0 } });

                    if (insertRequests.length > 0) {
                        await slides.presentations.batchUpdate({
                            presentationId,
                            requestBody: { requests: insertRequests },
                        });
                    }
                }

                return JSON.stringify(
                    {
                        presentationId,
                        title: args.name,
                        link: `https://docs.google.com/presentation/d/${presentationId}`,
                        slidesCreated: args.slides.length,
                    },
                    null,
                    2,
                );
            } catch (error) {
                log.error(`Error creating presentation: ${error.message || error}`);
                if (error.code === 401) throw new UserError('Authentication failed. Try logging out and re-authenticating.');
                throw new UserError(`Failed to create presentation: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
