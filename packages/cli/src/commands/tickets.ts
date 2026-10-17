import kleur from "kleur";
import type { Coronium, Ticket, TicketPage, TicketStatus } from "coronium-sdk";
import { makeClient } from "../client.js";
import { isJson, ok, printJson, UsageError, type GlobalOptions } from "../output.js";

export interface TicketListCommandOptions extends GlobalOptions {
  status?: string;
  limit?: string;
}

export interface TicketCreateOptions extends GlobalOptions {
  subject?: string;
  message?: string;
  category?: string;
  proxy?: string[];
}

const STATUSES: readonly string[] = ["open", "pending", "resolved", "closed"];

function parseStatus(raw: string | undefined): TicketStatus | undefined {
  if (raw === undefined) return undefined;
  if (STATUSES.includes(raw)) return raw as TicketStatus;
  throw new UsageError("--status must be open, pending, resolved or closed.");
}

function printTicket(ticket: Ticket): void {
  console.log(`${kleur.bold(ticket.subject)}  ${kleur.dim(ticket._id)}  ${ticket.status}`);
  for (const message of ticket.messages) {
    let author: string = "you";
    if (message.isAdmin) author = message.authorName ?? "support";
    console.log(`  ${kleur.dim(`${author}:`)} ${message.text}`);
  }
}

export async function ticketsListCommand(options: TicketListCommandOptions): Promise<void> {
  const client: Coronium = await makeClient({ requireToken: true });
  let limit: number | undefined;
  if (options.limit !== undefined) limit = Number(options.limit);
  const page: TicketPage = await client.tickets.list({ status: parseStatus(options.status), limit });
  if (isJson(options)) {
    printJson(page);
    return;
  }
  if (page.tickets.length === 0) {
    console.log("No tickets.");
    return;
  }
  for (const ticket of page.tickets) {
    console.log(`${ticket._id}  ${String(ticket.status).padEnd(9)} ${ticket.subject}`);
  }
}

export async function ticketShowCommand(ticketId: string, options: GlobalOptions): Promise<void> {
  const client: Coronium = await makeClient({ requireToken: true });
  const ticket: Ticket = await client.tickets.get(ticketId);
  if (isJson(options)) {
    printJson(ticket);
    return;
  }
  printTicket(ticket);
}

export async function ticketCreateCommand(options: TicketCreateOptions): Promise<void> {
  if (!options.subject || !options.message) {
    throw new UsageError('Both --subject and --message are required, for example: coronium tickets create --subject "Slow proxy" --message "..."');
  }
  const client: Coronium = await makeClient({ requireToken: true });
  const ticket: Ticket = await client.tickets.create({
    subject: options.subject,
    message: options.message,
    category: options.category,
    relatedProxies: options.proxy,
  });
  if (isJson(options)) {
    printJson(ticket);
    return;
  }
  ok(`Ticket ${ticket._id} opened. Support replies by email and in: coronium tickets show ${ticket._id}`);
}

export async function ticketReplyCommand(ticketId: string, message: string, options: GlobalOptions): Promise<void> {
  const client: Coronium = await makeClient({ requireToken: true });
  const ticket: Ticket = await client.tickets.reply(ticketId, message);
  if (isJson(options)) {
    printJson(ticket);
    return;
  }
  ok(`Reply added to ${ticket._id}.`);
}

export async function ticketArchiveCommand(ticketId: string, options: GlobalOptions): Promise<void> {
  const client: Coronium = await makeClient({ requireToken: true });
  await client.tickets.archive(ticketId);
  if (isJson(options)) {
    printJson({ archived: ticketId });
    return;
  }
  ok(`Ticket ${ticketId} hidden from your list (archiving does not close it).`);
}
