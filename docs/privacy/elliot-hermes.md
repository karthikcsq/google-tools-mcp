# Privacy policy: Elliot Drel's Google Tools MCP integration

Effective date: October 6, 2026

## Scope and operator

This policy covers Elliot Drel's personal Google OAuth application, currently named **mcp**, used to connect Google Tools MCP to his Hermes assistant. Elliot Drel operates this integration. Homepage: https://elliotdrel.com. Contact: elliotdrel@gmail.com.

This is an operator-specific policy, not a privacy policy for every deployment of the Google Tools MCP open-source project. Other operators are responsible for their own deployments and policies.

## Google data accessed and why

With the account holder's Google authorization, the integration can access the Google services covered by the granted permissions: Drive files and metadata; Docs, Sheets, Slides and Forms content and responses; Gmail messages, attachments, drafts and settings; Calendar events; and Tasks. Permissions may also allow managing the Google Cloud APIs required for setup.

The integration uses this access to carry out the account holder's requested assistant tasks, such as finding and summarizing information, creating or editing documents, managing email, scheduling events and maintaining tasks. Granted permissions can include modification, sending and deletion, not just reading. Authorization can persist through a saved refresh token until revoked or otherwise invalidated.

## Processing, storage and sharing

Google Tools MCP runs on the operator's machine and communicates with Google's APIs. OAuth credentials and tokens are stored in the operator's local configuration. Retrieved content, tool results, document working copies and operational records may be retained by the integration or Hermes in local files, conversation history and logs.

When Google content is supplied to Hermes for a task, relevant content and tool results may be sent to the configured AI provider for processing. Responses may also be delivered to the configured chat service, including Discord, and are then subject to that service's access controls and retention policies. Information may be sent to other recipients when the account holder requests an action such as sending an email or sharing a document. This integration is therefore not a promise that Google data stays exclusively on the local machine.

The operator does not sell Google user data or use it for advertising. Google user data is used only to provide the requested integration functionality, not to develop, improve or train generalized AI or machine-learning models. Any AI provider used to process Google data must be configured and used consistently with these restrictions and the Google API Services User Data Policy. The open-source repository is not a destination for account data, OAuth tokens or credentials.

## Protection and retention

Google API requests use encrypted HTTPS connections. Access to local credentials, stored data and assistant history is controlled by the operator's machine and service account protections. Tokens and credentials must not be committed to public repositories or included in public messages.

Saved authorization is retained to support continued use until revoked or removed. Local copies, conversation history and logs remain until deleted under the operator's configuration; there is no fixed automatic deletion period promised by this policy. Google, the AI provider and chat services have their own retention policies. This policy does not claim that removing local files also erases copies held by those services.

## Revocation and deletion

The account holder can revoke the application's Google access at https://myaccount.google.com/connections. Revocation prevents further authorized access but does not automatically remove previously saved local copies or assistant history.

For deletion of integration-held data, contact elliotdrel@gmail.com. The operator can remove saved OAuth credentials and tokens, local working copies, logs and conversation records under his control. Data held by Google or other services must also be managed through those services' controls. Deleting integration copies does not itself delete original Google emails, documents or events.

## Google API Services User Data Policy

This integration's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including its Limited Use requirements: https://developers.google.com/terms/api-services-user-data-policy.

## Changes and contact

Updates will be published in this document with a revised effective date. Questions about this personal integration or this policy can be sent to elliotdrel@gmail.com.
