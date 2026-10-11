/** WhatsApp messages: what the server sends, and the one place a message is handed to WhatsApp. */
import { api } from './api';
import { Role } from './types';
import { Tone, notify } from './ui';

export interface Message {
  id: string;
  status: 'waiting' | 'approved' | 'sent' | 'failed' | 'discarded' | 'received' | 'handled';
  source: 'rule' | 'template' | 'manual' | 'campaign' | 'reply';
  kind: 'care' | 'greetings';
  title: string;
  body: string;
  patient: { id: string; name: string; archived: boolean };
  to: string;
  context: string;
  template: { name: string; version: number } | null;
  /** Why it cannot go now, in plain words. Empty when it can. */
  blocked: string;
  consent: { kind: string; granted: boolean; recorded_at: string | null } | null;
  send_after: string | null;
  created_at: string;
  created_by_name: string;
  approved_at: string | null;
  approved_by_name: string;
  sent_at: string | null;
  sent_by_name: string;
  failed_reason: string;
}
export interface Template {
  id: string;
  /** Set on the templates every clinic starts with: "invoice", "appointment_reminder"... */
  key: string;
  name: string;
  kind: 'care' | 'greetings';
  body: string;
  version: number;
  approved: boolean;
  standard: boolean;
  uses: string[];
  in_rules: boolean;
}
export interface TemplateList {
  fields: { name: string; label: string }[];
  rule: string;
  results: Template[];
}
export interface Rule {
  id: string;
  name: string;
  trigger: 'before_appointment' | 'after_last_visit' | 'birthday';
  days: number;
  only_if_not_booked: boolean;
  template: { id: string; name: string; approved: boolean };
  enabled: boolean;
  needs_approval: boolean;
  words: string;
}
export interface Counts {
  waiting: number;
  replies: number;
  failed: number;
}

export const CONTENT_RULE = 'Messages never contain a diagnosis, symptoms or medicine names.';
export const KIND_LABELS = { care: 'Care message', greetings: 'Greeting or clinic news' } as const;
export const CONSENT_WORDS = { care: 'care messages', greetings: 'greetings and clinic news' } as const;
export const SOURCE_LABELS: Record<Message['source'], string> = {
  rule: 'Rule',
  template: 'Template',
  manual: 'By hand',
  campaign: 'Campaign',
  reply: 'Reply',
};
export const canApproveMessages = (role: Role) => role === 'owner' || role === 'clinician';
export const canSetUpMessages = (role: Role) => role === 'owner' || role === 'admin';

/** The status label of a message, as every list shows it. */
export function statusOfMessage(message: Pick<Message, 'status' | 'blocked'>): [Tone, string] {
  if (message.blocked) return ['red', 'Blocked'];
  return (
    {
      waiting: ['amber', 'Waiting for approval'],
      approved: ['blue', 'Ready to send'],
      sent: ['green', 'Sent by staff'],
      failed: ['red', 'Failed'],
      discarded: ['grey', 'Discarded'],
      received: ['amber', 'Reply'],
      handled: ['grey', 'Reply, handled'],
    } as Record<Message['status'], [Tone, string]>
  )[message.status];
}

const CHANGED = 'jivni:messages-changed';
/** Tells the tab count, and any open list, that messages changed. */
export const messagesChanged = () => window.dispatchEvent(new Event(CHANGED));
export function onMessagesChanged(run: () => void) {
  window.addEventListener(CHANGED, run);
  return () => window.removeEventListener(CHANGED, run);
}

/**
 * Sends a message the only way this version can: the server marks it sent and answers with a WhatsApp
 * link, which opens with the wording ready for a person to press Send. If the browser stops the new
 * window, a notice offers the same link to press by hand.
 */
export async function sendOnWhatsApp(id: string) {
  const sent = await api<Message & { link: string }>(`messages/${id}/send/`, { method: 'POST', body: '{}' });
  const opened = window.open(sent.link, '_blank');
  if (opened) {
    opened.opener = null;
    notify('WhatsApp is opening with the message ready. Press Send there.');
  } else
    notify('The browser stopped WhatsApp from opening.', {
      sticky: true,
      action: { label: 'Open WhatsApp', run: () => window.open(sent.link, '_blank', 'noopener') },
    });
  messagesChanged();
  return sent as Message;
}
