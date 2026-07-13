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

export const getNestedHistory = (messagePart, level = 1) => {
    if (messagePart.mimeType === 'text/plain' && messagePart.body?.data) {
        const { data } = decodedBody(messagePart.body);
        if (!data) return '';
        return data.split('\n').map(line => '>' + (line.startsWith('>') ? '' : ' ') + line).join('\n');
    }
    return (messagePart.parts || []).map(p => getNestedHistory(p, level + 1)).filter(p => p).join('\n');
};

export const findHeader = (headers, name) => {
    if (!headers || !Array.isArray(headers) || !name) return undefined;
    return headers.find(h => h?.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
};

export const formatEmailList = (emailList) => {
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

export const wrapTextBody = (text) => text.split('\n').map(line => {
    if (line.length <= 76) return line;
    const chunks = line.match(/.{1,76}/g) || [];
    return chunks.join('=\n');
}).join('\n');

// RFC 5322 line limits are measured in OCTETS, not UTF-16 code units. The raw
// message is serialized as UTF-8, so a non-ASCII subject or display name can
// blow past the 998-octet hard limit while `string.length` stays small. Measure
// with byte length, and when an over-length run has no foldable whitespace, cut
// it only at code-point boundaries so a multi-byte character (or a surrogate
// pair such as an emoji) is never split into a corrupt/replacement byte.
const byteLen = (str) => Buffer.byteLength(str, 'utf8');
const SOFT_LIMIT = 78; // recommended max octets per line (RFC 5322 §2.1.1)
const HARD_LIMIT = 998; // absolute max octets per line, excluding CRLF

// Slice `str` into a head of at most `maxBytes` octets ending on a code-point
// boundary, plus the untouched remainder. Iterating with Array.from walks
// Unicode code points, so surrogate pairs stay intact.
const sliceByBytes = (str, maxBytes) => {
    const codePoints = Array.from(str);
    let bytes = 0;
    let cut = codePoints.length;
    for (let i = 0; i < codePoints.length; i++) {
        const cpBytes = byteLen(codePoints[i]);
        if (bytes + cpBytes > maxBytes) { cut = i; break; }
        bytes += cpBytes;
    }
    return [codePoints.slice(0, cut).join(''), codePoints.slice(cut).join('')];
};

export const foldHeader = (name, value) => {
    const prefix = `${name}: `;
    const normalizedValue = String(value).replace(/(?:\r\n?|\n)[ \t]*/g, ' ');
    const unfolded = prefix + normalizedValue;
    if (byteLen(unfolded) <= SOFT_LIMIT) return unfolded;

    const lines = [];
    let line = prefix;
    const tokens = normalizedValue.match(/\S+(?:[ \t]+|$)/g) || [];
    for (const token of tokens) {
        const minBytes = line === prefix ? prefix.length : 1;
        if (byteLen(line) > minBytes && byteLen(line) + byteLen(token) > SOFT_LIMIT) {
            lines.push(line.trimEnd());
            line = ' ';
        }
        line += token;
        // A single token longer than the hard limit (e.g. a giant CJK subject or
        // an emoji run with no whitespace) can't be folded at WSP, so cut it on a
        // code-point boundary. The injected continuation space is unavoidable for
        // an unbreakable >998-octet run, but it never corrupts a character.
        while (byteLen(line) > HARD_LIMIT) {
            const [head, rest] = sliceByBytes(line, HARD_LIMIT);
            lines.push(head);
            line = ' ' + rest;
        }
    }
    lines.push(line.trimEnd());
    return lines.join('\r\n');
};

export const isHtmlBody = (text) => /<\/?[a-z][\s\S]*?>/i.test(text);

export const constructRawMessage = async (gmail, params) => {
    let thread = null;
    if (params.threadId) {
        const { data } = await gmail.users.threads.get({ userId: 'me', id: params.threadId, format: 'full' });
        thread = data;
    }
    const message = [];
    if (params.to?.length) message.push(foldHeader('To', params.to.join(', ')));
    if (params.cc?.length) message.push(foldHeader('Cc', params.cc.join(', ')));
    if (params.bcc?.length) message.push(foldHeader('Bcc', params.bcc.join(', ')));
    if (thread) {
        message.push(...getThreadHeaders(thread).map(header => {
            const separator = header.indexOf(':');
            return foldHeader(header.slice(0, separator), header.slice(separator + 2));
        }));
    } else if (params.subject) {
        message.push(foldHeader('Subject', params.subject));
    } else {
        message.push('Subject: (No Subject)');
    }
    const htmlMode = params.body && isHtmlBody(params.body);
    message.push(`Content-Type: ${htmlMode ? 'text/html' : 'text/plain'}; charset="UTF-8"`);
    message.push('Content-Transfer-Encoding: quoted-printable');
    message.push('MIME-Version: 1.0');
    message.push('');
    if (params.body) message.push(htmlMode ? params.body : wrapTextBody(params.body));
    if (thread) {
        const quotedContent = getQuotedContent(thread);
        if (quotedContent) {
            message.push('');
            message.push(wrapTextBody(quotedContent));
        }
    }
    return Buffer.from(message.join('\r\n')).toString('base64url').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const constructRawMessageWithAttachments = async (gmail, params) => {
    let thread = null;
    if (params.threadId) {
        const { data } = await gmail.users.threads.get({ userId: 'me', id: params.threadId, format: 'full' });
        thread = data;
    }
    const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const headers = [];
    if (params.to?.length) headers.push(foldHeader('To', params.to.join(', ')));
    if (params.cc?.length) headers.push(foldHeader('Cc', params.cc.join(', ')));
    if (params.bcc?.length) headers.push(foldHeader('Bcc', params.bcc.join(', ')));
    if (thread) {
        headers.push(...getThreadHeaders(thread).map(header => {
            const separator = header.indexOf(':');
            return foldHeader(header.slice(0, separator), header.slice(separator + 2));
        }));
    } else if (params.subject) {
        headers.push(foldHeader('Subject', params.subject));
    } else {
        headers.push('Subject: (No Subject)');
    }
    headers.push('MIME-Version: 1.0');
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts = [];
    // Text body part
    let bodyText = params.body || '';
    if (thread) {
        const quotedContent = getQuotedContent(thread);
        if (quotedContent) bodyText += '\n\n' + quotedContent;
    }
    const htmlMode = isHtmlBody(bodyText);
    parts.push([
        `--${boundary}`,
        `Content-Type: ${htmlMode ? 'text/html' : 'text/plain'}; charset="UTF-8"`,
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(bodyText).toString('base64'),
    ].join('\r\n'));
    // Attachment parts
    for (const att of params.attachments) {
        const attHeaders = [
            `--${boundary}`,
            `Content-Type: ${att.mimeType}; name="${att.filename}"`,
            'Content-Transfer-Encoding: base64',
            `Content-Disposition: attachment; filename="${att.filename}"`,
            '',
            att.base64Data,
        ];
        parts.push(attHeaders.join('\r\n'));
    }
    const raw = [
        headers.join('\r\n'),
        '',
        parts.join('\r\n'),
        `--${boundary}--`,
    ].join('\r\n');
    return Buffer.from(raw).toString('base64url').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const getPlainTextBody = (messagePart) => {
    if (messagePart.mimeType === 'text/plain' && messagePart.body?.data) {
        return Buffer.from(messagePart.body.data, 'base64').toString('utf-8');
    }
    if (messagePart.parts) {
        for (const part of messagePart.parts) {
            const text = getPlainTextBody(part);
            if (text) return text;
        }
    }
    return '';
};

export const formatMessageClean = (message, maxBodyChars = 3000) => {
    const headers = message.payload?.headers || [];
    const get = (name) => findHeader(headers, name);
    let body = getPlainTextBody(message.payload) || '';
    const totalChars = body.length;
    const truncated = maxBodyChars > 0 && body.length > maxBodyChars;
    if (truncated) body = body.slice(0, maxBodyChars);
    return {
        id: message.id,
        threadId: message.threadId,
        labelIds: message.labelIds,
        snippet: message.snippet,
        from: get('from'),
        to: get('to'),
        cc: get('cc'),
        subject: get('subject'),
        date: get('date'),
        body,
        ...(truncated ? { bodyTruncated: true, totalChars } : {}),
    };
};

export const formatMessageMetadata = (message) => {
    const headers = message.payload?.headers || [];
    const get = (name) => findHeader(headers, name);
    return {
        id: message.id,
        threadId: message.threadId,
        labelIds: message.labelIds,
        snippet: message.snippet,
        from: get('from'),
        to: get('to'),
        cc: get('cc'),
        subject: get('subject'),
        date: get('date'),
    };
};
