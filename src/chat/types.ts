export type AttachmentKind = "image" | "text" | "pdf";

/** What is stored about an attachment. Image bytes are not stored; only a small preview. */
export type Attachment = {
  id: string;
  name: string;
  kind: AttachmentKind;
  /** Extracted text for text files and PDFs (sent to Claude with the message). */
  text?: string;
  /** Small JPEG data URL preview for images. */
  thumb?: string;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachments?: Attachment[];
  createdAt: number;
  error?: string;
};

export type NoteTurn = { role: "user" | "assistant"; text: string; error?: string; attachments?: Attachment[] };

/** A side note: a question about a passage of one message, answered outside the main chat. */
export type Note = {
  id: string;
  messageId: string;
  /** The selected text as it appears in the message's DOM text (used to find it again). */
  quote: string;
  /** The selected text as the user saw it (shown in the note and sent to Claude). */
  label: string;
  /** Which occurrence of `quote` in the message's visible text (0 = first). */
  nth: number;
  /** Where the passage sits in the answer (sent to Claude so it knows exactly what was marked). */
  context?: { excerpt: string; section?: string; formula?: string };
  collapsed: boolean;
  createdAt: number;
  turns: NoteTurn[];
};

export type Chat = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  notes: Note[];
};

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
