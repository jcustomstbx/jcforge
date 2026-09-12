import { useState, type FormEvent } from "react";
import "./LicenseLock.css";

interface LicenseLockProps {
  onActivate: (key: string) => Promise<boolean>;
}

export function LicenseLock({ onActivate }: LicenseLockProps) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    setChecking(true);
    setError(null);
    const ok = await onActivate(draft);
    setChecking(false);
    if (!ok) setError("That key isn't valid. Check it and try again.");
  };

  return (
    <div className="license-lock">
      <div className="license-lock__card">
        <h1 className="license-lock__title">Your trial has ended</h1>
        <p className="license-lock__subtitle">
          JCForge's 24-hour trial is over. Enter your license key to keep
          using it.
        </p>
        <form className="license-lock__form" onSubmit={submit}>
          <input
            className="license-lock__input"
            placeholder="license key"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
          <button
            type="submit"
            className="license-lock__submit"
            disabled={checking}
          >
            {checking ? "Checking…" : "Activate"}
          </button>
        </form>
        {error && <div className="license-lock__error">{error}</div>}
      </div>
    </div>
  );
}
