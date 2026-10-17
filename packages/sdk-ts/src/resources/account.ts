import { CoroniumError } from "../errors.js";
import { ROUTES } from "../routes.js";
import { objectBody, type Transport } from "../transport.js";
import type { AccountInfo, CryptoBalance, PaymentStatus } from "../types.js";

function assertAccount(body: unknown): AccountInfo {
  const account: AccountInfo = objectBody<AccountInfo>(body, "Account");
  // A missing balance must never be read as zero.
  if (typeof account.accountCredit !== "number" || !Number.isFinite(account.accountCredit)) {
    throw new CoroniumError({ code: "invalid_response", message: "Account response has no numeric accountCredit." });
  }
  return account;
}

function assertBalances(body: unknown): CryptoBalance[] {
  if (!Array.isArray(body)) {
    throw new CoroniumError({ code: "invalid_response", message: "Crypto balance did not return an array." });
  }
  return body as CryptoBalance[];
}

export class AccountResource {
  constructor(private readonly transport: Transport) {}

  /** Account identity plus USD account credit and BTC/USDT balances. */
  async get(): Promise<AccountInfo> {
    const result = await this.transport.call<unknown>(ROUTES.accountGet);
    return assertAccount(result.body);
  }

  /**
   * BTC, USDT (TRC-20) and account-credit balances with deposit addresses.
   *
   * Side effect: the first call creates the account's BTC and USDT deposit
   * wallets. Use `get()` when you only need balances.
   */
  async cryptoBalances(): Promise<CryptoBalance[]> {
    const result = await this.transport.call<unknown>(ROUTES.accountCryptoBalance);
    return assertBalances(result.body);
  }

  /** Status of one payment, for example the `paymentId` of a 202 purchase. */
  async payment(paymentId: string): Promise<PaymentStatus> {
    const result = await this.transport.call<unknown>(ROUTES.paymentStatus, { params: { id: paymentId } });
    return objectBody<PaymentStatus>(result.body, "Payment status");
  }
}
