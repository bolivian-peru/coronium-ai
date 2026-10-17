import { CoroniumError } from "../errors.js";
import { ROUTES } from "../routes.js";
import { isObject, objectBody, type Transport } from "../transport.js";
import type { CreateTicketInput, Ticket, TicketPage, TicketStatus } from "../types.js";

export interface TicketListOptions {
  status?: TicketStatus;
  /** 1 to 100, default 50. */
  limit?: number;
  offset?: number;
}

// Staff-only fields that older API releases include in ticket responses.
// They are removed here so they never reach an end user or an agent transcript.
const STAFF_ONLY_FIELDS: readonly string[] = ["internalNotes", "escalationReason", "escalated", "escalatedAt", "_ownerId"];
const MAX_LIMIT: number = 100;
const MAX_SUBJECT_LENGTH: number = 200;

export function toCustomerTicket(ticket: Record<string, unknown>): Ticket {
  const view: Record<string, unknown> = { ...ticket };
  for (const key of STAFF_ONLY_FIELDS) delete view[key];
  return view as Ticket;
}

function ticketFrom(body: unknown): Ticket {
  const wrapper: Record<string, unknown> = objectBody<Record<string, unknown>>(body, "Ticket");
  if (!isObject(wrapper.data)) {
    throw new CoroniumError({ code: "invalid_response", message: "Ticket response has no data object." });
  }
  return toCustomerTicket(wrapper.data);
}

function clampLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_LIMIT);
}

function pageFrom(body: unknown): TicketPage {
  const wrapper: Record<string, unknown> = objectBody<Record<string, unknown>>(body, "Tickets");
  const data: Record<string, unknown> = isObject(wrapper.data) ? wrapper.data : {};
  if (!Array.isArray(data.tickets)) {
    throw new CoroniumError({ code: "invalid_response", message: "Ticket list has no tickets array." });
  }
  const tickets: Ticket[] = data.tickets.map((row: unknown): Ticket => toCustomerTicket(isObject(row) ? row : {}));
  return {
    tickets,
    total: Number(data.total ?? tickets.length),
    limit: Number(data.limit ?? tickets.length),
    offset: Number(data.offset ?? 0),
  };
}

function assertText(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CoroniumError({ code: "invalid_argument", message: `${label} must not be empty.` });
  }
}

export class TicketsResource {
  constructor(private readonly transport: Transport) {}

  async list(options: TicketListOptions = {}): Promise<TicketPage> {
    const result = await this.transport.call<unknown>(ROUTES.ticketsList, {
      query: { status: options.status, limit: clampLimit(options.limit), offset: options.offset },
    });
    return pageFrom(result.body);
  }

  async get(ticketId: string): Promise<Ticket> {
    const result = await this.transport.call<unknown>(ROUTES.ticketsGet, { params: { id: ticketId } });
    return ticketFrom(result.body);
  }

  /** Open a ticket. The API allows about 1 new ticket or reply per minute and 5 per hour. */
  async create(input: CreateTicketInput): Promise<Ticket> {
    assertText(input.subject, "Subject");
    assertText(input.message, "Message");
    if (input.subject.length > MAX_SUBJECT_LENGTH) {
      throw new CoroniumError({ code: "invalid_argument", message: `Subject must be at most ${MAX_SUBJECT_LENGTH} characters.` });
    }
    const body: Record<string, unknown> = { subject: input.subject, message: input.message };
    if (input.category) body.category = input.category;
    if (input.relatedProxies && input.relatedProxies.length > 0) body.relatedProxies = input.relatedProxies;
    const result = await this.transport.call<unknown>(ROUTES.ticketsCreate, { body });
    return ticketFrom(result.body);
  }

  async reply(ticketId: string, message: string): Promise<Ticket> {
    assertText(message, "Message");
    const result = await this.transport.call<unknown>(ROUTES.ticketsReply, { params: { id: ticketId }, body: { message } });
    return ticketFrom(result.body);
  }

  /** Hide a ticket from your list. It does not close the ticket. */
  async archive(ticketId: string): Promise<void> {
    await this.transport.call<unknown>(ROUTES.ticketsArchive, { params: { id: ticketId } });
  }
}
