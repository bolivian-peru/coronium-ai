import kleur from "kleur";
import type { AccountInfo, Coronium, CryptoBalance, PaymentStatus } from "coronium-sdk";
import { makeClient } from "../client.js";
import { field, isJson, printJson, usd, type GlobalOptions } from "../output.js";

export interface BalanceOptions extends GlobalOptions {
  crypto?: boolean;
}

function printCryptoBalances(balances: CryptoBalance[]): void {
  console.log("");
  console.log(kleur.bold("Deposit wallets"));
  for (const row of balances) {
    let label: string = row.coin.toUpperCase();
    if (row.coin === "usdt") label = "USDT (TRC-20)";
    if (row.coin === "account_credit") label = "account credit";
    field(label, `${row.balance}${row.address ? `  ${row.address}` : ""}`);
  }
}

export async function balanceCommand(options: BalanceOptions): Promise<void> {
  const client: Coronium = await makeClient({ requireToken: true });
  const account: AccountInfo = await client.account.get();
  // The crypto endpoint creates deposit wallets on first use, so it runs only on request.
  let balances: CryptoBalance[] | null = null;
  if (options.crypto) balances = await client.account.cryptoBalances();
  if (isJson(options)) {
    printJson({ account, crypto_balances: balances });
    return;
  }
  console.log(kleur.bold(`Account ${account.login ?? account.name ?? account._id}`));
  field("account credit", usd(account.accountCredit));
  field("BTC", account.btc?.balance ?? "unknown");
  field("USDT", account.usdt?.balance ?? "unknown");
  if (account.proxyCount !== undefined) field("proxies (all time)", account.proxyCount);
  if (balances) printCryptoBalances(balances);
}

export async function paymentCommand(paymentId: string, options: GlobalOptions): Promise<void> {
  const client: Coronium = await makeClient({ requireToken: true });
  const payment: PaymentStatus = await client.account.payment(paymentId);
  if (isJson(options)) {
    printJson(payment);
    return;
  }
  console.log(kleur.bold(`Payment ${payment._id}`));
  field("status", payment.status);
  field("confirmed", payment.isConfirmed ?? "unknown");
  if (payment.lastError) field("last error", payment.lastError);
  field("proxies", payment.modems?.length ?? 0);
}
