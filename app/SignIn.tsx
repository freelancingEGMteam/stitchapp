"use client";

import { FormEvent, useEffect, useState } from "react";
import { Mail, Scissors } from "lucide-react";
import { supabase } from "@/lib/supabase";

export default function SignIn() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  /**
   * Whether Google is actually switched on in Supabase. Asking up front stops
   * the button sending people to Supabase's raw "provider is not enabled"
   * JSON error page, which reads as the login being broken.
   */
  const [googleReady, setGoogleReady] = useState(false);

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
    if (!url) return;
    void fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } })
      .then((res) => res.json())
      .then((data) => setGoogleReady(data?.external?.google === true))
      .catch(() => setGoogleReady(false));
  }, []);

  const withGoogle = async () => {
    if (!supabase) return;
    setError("");
    setBusy(true);
    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/` },
    });
    if (authError) {
      setError(`Could not start Google sign-in. ${authError.message}`);
      setBusy(false);
    }
    // On success the browser is redirected, so there is nothing to reset.
  };

  const withEmail = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase) return;
    setError("");
    setBusy(true);
    const { error: authError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/` },
    });
    setBusy(false);
    if (authError) {
      setError(`Could not send the sign-in link. ${authError.message}`);
      return;
    }
    setSent(true);
  };

  return <div className="booking-shell">
    <header className="booking-header">
      <div className="booking-header-brand"><Scissors size={20} /></div>
      <h1>Studio sign-in</h1>
      <p className="booking-lede">Only the studio can see bookings and opening hours.</p>
    </header>

    <div className="booking-card auth-card">
      {sent ? <div className="auth-sent">
        <Mail size={34} className="auth-sent-icon" />
        <h2>Check your email</h2>
        <p className="booking-note">We sent a sign-in link to <strong>{email.trim()}</strong>. Open it on this device to finish signing in.</p>
        <button type="button" className="booking-back" onClick={() => { setSent(false); setEmail(""); }}>← Use a different email</button>
      </div> : <>
        {googleReady && <>
          <button type="button" className="auth-provider" onClick={withGoogle} disabled={busy}>
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
              <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z" />
              <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z" />
              <path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z" />
              <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z" />
            </svg>
            Continue with Google
          </button>
          <div className="auth-divider"><span>or</span></div>
        </>}

        <form onSubmit={withEmail}>
          <div className="field">
            <label htmlFor="auth-email">Email</label>
            <input id="auth-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required />
          </div>
          <button type="submit" className="booking-submit" disabled={busy || !email.trim()}>
            {busy ? "Sending…" : "Email me a sign-in link"}
          </button>
        </form>
      </>}

      {error && <div className="booking-alert error" style={{ marginTop: 14 }}>{error}</div>}
    </div>

    <footer className="booking-footer">Booking your own drop-off or pick-up? <a href="/book">Go to the booking page</a>.</footer>
  </div>;
}
