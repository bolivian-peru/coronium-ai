# React + viem reference — drop-in CoroniumSignup component

Single component, ~200 lines, no extra dependencies beyond `react` and `viem`. Works in Next.js (app or pages router), Vite, CRA, Remix.

## Install

```bash
npm install viem react
# (react is presumably already installed)
```

## The component — `CoroniumSignup.tsx`

```tsx
import { useEffect, useState } from "react";
import {
  generateMnemonic,
  english,
  mnemonicToAccount,
  privateKeyToAccount,
} from "viem/accounts";
import { getAddress, type Address } from "viem";

export interface SignupResult {
  account_id: string;
  api_key: string;
  wallet_address: Address;
  wallet_chain: "evm";
  deposit_addresses: { evm_native: Address; usdc_base: Address };
  balance_usd: number;
  daily_spend_cap_usd: number;
  /** Present when the wallet was generated client-side this session. */
  mnemonic?: string;
}

export interface CoroniumSignupProps {
  /** Defaults to https://api.coronium.ai/v1 */
  apiBase?: string;
  /** Pre-fill the voucher field. */
  voucher?: string;
  /** Hide the voucher input entirely (e.g., when a partner provided it via URL param). */
  hideVoucherInput?: boolean;
  /** Called once on success with the full result, including the mnemonic if generated. */
  onSuccess?: (r: SignupResult) => void;
  /** Class names for the root element, if you want to style it. */
  className?: string;
}

type Step = "voucher" | "picker" | "signing" | "done" | "error";
type WalletSource = "generate" | "metamask";

const DEFAULT_API = "https://api.coronium.ai/v1";

export function CoroniumSignup({
  apiBase = DEFAULT_API,
  voucher: initialVoucher,
  hideVoucherInput,
  onSuccess,
  className,
}: CoroniumSignupProps) {
  const [voucher, setVoucher] = useState(initialVoucher ?? "");
  const [step, setStep] = useState<Step>("voucher");
  const [walletSource, setWalletSource] = useState<WalletSource>("generate");
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [result, setResult] = useState<SignupResult | null>(null);

  // Auto-skip the voucher step if the integrator pre-filled it AND chose to hide the field.
  useEffect(() => {
    if (initialVoucher && hideVoucherInput) setStep("picker");
  }, [initialVoucher, hideVoucherInput]);

  async function redeem() {
    setStep("signing");
    setError(null);

    try {
      let address: Address;
      let signMessage: (message: string) => Promise<`0x${string}`>;
      let mnemonic: string | undefined;

      // ── Wallet ──────────────────────────────────────────────────
      if (walletSource === "generate") {
        const m = generateMnemonic(english);
        const acc = mnemonicToAccount(m);
        address = acc.address;
        mnemonic = m;
        signMessage = (message) => acc.signMessage({ message });
      } else {
        const eth = (window as any).ethereum;
        if (!eth) throw mkErr("NO_INJECTED_WALLET", "No EVM wallet found. Install MetaMask or similar.");
        const accounts: string[] = await eth.request({ method: "eth_requestAccounts" });
        if (!accounts?.[0]) throw mkErr("NO_INJECTED_WALLET", "No accounts returned by the wallet.");
        address = getAddress(accounts[0]);
        signMessage = async (message) =>
          (await eth.request({ method: "personal_sign", params: [message, address] })) as `0x${string}`;
      }

      // ── 1. Challenge ────────────────────────────────────────────
      const cRes = await fetch(`${apiBase}/account/redeem-challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voucher: voucher.trim(), wallet_address: address }),
      });
      if (!cRes.ok) throw await asApiError(cRes);
      const { siwe_message } = (await cRes.json()) as { siwe_message: string };

      // ── 2. Sign ─────────────────────────────────────────────────
      const signature = await signMessage(siwe_message);

      // ── 3. Redeem ───────────────────────────────────────────────
      const rRes = await fetch(`${apiBase}/account/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siwe_message, signature }),
      });
      if (!rRes.ok) throw await asApiError(rRes);
      const data = (await rRes.json()) as Omit<SignupResult, "mnemonic">;

      const full: SignupResult = { ...data, mnemonic };
      setResult(full);
      setStep("done");
      onSuccess?.(full);
    } catch (e: any) {
      setError({
        code: e?.code ?? "UNKNOWN",
        message: e?.message ?? String(e),
      });
      setStep("error");
    }
  }

  // ─── Render ────────────────────────────────────────────────────
  return (
    <div className={className}>
      {step === "voucher" && (
        <form onSubmit={(e) => { e.preventDefault(); if (voucher) setStep("picker"); }}>
          <h2>Sign up to Coronium</h2>
          <p>Paste your voucher to continue.</p>
          <input
            value={voucher}
            onChange={(e) => setVoucher(e.target.value)}
            placeholder="cor_v1_…"
            autoFocus
            required
          />
          <button type="submit" disabled={!voucher.trim()}>Continue</button>
          <p>Don't have a voucher? <a href="https://coronium.ai/free">Get a free one</a>.</p>
        </form>
      )}

      {step === "picker" && (
        <div>
          <h2>Choose how you want your wallet</h2>
          <label>
            <input type="radio" checked={walletSource === "generate"} onChange={() => setWalletSource("generate")} />
            Generate a new EVM wallet (recommended)
          </label>
          <label>
            <input type="radio" checked={walletSource === "metamask"} onChange={() => setWalletSource("metamask")} />
            Use my existing wallet (MetaMask, Rainbow, etc.)
          </label>
          <button onClick={redeem}>Sign in</button>
          <button onClick={() => setStep("voucher")} type="button">Back</button>
        </div>
      )}

      {step === "signing" && <p>Signing… check your wallet for a prompt.</p>}

      {step === "done" && result && <SignupResultView r={result} />}

      {step === "error" && error && (
        <div role="alert">
          <h3>Couldn't sign you up</h3>
          <p><strong>{error.code}</strong>: {error.message}</p>
          <button onClick={() => setStep("voucher")}>Try again</button>
        </div>
      )}
    </div>
  );
}

function SignupResultView({ r }: { r: SignupResult }) {
  return (
    <div>
      <h2>You're in.</h2>
      <p>Account: <code>{r.account_id}</code></p>
      <p>Wallet: <code>{r.wallet_address}</code></p>

      <h3>API key (shown once)</h3>
      <p>Save this — you can't retrieve it later. Lost? Sign a "rotate" challenge with your wallet to get a new one.</p>
      <CopyField value={r.api_key} />

      {r.mnemonic && (
        <>
          <h3>Recovery phrase (shown once)</h3>
          <p>Save these 24 words. They are your account. Coronium cannot recover them.</p>
          <pre>{r.mnemonic}</pre>
          <button
            onClick={() => downloadJson("coronium-wallet.json", { address: r.wallet_address, mnemonic: r.mnemonic })}
          >
            Download wallet.json
          </button>
        </>
      )}

      <p>
        Trial credit: <strong>${r.balance_usd.toFixed(2)}</strong>. Daily spend cap:{" "}
        <strong>${r.daily_spend_cap_usd.toFixed(2)}</strong>. Send USDC on Base / Arbitrum /
        Optimism to your wallet to top up.
      </p>
    </div>
  );
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <code style={{ wordBreak: "break-all" }}>{value}</code>
      <button
        onClick={async () => { await navigator.clipboard.writeText(value); setCopied(true); }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function mkErr(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

async function asApiError(res: Response): Promise<Error & { code: string; status: number }> {
  let body: any;
  try { body = await res.json(); } catch { body = undefined; }
  const code = body?.code ?? `HTTP_${res.status}`;
  const message = body?.message ?? `${res.status} ${res.statusText}`;
  return Object.assign(new Error(message), { code, status: res.status });
}
```

## Usage

```tsx
import { CoroniumSignup } from "./CoroniumSignup";

export default function SignupPage() {
  return (
    <main>
      <CoroniumSignup
        onSuccess={(r) => {
          // Persist however you'd like — typically into the user's session.
          // DO NOT store the api_key in plain localStorage if your site has any
          // third-party scripts. See ../security.md.
          console.log("Account created:", r.account_id);
        }}
      />
    </main>
  );
}
```

## Customizing

- **Pre-fill voucher from a URL param** for partner / affiliate sites:
  ```tsx
  const params = new URLSearchParams(window.location.search);
  return <CoroniumSignup voucher={params.get("ref") ?? undefined} hideVoucherInput />;
  ```
- **Custom styling** — pass `className` and style with your CSS / Tailwind / shadcn etc. The component renders standard semantic HTML.
- **i18n** — fork the strings; nothing fancy needed.

## Edge cases worth handling in your UI

- User refreshes the page mid-signing — the `nonce` is single-use and 5-min TTL. The component above doesn't persist it (which is correct — restart from `voucher`).
- User signs but the network call fails — same as above, the nonce is wasted. Show a clear "try again" path.
- User pastes a checksum-broken address (e.g., from a buggy wallet) — viem's `getAddress` will throw. Catch and show an `INVALID_REQUEST`-style error.
- MetaMask not installed — `walletSource === "metamask"` shows `NO_INJECTED_WALLET`. Suggest fallback to "generate" mode.
- User on a hardware-wallet-only machine — MetaMask flow works fine; just slower because the user has to confirm on the device.
