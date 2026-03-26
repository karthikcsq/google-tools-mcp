// Gmail message processing helpers.
// Ported from @shinzolabs/gmail-mcp with minimal changes.

const RESPONSE_HEADERS_LIST = [
    'Date',
    'From',
    'To',
    'Subject',
    'Message-ID',
    'In-Reply-To',
    'References'
];

const decodedBody = (body) => {
    if (!body?.data) return body;
    const decodedData = Buffer.from(body.data, 'base64').toString('utf-8');
    return {
        data: decodedData,
        size: body.data.length,
        attachmentId: body.attachmentId
    };
};

export const processMessagePart = (messagePart, includeBodyHtml = false) => {
    if ((messagePart.mimeType !== 'text/html' || includeBodyHtml) && messagePart.body) {
        messagePart.body = decodedBody(messagePart.body);
    }
    if (messagePart.parts) {
        messagePart.parts = messagePart.parts.map(part => processMessagePart(part, includeBodyHtml));
    }
    if (messagePart.headers) {
        messagePart.headers = messagePart.headers.filter(header => RESPONSE_HEADERS_LIST.includes(header.name || ''));
    }
    return messagePart;
};

const getNestedHistory = (messagePart, level = 1) => {
    if (messagePart.mimeType === 'text/plain' && messagePart.body?.data) {
        const { data } = decodedBody(messagePart.body);
        if (!data) return '';
        return data.split('\n').map(line => '>' + (line.startsWith('>') ? '' : ' ') + line).join('\n');
    }
    return (messagePart.parts || []).map(p => getNestedHistory(p, level + 1)).filter(p => p).join('\n');
};

const findHeader = (headers, name) => {
    if (!headers || !Array.isArray(headers) || !name) return undefined;
    return headers.find(h => h?.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
};

const formatEmailList = (emailList) => {
    if (!emailList) return [];
    return emailList.split(',').map(email => email.trim());
};

const getQuotedContent = (thread) => {
    if (!thread.messages?.length) return '';
    const sentMessages = thread.messages.filter(msg =>
        msg.labelIds?.includes('SENT') ||
        (!msg.labelIds?.includes('DRAFT') && findHeader(msg.payload?.headers || [], 'date'))
    );
    if (!sentMessages.length) return '';
    const lastMessage = sentMessages[sentMessages.length - 1];
    if (!lastMessage?.payload) return '';
    let quotedContent = [];
    if (lastMessage.payload.headers) {
        const fromHeader = findHeader(lastMessage.payload.headers || [], 'from');
        const dateHeader = findHeader(lastMessage.payload.headers || [], 'date');
        if (fromHeader && dateHeader) {
            quotedContent.push('');
            quotedContent.push(`On ${dateHeader} ${fromHeader} wrote:`);
            quotedContent.push('');
        }
    }
    const nestedHistory = getNestedHistory(lastMessage.payload);
    if (nestedHistory) {
        quotedContent.push(nestedHistory);
        quotedContent.push('');
    }
    return quotedContent.join('\n');
};

const getThreadHeaders = (thread) => {
    let headers = [];
    if (!thread.messages?.length) return headers;
    const lastMessage = thread.messages[thread.messages.length - 1];
    const references = [];
    let subjectHeader = findHeader(lastMessage.payload?.headers || [], 'subject');
    if (subjectHeader) {
        if (!subjectHeader.toLowerCase().startsWith('re:')) {
            subjectHeader = `Re: ${subjectHeader}`;
        }
        headers.push(`Subject: ${subjectHeader}`);
    }
    const messageIdHeader = findHeader(lastMessage.payload?.headers || [], 'message-id');
    if (messageIdHeader) {
        headers.push(`In-Reply-To: ${messageIdHeader}`);
        references.push(messageIdHeader);
    }
    const referencesHeader = findHeader(lastMessage.payload?.headers || [], 'references');
    if (referencesHeader) references.unshift(...referencesHeader.split(' '));
    if (references.length > 0) headers.push(`References: ${references.join(' ')}`);
    return headers;
};

const wrapTextBody = (text) => text.split('\n').map(line => {
    if (line.length <= 76) return line;
    const chunks = line.match(/.{1,76}/g) || [];
    return chunks.join('=\n');
}).join('\n');

export const constructRawMessage = async (gmail, params) => {
    let thread = null;
    if (params.threadId) {
        const { data } = await gmail.users.threads.get({ userId: 'me', id: params.threadId, format: 'full' });
        thread = data;
    }
    const message = [];
    if (params.to?.length) message.push(`To: ${wrapTextBody(params.to.join(', '))}`);
    if (params.cc?.length) message.push(`Cc: ${wrapTextBody(params.cc.join(', '))}`);
    if (params.bcc?.length) message.push(`Bcc: ${wrapTextBody(params.bcc.join(', '))}`);
    if (thread) {
        message.push(...getThreadHeaders(thread).map(header => wrapTextBody(header)));
    } else if (params.subject) {
        message.push(`Subject: ${wrapTextBody(params.subject)}`);
    } else {
        message.push('Subject: (No Subject)');
    }
    message.push('Content-Type: text/plain; charset="UTF-8"');
    message.push('Content-Transfer-Encoding: quoted-printable');
    message.push('MIME-Version: 1.0');
    message.push('');
    if (params.body) message.push(wrapTextBody(params.body));
    if (thread) {
        const quotedContent = getQuotedContent(thread);
        if (quotedContent) {
            message.push('');
            message.push(wrapTextBody(quotedContent));
        }
    }
    return Buffer.from(message.join('\r\n')).toString('base64url').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
