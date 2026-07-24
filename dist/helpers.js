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

const decodedBody = (body, maxBodyChars = 0) => {
    if (!body?.data) return body;
    const decodedData = Buffer.from(body.data, 'base64').toString('utf-8');
    const truncated = maxBodyChars > 0 && decodedData.length > maxBodyChars;
    return {
        data: truncated ? decodedData.slice(0, maxBodyChars) : decodedData,
        size: body.data.length,
        attachmentId: body.attachmentId,
        ...(truncated ? { bodyTruncated: true, totalChars: decodedData.length } : {}),
    };
};

export const processMessagePart = (messagePart, includeBodyHtml = false, maxBodyChars = 0) => {
    if ((messagePart.mimeType !== 'text/html' || includeBodyHtml) && messagePart.body) {
        const bodyLimit = messagePart.mimeType?.startsWith('text/') ? maxBodyChars : 0;
        messagePart.body = decodedBody(messagePart.body, bodyLimit);
    } else if (messagePart.body?.data && maxBodyChars > 0) {
        // Parts left undecoded (e.g. text/html without includeBodyHtml) still
        // carry their full base64 payload — the main size offender in full
        // mode. We can't slice raw base64 to bound it: cutting at an arbitrary
        // offset yields invalid, non-portable base64 and a totalChars measured
        // in encoded (not decoded) characters. Instead, decode just to measure,
        // and when the body exceeds the cap drop the payload entirely, leaving
        // valid truncation metadata (decoded totalChars) in its place.
        //
        // The cap has to consider both measures. What the client actually
        // receives is the base64 string, which runs about four characters per
        // three bytes of body, and non-ASCII text costs several bytes per
        // character. So 3,000 characters of CJK HTML decode well under a
        // 10,000 character cap while returning roughly 12,000 characters of
        // base64. Gate on whichever measure is larger.
        const encodedChars = messagePart.body.data.length;
        const decodedChars = Buffer.from(messagePart.body.data, 'base64').toString('utf-8').length;
        if (decodedChars > maxBodyChars || encodedChars > maxBodyChars) {
            messagePart.body = {
                size: messagePart.body.size ?? encodedChars,
                attachmentId: messagePart.body.attachmentId,
                bodyOmitted: true,
                totalChars: decodedChars,
                encodedChars,
            };
        }
    }
    if (messagePart.parts) {
        messagePart.parts = messagePart.parts.map(part => processMessagePart(part, includeBodyHtml, maxBodyChars));
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
// blow past the 998-octet hard limit while `string.length` stays small.
// Measure with byte length so wrapping decisions account for multi-byte UTF-8
// octets.
//
// Folding (a CRLF followed by WSP) is only legal at a point where folding
// white space is already allowed (RFC 5322 §2.2.3, §3.2.2). A run of
// characters with no internal whitespace has no such point: a message-id
// atom "does not have internal CFWS anywhere in the message identifier"
// (§3.6.4), an address atom is likewise unbreakable, and an RFC 2047
// encoded-word's encoded-text "MUST NOT be continued from one encoded-word
// to another" (RFC 2047 §2). Even for a plain unstructured run (e.g. a CJK
// or emoji subject with no spaces), inserting a fold is not safe: §2.2.3
// defines unfolding as "simply removing any CRLF that is immediately
// followed by WSP" - the CRLF is removed, but the WSP is NOT, so an
// injected fold leaves a permanent extra space in the decoded value that
// was never in the original. The only RFC-safe behavior for a wordless,
// over-length token is to leave it unfolded on its own line, even if that
// line then exceeds the 998-octet hard limit: an overlong line is a
// robustness concern (§2.1.1, "Individual implementations MAY choose to
// include higher limits"), whereas splitting the token would corrupt a
// structured value (breaking Message-ID/References matching, or DKIM
// signatures over the raw header bytes) or silently change an unstructured
// one.
const byteLen = (str) => Buffer.byteLength(str, 'utf8');
const SOFT_LIMIT = 78; // recommended max octets per line (RFC 5322 §2.1.1)

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
        // Tokens are only ever joined at existing whitespace (see the regex
        // above), which is the one place FWS is unconditionally legal. A
        // single token that is itself over-length (a long message-id, an
        // address, an encoded-word, or a wordless CJK/emoji run) is never
        // split internally - it just becomes a long line, folded away from
        // its neighbors on the next token boundary.
        line += token;
    }
    lines.push(line.trimEnd());
    return lines.join('\r\n');
};

// getThreadHeaders returns pre-joined "Name: value" strings; split on the
// first colon (header field-names are always ASCII and never contain one)
// and re-fold the value so threading headers (Subject/In-Reply-To/References)
// get the same RFC 5322 folding as To/Cc/Bcc/Subject above.
const foldThreadHeader = (header) => {
    const separator = header.indexOf(':');
    return foldHeader(header.slice(0, separator), header.slice(separator + 2));
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
        message.push(...getThreadHeaders(thread).map(foldThreadHeader));
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
        headers.push(...getThreadHeaders(thread).map(foldThreadHeader));
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

export const stripQuotedHistory = (text) => {
    if (!text) return text;
    const lines = text.split(/\r?\n/);
    // A bare ">" line is deliberately NOT a marker: senders legitimately author
    // ">"-prefixed excerpts (pasted shell output, manual quotes). Only a real
    // attribution marker opens a strip.
    let stripFrom = -1;
    // A hard delimiter is an unambiguous "everything below is the original"
    // separator (Outlook's "-----Original Message-----"). Clients emit it on its
    // own line and never author reply text after it, so we strip the tail
    // unconditionally — even when the quoted original carries no ">" prefixes,
    // which is the common Outlook case the ">"-only check used to miss.
    let hardDelimiter = false;
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i.test(lines[i])) {
            stripFrom = i;
            hardDelimiter = true;
            break;
        }
        if (/^\s*On .+ wrote:\s*$/i.test(lines[i])) {
            let next = i + 1;
            while (next < lines.length && /^\s*$/.test(lines[next])) next++;
            if (next < lines.length && /^\s*>/.test(lines[next])) {
                stripFrom = i;
                break;
            }
        }
        if (/^\s*From:\s*.+/i.test(lines[i])) {
            let next = i + 1;
            while (next < lines.length && /^\s*$/.test(lines[next])) next++;
            if (next < lines.length && /^\s*Sent:\s*.+/i.test(lines[next])) {
                stripFrom = i;
                break;
            }
        }
    }
    if (stripFrom === -1) return text;
    if (hardDelimiter) return lines.slice(0, stripFrom).join('\n').replace(/\s+$/, '');
    // Otherwise only strip when everything after the marker is quoted/attribution/blank
    // AND at least one line is actually ">"-quoted. Inline repliers and
    // bottom-posters put real content below or between quoted blocks, and a
    // trailing block of bare header-like lines (a pasted invite, a signature)
    // is not reply history — stripping either would silently lose content.
    const attributionLine = /^\s*(On .+ wrote:|-{2,}\s*Original Message\s*-{2,}|(From|Sent|To|Cc|Subject|Date):\s.*)\s*$/i;
    let sawQuotedLine = false;
    for (let i = stripFrom; i < lines.length; i++) {
        if (/^\s*>/.test(lines[i])) {
            sawQuotedLine = true;
            continue;
        }
        if (/^\s*$/.test(lines[i]) || attributionLine.test(lines[i])) continue;
        return text;
    }
    if (!sawQuotedLine) return text;
    return lines.slice(0, stripFrom).join('\n').replace(/\s+$/, '');
};

export const formatMessageClean = (message, maxBodyChars = 3000, includeQuoted = false) => {
    const headers = message.payload?.headers || [];
    const get = (name) => findHeader(headers, name);
    let body = getPlainTextBody(message.payload) || '';
    const strippedBody = includeQuoted ? body : stripQuotedHistory(body);
    const quotedHistoryStripped = strippedBody !== body;
    body = strippedBody;
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
        ...(quotedHistoryStripped ? { quotedHistoryStripped: true } : {}),
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
