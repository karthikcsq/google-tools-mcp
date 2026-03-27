import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getFormsClient } from '../../clients.js';

function extractOptionValues(options) {
    if (!options) return [];
    return options.filter((o) => o.value).map((o) => {
        const opt = { value: o.value };
        if (o.isOther) opt.isOther = true;
        if (o.image) opt.image = o.image;
        if (o.goToAction) opt.goToAction = o.goToAction;
        if (o.goToSectionId) opt.goToSectionId = o.goToSectionId;
        return opt;
    });
}

function getQuestionType(question) {
    if (question.choiceQuestion) return question.choiceQuestion.type || 'RADIO';
    if (question.textQuestion) {
        return question.textQuestion.paragraph ? 'PARAGRAPH' : 'TEXT';
    }
    if (question.scaleQuestion) return 'SCALE';
    if (question.dateQuestion) return 'DATE';
    if (question.timeQuestion) return 'TIME';
    if (question.fileUploadQuestion) return 'FILE_UPLOAD';
    if (question.ratingQuestion) return 'RATING';
    if (question.rowQuestion) return 'GRID_ROW';
    return 'QUESTION';
}

function serializeFormItem(item, index) {
    const result = {
        index,
        itemId: item.itemId,
        title: item.title || '',
        description: item.description || '',
    };

    if (item.questionItem) {
        const q = item.questionItem.question;
        result.type = getQuestionType(q);
        result.required = q.required || false;
        result.questionId = q.questionId || null;
        if (q.choiceQuestion) {
            result.options = extractOptionValues(q.choiceQuestion.options);
        }
    } else if (item.questionGroupItem) {
        const group = item.questionGroupItem;
        result.type = 'GRID';
        result.grid = {
            columns: group.grid?.columns?.options
                ? extractOptionValues(group.grid.columns.options)
                : [],
        };
        if (group.questions) {
            result.grid.rows = group.questions.map((q) => ({
                questionId: q.questionId,
                title: q.rowQuestion?.title || '',
                required: q.required || false,
            }));
        }
    } else if (item.pageBreakItem !== undefined) {
        result.type = 'PAGE_BREAK';
    } else if (item.textItem !== undefined) {
        result.type = 'TEXT_ITEM';
    } else if (item.imageItem) {
        result.type = 'IMAGE';
    } else if (item.videoItem) {
        result.type = 'VIDEO';
    } else {
        result.type = 'UNKNOWN';
    }

    return result;
}

export function register(server) {
    server.addTool({
        name: 'get_form',
        description:
            'Retrieves a Google Form by ID. Returns the form title, description, URLs, and all items (questions, sections, images, etc.) with their types, options, and metadata.',
        parameters: z.object({
            formId: z.string().describe('The ID of the Google Form to retrieve'),
        }),
        execute: async (args, { log }) => {
            const forms = await getFormsClient();
            log.info(`Getting form: ${args.formId}`);

            try {
                const response = await forms.forms.get({ formId: args.formId });
                const form = response.data;
                const items = (form.items || []).map((item, i) => serializeFormItem(item, i));

                return JSON.stringify(
                    {
                        formId: form.formId,
                        title: form.info?.title || '',
                        description: form.info?.description || '',
                        documentTitle: form.info?.documentTitle || '',
                        editUrl: `https://docs.google.com/forms/d/${form.formId}/edit`,
                        responderUrl:
                            form.responderUri || `https://docs.google.com/forms/d/${form.formId}/viewform`,
                        itemCount: items.length,
                        items,
                    },
                    null,
                    2,
                );
            } catch (error) {
                log.error(`Error getting form: ${error.message || error}`);
                if (error.code === 401)
                    throw new UserError('Authentication failed. Try logging out and re-authenticating.');
                if (error.code === 404) throw new UserError(`Form not found: ${args.formId}`);
                throw new UserError(`Failed to get form: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
